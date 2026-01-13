(() => {
  if (globalThis.NotesService) return;

  const { NotesConstants, NotesIdb, NotesOrderKey, NotesChunks } = globalThis;
  if (!NotesConstants || !NotesIdb || !NotesOrderKey || !NotesChunks) {
    console.error('[NotesService] Missing dependencies');
    return;
  }

  const { STORES, DEFAULT_TAB_NAME, COMMANDS, EVENTS } = NotesConstants;
  const { runTransaction, requestToPromise } = NotesIdb;
  const { generateKeyAfter, generateKeyBefore, generateKeyBetween, allocateBetween } = NotesOrderKey;
  const { splitText, joinChunks, buildPreview, buildTitle, CHUNK_SIZE } = NotesChunks;

  const generateId = () => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `notes_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  };

  const normalizeKeyPart = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value === '' ? null : value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    return null;
  };

  const broadcastEvent = (payload) => {
    try {
      chrome.runtime.sendMessage(payload);
    } catch (error) {
      console.warn('[NotesService] broadcast failed', error);
    }
  };

  const getMeta = (stores, key) => requestToPromise(stores[STORES.META].get(key));

  const setMeta = (stores, key, value) =>
    requestToPromise(stores[STORES.META].put({ key, value }));

  const ensureDeviceId = async (stores) => {
    const existing = await getMeta(stores, 'deviceId');
    if (existing?.value) return existing.value;
    const deviceId = generateId();
    await setMeta(stores, 'deviceId', deviceId);
    return deviceId;
  };

  const ensureDefaultTab = async (stores) => {
    const tabsStore = stores[STORES.TABS];
    const allTabs = await requestToPromise(tabsStore.getAll());
    if (allTabs && allTabs.length) {
      return allTabs.sort((a, b) => a.createdAt - b.createdAt)[0];
    }

    const now = Date.now();
    const tab = {
      tabId: generateId(),
      name: DEFAULT_TAB_NAME,
      createdAt: now,
      updatedAt: now,
      rev: 0,
      uiPrefs: {}
    };
    await requestToPromise(tabsStore.put(tab));
    return tab;
  };

  const nextOplogSeq = async (stores) => {
    const entry = await getMeta(stores, 'oplogSeq');
    const next = (entry?.value || 0) + 1;
    await setMeta(stores, 'oplogSeq', next);
    return next;
  };

  const bumpTabRevision = async (stores, tabId) => {
    const tabsStore = stores[STORES.TABS];
    const tab = await requestToPromise(tabsStore.get(tabId));
    if (!tab) return null;
    tab.rev = (tab.rev || 0) + 1;
    tab.updatedAt = Date.now();
    await requestToPromise(tabsStore.put(tab));
    return tab.rev;
  };

  const loadChunksByNote = async (chunksStore, noteId) => {
    const index = chunksStore.index('by_note');
    return requestToPromise(index.getAll(IDBKeyRange.only(noteId)));
  };

  const replaceChunks = async (chunksStore, noteId, chunks) => {
    const existing = await loadChunksByNote(chunksStore, noteId);
    for (const chunk of existing) {
      await requestToPromise(chunksStore.delete([chunk.noteId, chunk.idx]));
    }
    for (const chunk of chunks) {
      await requestToPromise(
        chunksStore.put({
          noteId,
          idx: chunk.idx,
          data: chunk.data
        })
      );
    }
  };

  const listChildrenFallback = async (nodesStore, tabId, parentId) => {
    const fallbackIndex = nodesStore.index('by_tab_created');
    const fallbackRange = IDBKeyRange.bound(
      [tabId, 0],
      [tabId, Number.MAX_SAFE_INTEGER]
    );
    const notes = await requestToPromise(fallbackIndex.getAll(fallbackRange));
    const expectedParent = parentId ?? null;
    return notes
      .filter((note) => normalizeKeyPart(note?.parentId) === expectedParent)
      .sort((a, b) => String(a.orderKey || '').localeCompare(String(b.orderKey || '')));
  };

  const listChildren = async (nodesStore, tabId, parentId) => {
    const safeTabId = normalizeKeyPart(tabId);
    if (safeTabId === null) {
      throw new Error('Invalid tabId for listChildren');
    }
    const safeParentId = normalizeKeyPart(parentId);
    if (safeParentId === null) {
      return listChildrenFallback(nodesStore, safeTabId, safeParentId);
    }
    const index = nodesStore.index('by_parent');
    try {
      const range = IDBKeyRange.bound(
        [safeTabId, safeParentId, ''],
        [safeTabId, safeParentId, '\uffff']
      );
      return await requestToPromise(index.getAll(range));
    } catch (error) {
      const message = String(error?.message || '');
      const isInvalidKey = error?.name === 'DataError' || /valid key/i.test(message);
      if (!isInvalidKey) throw error;
      return listChildrenFallback(nodesStore, safeTabId, safeParentId);
    }
  };

  const createNoteRecord = ({
    tabId,
    parentId,
    orderKey,
    kind,
    title,
    preview,
    source,
    tags,
    flags
  }) => {
    const now = Date.now();
    return {
      id: generateId(),
      tabId,
      parentId: parentId ?? null,
      orderKey,
      kind: kind || 'custom',
      title: title || 'Untitled',
      preview: preview || '',
      source: source || { origin: 'unknown' },
      tags: Array.isArray(tags) ? tags : [],
      flags: flags || {},
      createdAt: now,
      updatedAt: now,
      rev: 1
    };
  };

  const createNote = async (stores, payload) => {
    const deviceId = await ensureDeviceId(stores);
    const tabsStore = stores[STORES.TABS];
    const nodesStore = stores[STORES.NODES];
    const nextFlags = payload.flags ? { ...payload.flags } : {};
    if (typeof payload.html === 'string') {
      nextFlags.html = payload.html;
    }
    let tab = null;
    const requestedTabId = normalizeKeyPart(payload.tabId);
    const parentId = normalizeKeyPart(payload.parentId);
    if (requestedTabId !== null) {
      tab = await requestToPromise(tabsStore.get(requestedTabId));
    }
    if (parentId !== null) {
      const parent = await requestToPromise(nodesStore.get(parentId));
      if (parent?.tabId) {
        const parentTab = await requestToPromise(tabsStore.get(parent.tabId));
        if (parentTab) {
          tab = parentTab;
        }
      }
    }
    if (!tab) {
      tab = await ensureDefaultTab(stores);
    }

    const children = await listChildren(nodesStore, tab.tabId, parentId);
    const lastChild = children.sort((a, b) => a.orderKey.localeCompare(b.orderKey)).slice(-1)[0];
    let orderKey = generateKeyAfter(lastChild?.orderKey);

    if (!orderKey) {
      const keys = allocateBetween(null, null, children.length + 1);
      if (!keys) throw new Error('Unable to allocate order keys');
      const sorted = children.sort((a, b) => a.orderKey.localeCompare(b.orderKey));
      for (let i = 0; i < sorted.length; i += 1) {
        sorted[i].orderKey = keys[i];
        await requestToPromise(stores[STORES.NODES].put(sorted[i]));
      }
      orderKey = keys[keys.length - 1];
    }

    const text = payload.text || '';
    const note = createNoteRecord({
      tabId: tab.tabId,
      parentId,
      orderKey,
      kind: payload.kind,
      title: payload.title || buildTitle(text),
      preview: buildPreview(text),
      source: payload.source,
      tags: payload.tags,
      flags: nextFlags
    });

    const chunks = splitText(text);

    await requestToPromise(stores[STORES.NODES].put(note));
    for (const chunk of chunks) {
      await requestToPromise(
        stores[STORES.CHUNKS].put({
          noteId: note.id,
          idx: chunk.idx,
          data: chunk.data
        })
      );
    }

    const seq = await nextOplogSeq(stores);
    await requestToPromise(
      stores[STORES.OPLOG].put({
        seq,
        opId: generateId(),
        deviceId,
        ts: Date.now(),
        type: COMMANDS.NOTE_CREATE,
        payload: {
          note: note,
          content: {
            format: 'plain',
            chunks,
            chunkSize: CHUNK_SIZE
          }
        },
        state: 'pendingIndex'
      })
    );

    const rev = await bumpTabRevision(stores, tab.tabId);
    broadcastEvent({
      type: 'NOTES_EVENT',
      event: EVENTS.REVISION_BUMP,
      tabId: tab.tabId,
      rev
    });

    return { noteId: note.id, tabId: tab.tabId, orderKey: note.orderKey };
  };

  const isDescendant = async (stores, tabId, rootId, candidateId) => {
    if (!candidateId) return false;
    if (rootId === candidateId) return true;
    const queue = [rootId];
    const nodesStore = stores[STORES.NODES];
    while (queue.length) {
      const currentId = queue.shift();
      const children = await listChildren(nodesStore, tabId, currentId);
      for (const child of children) {
        if (child.id === candidateId) return true;
        queue.push(child.id);
      }
    }
    return false;
  };

  const computeOrderKeyForMove = async (stores, tabId, parentId, beforeId, afterId, movingId) => {
    const nodesStore = stores[STORES.NODES];
    let siblings = await listChildren(nodesStore, tabId, parentId);
    siblings = siblings.filter((node) => node.id !== movingId);
    const sorted = siblings.slice().sort((a, b) => String(a.orderKey || '').localeCompare(String(b.orderKey || '')));

    const indexById = new Map(sorted.map((node, index) => [node.id, index]));
    let insertIndex = sorted.length;
    if (beforeId && indexById.has(beforeId)) {
      insertIndex = indexById.get(beforeId);
    } else if (afterId && indexById.has(afterId)) {
      insertIndex = indexById.get(afterId) + 1;
    }

    const left = insertIndex > 0 ? sorted[insertIndex - 1] : null;
    const right = insertIndex < sorted.length ? sorted[insertIndex] : null;
    const leftKey = left?.orderKey || null;
    const rightKey = right?.orderKey || null;

    let nextKey = null;
    if (leftKey && rightKey) {
      nextKey = generateKeyBetween(leftKey, rightKey);
    } else if (leftKey) {
      nextKey = generateKeyAfter(leftKey);
    } else if (rightKey) {
      nextKey = generateKeyBefore(rightKey);
    } else {
      nextKey = generateKeyAfter(null);
    }

    if (nextKey) {
      return { orderKey: nextKey, rebalanced: false };
    }

    const keys = allocateBetween(null, null, sorted.length + 1);
    if (!keys) throw new Error('Unable to allocate order keys');
    const updated = [];
    sorted.forEach((node, idx) => {
      const targetIdx = idx < insertIndex ? idx : idx + 1;
      node.orderKey = keys[targetIdx];
      updated.push(node);
    });
    for (const node of updated) {
      await requestToPromise(nodesStore.put(node));
    }
    return { orderKey: keys[insertIndex], rebalanced: true };
  };

  const moveNote = async (stores, payload) => {
    const deviceId = await ensureDeviceId(stores);
    const nodesStore = stores[STORES.NODES];
    const note = await requestToPromise(nodesStore.get(payload.noteId));
    if (!note) throw new Error('Note not found');

    const targetParentId = payload.targetParentId || null;
    if (targetParentId === note.id) {
      throw new Error('Cannot move note into itself');
    }

    if (targetParentId) {
      const targetParent = await requestToPromise(nodesStore.get(targetParentId));
      if (!targetParent) throw new Error('Target parent not found');
      if (targetParent.tabId !== note.tabId) {
        throw new Error('Cross-tab move not supported');
      }
      const descendant = await isDescendant(stores, note.tabId, note.id, targetParentId);
      if (descendant) throw new Error('Cannot move note into its descendant');
    }

    const { orderKey } = await computeOrderKeyForMove(
      stores,
      note.tabId,
      targetParentId,
      payload.beforeId || null,
      payload.afterId || null,
      note.id
    );

    const prevParentId = note.parentId || null;
    const prevOrderKey = note.orderKey;
    note.parentId = targetParentId;
    note.orderKey = orderKey;
    note.updatedAt = Date.now();
    note.rev = (note.rev || 0) + 1;
    await requestToPromise(nodesStore.put(note));

    const seq = await nextOplogSeq(stores);
    await requestToPromise(
      stores[STORES.OPLOG].put({
        seq,
        opId: generateId(),
        deviceId,
        ts: Date.now(),
        type: COMMANDS.NOTE_MOVE,
        payload: {
          noteId: note.id,
          prevParentId,
          nextParentId: targetParentId,
          prevOrderKey,
          nextOrderKey: orderKey
        },
        state: 'pendingIndex'
      })
    );

    const rev = await bumpTabRevision(stores, note.tabId);
    broadcastEvent({
      type: 'NOTES_EVENT',
      event: EVENTS.REVISION_BUMP,
      tabId: note.tabId,
      rev
    });

    return { noteId: note.id, tabId: note.tabId, parentId: note.parentId, orderKey };
  };

  const updateNoteText = async (stores, payload) => {
    const deviceId = await ensureDeviceId(stores);
    const note = await requestToPromise(stores[STORES.NODES].get(payload.noteId));
    if (!note) throw new Error('Note not found');

    const text = payload.text || '';
    const nextFlags = note.flags ? { ...note.flags } : {};
    if (typeof payload.html === 'string') {
      nextFlags.html = payload.html;
    } else if (payload.clearHtml) {
      delete nextFlags.html;
    }
    note.flags = nextFlags;
    note.rev = (note.rev || 0) + 1;
    note.updatedAt = Date.now();
    note.title = buildTitle(text, note.title);
    note.preview = buildPreview(text);

    await requestToPromise(stores[STORES.NODES].put(note));
    await replaceChunks(stores[STORES.CHUNKS], note.id, splitText(text));

    const seq = await nextOplogSeq(stores);
    await requestToPromise(
      stores[STORES.OPLOG].put({
        seq,
        opId: generateId(),
        deviceId,
        ts: Date.now(),
        type: COMMANDS.NOTE_UPDATE_TEXT,
        payload: {
          noteId: note.id,
          prevRev: (note.rev || 1) - 1,
          nextRev: note.rev,
          content: {
            format: 'plain',
            chunks: splitText(text),
            chunkSize: CHUNK_SIZE
          },
          title: note.title,
          preview: note.preview,
          updatedAt: note.updatedAt
        },
        state: 'pendingIndex'
      })
    );

    const rev = await bumpTabRevision(stores, note.tabId);
    broadcastEvent({
      type: 'NOTES_EVENT',
      event: EVENTS.REVISION_BUMP,
      tabId: note.tabId,
      rev
    });

    return { noteId: note.id, tabId: note.tabId };
  };

  const getNote = async (stores, payload) => {
    const note = await requestToPromise(stores[STORES.NODES].get(payload.noteId));
    if (!note) return null;
    const chunks = await loadChunksByNote(stores[STORES.CHUNKS], note.id);
    const text = joinChunks(chunks);
    const html = note?.flags?.html || '';
    return { note, text, html };
  };

  const listTabs = async (stores) => {
    const tabs = await requestToPromise(stores[STORES.TABS].getAll());
    return tabs.sort((a, b) => a.createdAt - b.createdAt);
  };

  const renameTab = async (stores, payload) => {
    const tab = await requestToPromise(stores[STORES.TABS].get(payload.tabId));
    if (!tab) throw new Error('Tab not found');
    tab.name = payload.name || tab.name;
    tab.updatedAt = Date.now();
    await requestToPromise(stores[STORES.TABS].put(tab));
    return tab;
  };

  const deleteTab = async (stores, payload) => {
    const tabId = normalizeKeyPart(payload?.tabId);
    if (!tabId) throw new Error('Missing tabId');
    const tabsStore = stores[STORES.TABS];
    const tab = await requestToPromise(tabsStore.get(tabId));
    if (!tab) throw new Error('Tab not found');

    const allTabs = await requestToPromise(tabsStore.getAll());
    if (allTabs.length <= 1) {
      throw new Error('Cannot delete last tab');
    }

    const nodesStore = stores[STORES.NODES];
    const chunksStore = stores[STORES.CHUNKS];
    const index = nodesStore.index('by_tab_created');
    const range = IDBKeyRange.bound([tabId, 0], [tabId, Number.MAX_SAFE_INTEGER]);
    const notes = await requestToPromise(index.getAll(range));

    for (const note of notes) {
      const chunks = await loadChunksByNote(chunksStore, note.id);
      for (const chunk of chunks) {
        await requestToPromise(chunksStore.delete([chunk.noteId, chunk.idx]));
      }
      await requestToPromise(nodesStore.delete(note.id));
    }

    await requestToPromise(tabsStore.delete(tabId));
    return { deleted: true, tabId };
  };

  const deleteNoteCascade = async (stores, noteId) => {
    const nodesStore = stores[STORES.NODES];
    const chunksStore = stores[STORES.CHUNKS];
    const queue = [noteId];
    while (queue.length) {
      const currentId = queue.shift();
      const node = await requestToPromise(nodesStore.get(currentId));
      if (!node) continue;
      const children = await listChildren(nodesStore, node.tabId, node.id);
      children.forEach((child) => queue.push(child.id));
      const chunks = await loadChunksByNote(chunksStore, node.id);
      for (const chunk of chunks) {
        await requestToPromise(chunksStore.delete([chunk.noteId, chunk.idx]));
      }
      await requestToPromise(nodesStore.delete(node.id));
    }
  };

  const getOrCreateScratch = async (stores, payload = {}) => {
    const tab = await ensureDefaultTab(stores);
    const nodesStore = stores[STORES.NODES];
    const index = nodesStore.index('by_tab_kind');
    const range = IDBKeyRange.only([tab.tabId, 'scratch']);
    const scratchNotes = await requestToPromise(index.getAll(range));
    const origin = payload.origin || 'comparator';
    const key = payload.key || 'scratch';
    const existing = scratchNotes.find(
      (note) => note.source?.origin === origin && note.source?.key === key
    );
    if (existing) {
      const chunks = await loadChunksByNote(stores[STORES.CHUNKS], existing.id);
      return { noteId: existing.id, tabId: tab.tabId, text: joinChunks(chunks) };
    }
    const created = await createNote(stores, {
      tabId: tab.tabId,
      parentId: null,
      kind: 'scratch',
      title: payload.title || 'Comparator Draft',
      text: '',
      source: { origin, key, ...(payload.source || {}) }
    });
    return { noteId: created.noteId, tabId: tab.tabId, text: '' };
  };

  const handleCommand = async (message) => {
    const command = message.command;
    const payload = message.payload || {};
    const storesNeeded = [
      STORES.META,
      STORES.TABS,
      STORES.NODES,
      STORES.CHUNKS,
      STORES.OPLOG
    ];

    return runTransaction(storesNeeded, 'readwrite', async (stores) => {
      switch (command) {
        case COMMANDS.INIT: {
          const deviceId = await ensureDeviceId(stores);
          const tab = await ensureDefaultTab(stores);
          return { deviceId, defaultTabId: tab.tabId };
        }
        case COMMANDS.TAB_LIST:
          return { tabs: await listTabs(stores) };
        case COMMANDS.TAB_CREATE: {
          const now = Date.now();
          const tab = {
            tabId: generateId(),
            name: payload.name || DEFAULT_TAB_NAME,
            createdAt: now,
            updatedAt: now,
            rev: 0,
            uiPrefs: {}
          };
          await requestToPromise(stores[STORES.TABS].put(tab));
          return { tab };
        }
        case COMMANDS.TAB_RENAME: {
          const tab = await renameTab(stores, payload);
          return { tab };
        }
        case COMMANDS.TAB_DELETE:
          return await deleteTab(stores, payload);
        case COMMANDS.NOTE_CREATE:
          return await createNote(stores, payload);
        case COMMANDS.NOTE_UPDATE_TEXT:
          return await updateNoteText(stores, payload);
        case COMMANDS.NOTE_MOVE:
          return await moveNote(stores, payload);
        case COMMANDS.NOTE_GET:
          return await getNote(stores, payload);
        case COMMANDS.NOTE_LIST_CHILDREN:
          return {
            notes: await listChildren(stores[STORES.NODES], payload.tabId, payload.parentId)
          };
        case COMMANDS.NOTE_DELETE: {
          await deleteNoteCascade(stores, payload.noteId);
          return { deleted: true };
        }
        case COMMANDS.NOTE_GET_OR_CREATE_SCRATCH:
          return await getOrCreateScratch(stores, payload);
        default:
          throw new Error(`Unknown command: ${command}`);
      }
    });
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'NOTES_CMD') return;
    handleCommand(message)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        console.error('[NotesService] command failed', error);
        sendResponse({ ok: false, error: error?.message || 'Notes command failed' });
      });
    return true;
  });

  globalThis.NotesService = {
    handleCommand
  };
})();
