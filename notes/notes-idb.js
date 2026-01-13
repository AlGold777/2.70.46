(() => {
  if (globalThis.NotesIdb) return;

  const {
    NOTES_DB_NAME,
    NOTES_DB_VERSION,
    STORES
  } = globalThis.NotesConstants || {};

  if (!NOTES_DB_NAME) {
    console.error('[NotesIdb] NotesConstants missing');
    return;
  }

  const requestToPromise = (request) =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IDB request failed'));
    });

  const openNotesDb = () =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(NOTES_DB_NAME, NOTES_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(STORES.META)) {
          db.createObjectStore(STORES.META, { keyPath: 'key' });
        }

        if (!db.objectStoreNames.contains(STORES.TABS)) {
          db.createObjectStore(STORES.TABS, { keyPath: 'tabId' });
        }

        if (!db.objectStoreNames.contains(STORES.NODES)) {
          const store = db.createObjectStore(STORES.NODES, { keyPath: 'id' });
          store.createIndex('by_parent', ['tabId', 'parentId', 'orderKey'], { unique: false });
          store.createIndex('by_tab_created', ['tabId', 'createdAt'], { unique: false });
          store.createIndex('by_tab_kind', ['tabId', 'kind'], { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.CHUNKS)) {
          const store = db.createObjectStore(STORES.CHUNKS, { keyPath: ['noteId', 'idx'] });
          store.createIndex('by_note', 'noteId', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.OPLOG)) {
          const store = db.createObjectStore(STORES.OPLOG, { keyPath: 'seq' });
          store.createIndex('by_state', ['state', 'seq'], { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.TASKS)) {
          db.createObjectStore(STORES.TASKS, { keyPath: 'taskId' });
        }

        if (!db.objectStoreNames.contains(STORES.BACKUP_STATE)) {
          db.createObjectStore(STORES.BACKUP_STATE, { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains(STORES.SEARCH_INDEX)) {
          db.createObjectStore(STORES.SEARCH_INDEX, { keyPath: 'key' });
        }

        if (!db.objectStoreNames.contains(STORES.NOTE_TOKENS)) {
          db.createObjectStore(STORES.NOTE_TOKENS, { keyPath: 'noteId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Failed to open Notes DB'));
    });

  const runTransaction = async (storeNames, mode, handler) => {
    const db = await openNotesDb();
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode);
      const stores = {};
      names.forEach((name) => {
        stores[name] = tx.objectStore(name);
      });

      let result;
      Promise.resolve()
        .then(() => handler(stores, tx))
        .then((value) => {
          result = value;
        })
        .catch((error) => {
          try {
            tx.abort();
          } catch (_) {}
          reject(error);
        });

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('Notes transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('Notes transaction aborted'));
    });
  };

  globalThis.NotesIdb = {
    openNotesDb,
    runTransaction,
    requestToPromise
  };
})();
