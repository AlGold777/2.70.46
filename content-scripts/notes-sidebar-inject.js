(() => {
  if (globalThis.__codexNotesSidebarInjected) return;
  if (globalThis.top && globalThis.top !== globalThis) return;
  if (!globalThis.document?.documentElement) return;
  globalThis.__codexNotesSidebarInjected = true;

  const COMMANDS = {
    INIT: 'NOTES_INIT',
    NOTE_CREATE: 'NOTE_CREATE',
    NOTE_GET: 'NOTE_GET',
    NOTE_UPDATE_TEXT: 'NOTE_UPDATE_TEXT',
    NOTE_GET_OR_CREATE_SCRATCH: 'NOTE_GET_OR_CREATE_SCRATCH'
  };
  const EVENTS = {
    REVISION_BUMP: 'REVISION_BUMP'
  };
  const DRAG_MIME = 'application/x-codex-note';

  const sendCommand = (command, payload = {}) =>
    new Promise((resolve, reject) => {
      if (!globalThis.chrome?.runtime?.sendMessage) {
        reject(new Error('chrome.runtime unavailable'));
        return;
      }
      chrome.runtime.sendMessage({ type: 'NOTES_CMD', command, payload }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || 'Notes command failed'));
          return;
        }
        if (!response) {
          reject(new Error('Notes response missing'));
          return;
        }
        if (!response.ok) {
          reject(new Error(response.error || 'Notes command error'));
          return;
        }
        resolve(response.result);
      });
    });

  const state = {
    open: false,
    noteId: null,
    tabId: null,
    savedNoteId: null,
    lastSavedText: '',
    pendingSave: false,
    refreshInFlight: false,
    saveTimer: null,
    hasUserInput: false,
    resetScratchOnLoad: true,
    scratchLoaded: false,
    scratchLoading: false,
    statusTimer: null,
    pickerActive: false,
    expanded: false,
    activeTab: 'notes',
    selectors: {
      initialized: false,
      platform: null,
      modelName: null,
      entries: new Map(),
      statusTimer: null,
      record: {
        key: null,
        timer: null,
        clickHandler: null,
        keyHandler: null
      }
    }
  };

  const host = document.createElement('div');
  host.id = 'codex-notes-sidebar-host';
  host.style.position = 'fixed';
  host.style.top = '0';
  host.style.left = '0';
  host.style.height = '100%';
  host.style.zIndex = '2147483647';
  host.style.pointerEvents = 'none';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; }
      .notes-shell {
        position: fixed;
        inset: 0 auto 0 0;
        pointer-events: none;
        display: flex;
        align-items: stretch;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
        color: #0f172a;
      }
      .notes-toggle {
        pointer-events: auto;
        position: fixed;
        top: 140px;
        left: 0;
        padding: 10px 8px;
        background: #111827;
        color: #f8fafc;
        border: none;
        border-radius: 0 10px 10px 0;
        font-size: 12px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        writing-mode: vertical-rl;
        transform: rotate(180deg);
        cursor: pointer;
        box-shadow: 0 8px 18px rgba(15, 23, 42, 0.28);
      }
      .notes-toggle.is-active {
        background: #1d4ed8;
      }
      .notes-panel {
        pointer-events: auto;
        width: 320px;
        max-width: 82vw;
        height: 100%;
        background: rgba(255, 255, 255, 0.98);
        border-right: 1px solid rgba(15, 23, 42, 0.12);
        box-shadow: 8px 0 24px rgba(15, 23, 42, 0.18);
        transform: translateX(-100%);
        transition: transform 0.2s ease;
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 14px 14px 16px;
      }
      .notes-shell.is-open .notes-panel {
        transform: translateX(0);
      }
      .notes-shell.is-expanded .notes-panel {
        width: 80vw;
        max-width: 80vw;
      }
      .notes-header {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 8px;
        font-size: 14px;
        font-weight: 700;
      }
      .notes-tabs {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .notes-tab {
        border: none;
        background: transparent;
        padding: 0;
        font: inherit;
        font-weight: 700;
        color: #0f172a;
        cursor: pointer;
      }
      .notes-tab.is-active {
        color: #1d4ed8;
      }
      .notes-tab-sep {
        color: #94a3b8;
        font-weight: 500;
      }
      .notes-title {
        cursor: pointer;
        user-select: none;
      }
      .notes-saved-status {
        margin-left: auto;
        font-size: 11px;
        font-weight: 600;
        color: #1d4ed8;
      }
      .notes-close {
        border: none;
        background: transparent;
        font-size: 18px;
        cursor: pointer;
        color: #64748b;
      }
      .notes-actions {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
      }
      .notes-actions-group {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .notes-actions-left {
        gap: 2px;
      }
      .notes-actions-right {
        margin-left: auto;
        gap: 1px;
      }
      .notes-btn {
        border: 1px solid rgba(148, 163, 184, 0.5);
        background: none;
        color: #4f535b;
        font-size: 14px;
        font-weight: 600;
        padding: 6px 10px;
        border-radius: 10px;
        cursor: pointer;
      }
      .notes-btn--borderless {
        border: none;
      }
      .notes-btn--icon {
        padding: 4px 6px;
        line-height: 1;
      }
      .notes-btn--icon-lg {
        font-size: 22px;
      }
      .notes-panel-section {
        display: none;
        flex-direction: column;
        gap: 12px;
        flex: 1;
        min-height: 0;
      }
      .notes-shell[data-tab="notes"] .notes-panel-section--notes {
        display: flex;
      }
      .notes-shell[data-tab="selectors"] .notes-panel-section--selectors {
        display: flex;
      }
      .notes-editor {
        flex: 1;
        border: 1px solid rgba(148, 163, 184, 0.4);
        border-radius: 12px;
        padding: 10px 12px;
        font-size: 13px;
        overflow-y: auto;
        outline: none;
        background: #f8fafc;
      }
      .notes-editor:empty:before {
        content: attr(data-placeholder);
        color: #94a3b8;
      }
      .notes-editor:focus {
        border-color: #60a5fa;
        box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.25);
      }
      .notes-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 11px;
        color: #64748b;
      }
      .notes-status {
        min-height: 14px;
        color: #1d4ed8;
      }
      .selectors-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 12px;
        color: #475569;
      }
      .selectors-platform {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-weight: 600;
      }
      .selectors-platform-select {
        font-size: 12px;
        color: #0f172a;
        border: 1px solid rgba(148, 163, 184, 0.6);
        border-radius: 8px;
        padding: 2px 6px;
        background: #ffffff;
        cursor: pointer;
      }
      .selectors-header-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .selectors-btn {
        border: none;
        background: transparent;
        color: #334155;
        font-size: 12px;
        font-weight: 600;
        padding: 2px 6px;
        border-radius: 6px;
        cursor: pointer;
      }
      .selectors-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .selectors-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow-y: auto;
        padding-right: 4px;
        flex: 1;
      }
      .selectors-row {
        border: none;
        border-radius: 0;
        padding: 8px;
        background: transparent;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .selectors-row-header {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
      }
      .selectors-status {
        font-size: 14px;
      }
      .selectors-status--ok {
        color: #16a34a;
      }
      .selectors-status--bad {
        color: #dc2626;
      }
      .selectors-status--idle {
        color: #94a3b8;
      }
      .selectors-label {
        font-weight: 700;
        color: #0f172a;
      }
      .selectors-actions {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .selectors-btn-record.is-active {
        color: #dc2626;
        animation: selectorsPulse 1.2s infinite;
      }
      @keyframes selectorsPulse {
        0% { transform: scale(1); }
        50% { transform: scale(1.08); }
        100% { transform: scale(1); }
      }
      .selectors-input {
        border: 1px solid rgba(148, 163, 184, 0.5);
        border-radius: 8px;
        padding: 6px 8px;
        font-size: 12px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        background: #fff;
        color: #0f172a;
        width: 100%;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .selectors-input:focus {
        outline: none;
        border-color: #60a5fa;
        box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.2);
        text-overflow: clip;
        overflow: auto;
      }
      .selectors-footer {
        font-size: 11px;
        color: #64748b;
      }
      .selectors-status-text {
        min-height: 14px;
        color: #1d4ed8;
      }
      .selectors-file-input {
        display: none;
      }
    </style>
    <div class="notes-shell">
      <button class="notes-toggle" type="button" aria-pressed="false" aria-label="Toggle notes">Notes</button>
      <div class="notes-panel" role="dialog" aria-label="Notes panel">
        <div class="notes-header">
          <div class="notes-tabs">
            <button class="notes-tab notes-title is-active" type="button" data-tab="notes">Notes</button>
            <span class="notes-tab-sep">/</span>
            <button class="notes-tab" type="button" data-tab="selectors">Selectors</button>
          </div>
          <span class="notes-saved-status" aria-live="polite"></span>
          <button class="notes-close" type="button" aria-label="Close notes">x</button>
        </div>
        <div class="notes-panel-section notes-panel-section--notes">
          <div class="notes-actions">
            <div class="notes-actions-group notes-actions-left">
              <button class="notes-btn notes-btn--borderless notes-btn--icon notes-btn--icon-lg notes-btn-plus" type="button" data-action="new-scratch" aria-label="New scratch">+</button>
              <button class="notes-btn notes-btn--borderless notes-btn--icon notes-btn--icon-lg notes-btn-selection" type="button" data-action="pick-text" aria-label="Pick">⧈</button>
              <button class="notes-btn notes-btn--borderless notes-btn--icon notes-btn-bracket-a" type="button" data-action="append-selection" aria-label="Selection">⸢a⸣</button>
              <button class="notes-btn notes-btn--borderless notes-btn--icon notes-btn-command" type="button" data-action="pick-answer" aria-label="Pick answer">⌘</button>
              <button class="notes-btn notes-btn--borderless notes-btn-all" type="button" data-action="append-conversation" aria-label="Add all">All</button>
            </div>
            <div class="notes-actions-group notes-actions-right">
              <button class="notes-btn notes-btn--borderless notes-btn--icon notes-btn-export" type="button" data-action="export-html" aria-label="Export HTML">&lt;/&gt;</button>
              <button class="notes-btn notes-btn--borderless notes-btn-save" type="button" data-action="save-scratch">Save</button>
              <button class="notes-btn notes-btn--borderless notes-btn--icon notes-btn-trash" type="button" data-action="clear-scratch" aria-label="Clear notes">🗑️</button>
            </div>
          </div>
          <div class="notes-editor" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="Scratch notes..."></div>
          <div class="notes-footer">
            <span class="notes-status" aria-live="polite"></span>
            <span>Stored locally</span>
          </div>
        </div>
        <div class="notes-panel-section notes-panel-section--selectors">
          <div class="selectors-header">
            <label class="selectors-platform">Platform:
              <select class="selectors-platform-select"></select>
            </label>
            <div class="selectors-header-actions">
              <button class="selectors-btn selectors-btn-export" type="button" data-selectors-action="export">{}</button>
              <button class="selectors-btn selectors-btn-import" type="button" data-selectors-action="import">↓</button>
              <button class="selectors-btn selectors-btn-save-all" type="button" data-selectors-action="save-all">Save</button>
            </div>
          </div>
          <div class="selectors-list"></div>
          <div class="selectors-footer">
            <span class="selectors-status-text" aria-live="polite"></span>
          </div>
          <input class="selectors-file-input" type="file" accept="application/json" />
        </div>
      </div>
    </div>
  `;

  const shell = shadow.querySelector('.notes-shell');
  const toggleBtn = shadow.querySelector('.notes-toggle');
  const closeBtn = shadow.querySelector('.notes-close');
  const headerTitle = shadow.querySelector('.notes-title');
  const notesTabBtn = shadow.querySelector('.notes-tab[data-tab="notes"]');
  const selectorsTabBtn = shadow.querySelector('.notes-tab[data-tab="selectors"]');
  const notesEditor = shadow.querySelector('.notes-editor');
  const statusEl = shadow.querySelector('.notes-status');
  const savedStatusEl = shadow.querySelector('.notes-saved-status');
  const actionButtons = shadow.querySelectorAll('.notes-btn');
  const selectorsList = shadow.querySelector('.selectors-list');
  const selectorsPlatformSelect = shadow.querySelector('.selectors-platform-select');
  const selectorsStatusEl = shadow.querySelector('.selectors-status-text');
  const selectorsFileInput = shadow.querySelector('.selectors-file-input');
  const selectorsHeaderButtons = shadow.querySelectorAll('[data-selectors-action]');

  const showStatus = (message) => {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    if (state.statusTimer) clearTimeout(state.statusTimer);
    if (message) {
      state.statusTimer = setTimeout(() => {
        statusEl.textContent = '';
      }, 2000);
    }
  };

  const setSavedStatus = (message) => {
    if (!savedStatusEl) return;
    savedStatusEl.textContent = message || '';
  };

  const clearSavedStatus = () => {
    setSavedStatus('');
  };

  const normalizeScratchText = (value) => String(value || '').replace(/\r\n/g, '\n');

  const normalizeScratchHtml = (value) => {
    const html = String(value || '').trim();
    if (!html) return '';
    if (html === '<br>' || html === '<br/>' || html === '<br />') return '';
    return html;
  };

  const escapeHtml = (value) =>
    String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const htmlFromText = (text) => escapeHtml(normalizeScratchText(text)).replace(/\n/g, '<br>');

  const getScratchPlainText = () => {
    if (!notesEditor) return '';
    const text = notesEditor.innerText ?? notesEditor.textContent ?? '';
    return normalizeScratchText(text);
  };

  const getScratchHtml = () => {
    if (!notesEditor) return '';
    return normalizeScratchHtml(notesEditor.innerHTML || '');
  };

  const setScratchHtml = (html) => {
    if (!notesEditor) return;
    notesEditor.innerHTML = normalizeScratchHtml(html);
  };

  const setScratchFromText = (text) => {
    setScratchHtml(htmlFromText(text));
  };

  const getScratchExportHtml = () => {
    if (!notesEditor) return '';
    const builder = globalThis.ContentUtils?.buildInlineHtml;
    if (typeof builder === 'function') {
      try {
        const html = builder(notesEditor, { includeRoot: false });
        return normalizeScratchHtml(html);
      } catch (error) {
        console.warn('[notes-sidebar] export inline build failed', error);
      }
    }
    return getScratchHtml();
  };

  const stripHtml = (html) => {
    const container = document.createElement('div');
    container.innerHTML = html;
    return normalizeScratchText(container.textContent || '');
  };

  const sanitizeHtmlFragment = (html) => {
    if (!html) return '';
    const container = document.createElement('div');
    container.innerHTML = html;
    container.querySelectorAll('script, style, noscript').forEach((node) => node.remove());
    container.querySelectorAll('*').forEach((node) => {
      Array.from(node.attributes || []).forEach((attr) => {
        if (/^on/i.test(attr.name)) {
          node.removeAttribute(attr.name);
        }
      });
    });
    return container.innerHTML;
  };

  const INLINE_STYLE_PROPERTIES = [
    'color',
    'background-color',
    'font-size',
    'font-family',
    'font-weight',
    'font-style',
    'font-variant',
    'line-height',
    'letter-spacing',
    'word-spacing',
    'text-align',
    'text-transform',
    'text-decoration',
    'white-space',
    'display',
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'border-top',
    'border-right',
    'border-bottom',
    'border-left',
    'border-radius',
    'list-style-type',
    'list-style-position'
  ];

  const buildInlineStyle = (element) => {
    if (!element || element.nodeType !== 1) return '';
    const computed = getComputedStyle(element);
    return INLINE_STYLE_PROPERTIES.map((prop) => {
      const value = computed.getPropertyValue(prop);
      return value ? `${prop}:${value.trim()};` : '';
    }).join('');
  };

  const applyInlineStyles = (source, target) => {
    const style = buildInlineStyle(source);
    if (style) {
      target.setAttribute('style', style);
    }
  };

  const buildSelectionHtmlWithStyles = (range) => {
    if (!range) return '';
    const root = range.commonAncestorContainer?.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer?.parentElement;
    const fragment = range.cloneContents();
    const container = document.createElement('div');
    container.appendChild(fragment);
    if (!root) return container.innerHTML || '';
    const token = `codex-inline-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const attr = 'data-codex-inline-id';
    const elementMap = new Map();
    let counter = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => {
        try {
          return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        } catch (_) {
          return NodeFilter.FILTER_REJECT;
        }
      }
    });
    let current = walker.currentNode;
    while (current) {
      const id = `${token}-${counter}`;
      counter += 1;
      current.setAttribute(attr, id);
      elementMap.set(id, current);
      current = walker.nextNode();
    }
    try {
      container.querySelectorAll(`[${attr}]`).forEach((node) => {
        const id = node.getAttribute(attr);
        const original = elementMap.get(id);
        if (original) applyInlineStyles(original, node);
        node.removeAttribute(attr);
      });
    } finally {
      elementMap.forEach((element) => element.removeAttribute(attr));
    }
    return container.innerHTML || '';
  };

  const setOpen = (nextOpen) => {
    state.open = !!nextOpen;
    shell.classList.toggle('is-open', state.open);
    toggleBtn.classList.toggle('is-active', state.open);
    toggleBtn.setAttribute('aria-pressed', String(state.open));
    if (!state.open) {
      stopSelectorRecord('cancel');
    }
    if (state.open) {
      ensureScratchLoaded();
      if (state.activeTab === 'notes') {
        notesEditor?.focus();
      }
    }
  };

  const setExpanded = (nextExpanded) => {
    state.expanded = !!nextExpanded;
    shell.classList.toggle('is-expanded', state.expanded);
  };

  const setActiveTab = (tab) => {
    const nextTab = tab === 'selectors' ? 'selectors' : 'notes';
    state.activeTab = nextTab;
    shell.dataset.tab = nextTab;
    notesTabBtn?.classList.toggle('is-active', nextTab === 'notes');
    selectorsTabBtn?.classList.toggle('is-active', nextTab === 'selectors');
    if (nextTab === 'selectors') {
      ensureSelectorsInitialized();
    }
  };

  const scheduleSave = () => {
    if (!state.noteId) return;
    const nextValue = getScratchPlainText();
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(async () => {
      if (!state.noteId) return;
      if (nextValue === state.lastSavedText) return;
      state.pendingSave = true;
      try {
        await sendCommand(COMMANDS.NOTE_UPDATE_TEXT, { noteId: state.noteId, text: nextValue });
        state.lastSavedText = nextValue;
        showStatus('Saved');
      } catch (error) {
        console.warn('[notes-sidebar] save failed', error);
        showStatus('Save failed');
      } finally {
        state.pendingSave = false;
      }
    }, 300);
  };

  const refreshScratch = async () => {
    if (!state.noteId || state.refreshInFlight || state.pendingSave) return;
    if (state.hasUserInput) return;
    if (getScratchPlainText() !== state.lastSavedText) return;
    state.refreshInFlight = true;
    try {
      const result = await sendCommand(COMMANDS.NOTE_GET, { noteId: state.noteId });
      const nextText = result?.text || '';
      if (getScratchPlainText() === state.lastSavedText) {
        setScratchFromText(nextText);
        state.lastSavedText = normalizeScratchText(nextText);
      }
    } catch (error) {
      console.warn('[notes-sidebar] refresh failed', error);
    } finally {
      state.refreshInFlight = false;
    }
  };

  const loadScratch = async () => {
    if (state.scratchLoaded || state.scratchLoading) return;
    state.scratchLoading = true;
    try {
      await sendCommand(COMMANDS.INIT);
      const scratch = await sendCommand(COMMANDS.NOTE_GET_OR_CREATE_SCRATCH, {
        origin: 'comparator',
        key: 'scratch',
        title: 'Comparator Draft'
      });
      state.noteId = scratch?.noteId || null;
      state.tabId = scratch?.tabId || null;
      const scratchText = scratch?.text || '';
      const shouldReset = state.resetScratchOnLoad && !state.hasUserInput;
      state.resetScratchOnLoad = false;
      if (shouldReset) {
        setScratchHtml('');
        state.lastSavedText = '';
        clearSavedStatus();
        if (scratchText.trim() && state.noteId) {
          state.pendingSave = true;
          try {
            await sendCommand(COMMANDS.NOTE_UPDATE_TEXT, { noteId: state.noteId, text: '' });
          } catch (error) {
            console.warn('[notes-sidebar] scratch reset failed', error);
          } finally {
            state.pendingSave = false;
          }
        }
      } else if (!state.hasUserInput) {
        setScratchFromText(scratchText);
        state.lastSavedText = normalizeScratchText(scratchText);
      } else if (state.noteId) {
        scheduleSave();
      }
      state.scratchLoaded = true;
    } catch (error) {
      console.warn('[notes-sidebar] scratch load failed', error);
      showStatus('Notes offline');
      state.scratchLoaded = false;
    } finally {
      state.scratchLoading = false;
    }
  };

  const ensureScratchLoaded = () => {
    loadScratch();
  };

  const formatScratchTimestamp = (value = new Date()) => {
    const date = value instanceof Date ? value : new Date(value);
    const pad = (num) => String(num).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const buildScratchTitle = (text) => {
    const value = typeof text === 'string' ? text.trim() : '';
    if (value) {
      const firstLine = value.split(/\n/)[0].trim();
      if (firstLine) return firstLine;
    }
    return `Scratch — ${formatScratchTimestamp()}`;
  };

  const getActiveNotesTab = async () => {
    if (!chrome?.storage?.local?.get) return null;
    try {
      const result = await new Promise((resolve) =>
        chrome.storage.local.get(['notes_active_tab'], resolve)
      );
      return result?.notes_active_tab || null;
    } catch (error) {
      console.warn('[notes-sidebar] active tab lookup failed', error);
      return null;
    }
  };

  const buildHeaderLine = (meta = {}) => {
    const title = (meta.title || '').trim();
    const url = (meta.url || '').trim();
    if (!title && !url) return '';
    const timestamp = formatScratchTimestamp(meta.ts || Date.now());
    return [title, url, timestamp].filter(Boolean).join(' — ');
  };

  const buildInlineHtml = (element) => {
    if (!element) return '';
    const builder = globalThis.ContentUtils?.buildInlineHtml;
    if (typeof builder === 'function') {
      return String(builder(element, { includeRoot: true }) || '').trim();
    }
    return String(element.outerHTML || element.innerHTML || '').trim();
  };

  const resolvePlatformKey = () => {
    const detector = globalThis.AnswerPipelineSelectors?.detectPlatform;
    const detected = typeof detector === 'function' ? detector() : '';
    const host = String(globalThis.location?.hostname || '').toLowerCase();
    const raw = String(detected || '').toLowerCase();
    if (raw) return raw === 'gpt' ? 'chatgpt' : raw;
    if (host.includes('chatgpt') || host.includes('openai')) return 'chatgpt';
    if (host.includes('claude.ai')) return 'claude';
    if (host.includes('gemini.google') || host.includes('bard.google')) return 'gemini';
    if (host.includes('grok') || host.includes('x.ai') || host === 'x.com') return 'grok';
    if (host.includes('perplexity.ai')) return 'perplexity';
    if (host.includes('deepseek')) return 'deepseek';
    if (host.includes('qwen')) return 'qwen';
    if (host.includes('mistral')) return 'lechat';
    return 'generic';
  };

  const PLATFORM_LABELS = {
    chatgpt: 'ChatGPT',
    claude: 'Claude',
    gemini: 'Gemini',
    grok: 'Grok',
    perplexity: 'Perplexity',
    deepseek: 'DeepSeek',
    qwen: 'Qwen',
    lechat: 'Le Chat',
    generic: 'Generic'
  };

  const getActivePlatform = () => state.selectors.platform || resolvePlatformKey();

  const ensurePlatformOptions = () => {
    if (!selectorsPlatformSelect || selectorsPlatformSelect.options.length) return;
    Object.entries(PLATFORM_LABELS).forEach(([key, label]) => {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = label;
      selectorsPlatformSelect.appendChild(option);
    });
  };

  const PLATFORM_MODEL_MAP = {
    chatgpt: 'GPT',
    claude: 'Claude',
    gemini: 'Gemini',
    grok: 'Grok',
    perplexity: 'Perplexity',
    deepseek: 'DeepSeek',
    qwen: 'Qwen',
    lechat: 'LeChat'
  };

  const SELECTOR_FIELDS = [
    { key: 'composer', label: 'composer' },
    { key: 'sendButton', label: 'sendButton' },
    { key: 'response', label: 'response' },
    { key: 'stopButton', label: 'stopButton' },
    { key: 'regenerate', label: 'regenerate' },
    { key: 'lastMessage', label: 'lastMessage' }
  ];

  const flattenSelectors = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.flatMap((entry) => flattenSelectors(entry));
    }
    if (typeof value === 'string') return [value];
    return [];
  };

  const resolveModelName = (platform) => PLATFORM_MODEL_MAP[platform] || null;

  const resolvePlatformLabel = (platform) =>
    PLATFORM_LABELS[platform] || platform || 'Unknown';

  const getSelectorCandidatesFromConfig = (modelName, elementType) => {
    const config = globalThis.SelectorConfig;
    if (!config || !modelName || !elementType) return [];
    const version = typeof config.detectUIVersion === 'function'
      ? config.detectUIVersion(modelName)
      : 'unknown';
    const list = typeof config.getSelectorsFor === 'function'
      ? config.getSelectorsFor(modelName, version, elementType)
      : [];
    if (list && list.length) return list;
    if (typeof config.getSelectorsFor === 'function') {
      return config.getSelectorsFor(modelName, 'emergency', elementType) || [];
    }
    return [];
  };

  const getSelectorCandidatesFromPipeline = (platform, elementType) => {
    const bundle = globalThis.AnswerPipelineSelectors;
    const selectors = bundle?.PLATFORM_SELECTORS?.[platform];
    if (!selectors) return [];
    if (elementType === 'lastMessage') return flattenSelectors(selectors.lastMessage);
    if (elementType === 'stopButton') return flattenSelectors(selectors.stopButton);
    if (elementType === 'regenerate') {
      const indicators = flattenSelectors(selectors.completionIndicators || []);
      const preferred = indicators.find((item) => /regenerate|retry|continue/i.test(item));
      return preferred ? [preferred] : indicators;
    }
    if (elementType === 'response') {
      return flattenSelectors([selectors.answerContainer, selectors.lastMessage].filter(Boolean));
    }
    return [];
  };

  const resolveSelectorDefault = (platform, modelName, elementType) => {
    const fromConfig = getSelectorCandidatesFromConfig(modelName, elementType);
    const base = fromConfig.length ? fromConfig : getSelectorCandidatesFromPipeline(platform, elementType);
    return base.find((entry) => typeof entry === 'string' && entry.trim()) || '';
  };

  const loadManualOverrides = () =>
    new Promise((resolve) => {
      if (!chrome?.storage?.local?.get) {
        resolve({});
        return;
      }
      chrome.storage.local.get('selectors_remote_override', (res) => {
        if (chrome.runtime?.lastError) {
          resolve({});
          return;
        }
        const payload = res?.selectors_remote_override || {};
        resolve(payload.manualOverrides || {});
      });
    });

  const resolveOverrideValue = (overrides, modelName, elementType) => {
    const modelOverrides = overrides?.[modelName] || {};
    const raw = modelOverrides?.[elementType];
    if (Array.isArray(raw)) {
      return raw.find((value) => typeof value === 'string' && value.trim()) || '';
    }
    if (typeof raw === 'string') return raw.trim();
    return '';
  };

  const showSelectorsStatus = (message) => {
    if (!selectorsStatusEl) return;
    selectorsStatusEl.textContent = message || '';
    if (state.selectors.statusTimer) clearTimeout(state.selectors.statusTimer);
    if (message) {
      state.selectors.statusTimer = setTimeout(() => {
        if (selectorsStatusEl) selectorsStatusEl.textContent = '';
      }, 2500);
    }
  };

  const updateSelectorStatus = (entry, status) => {
    if (!entry?.statusEl) return;
    entry.status = status;
    entry.statusEl.classList.remove('selectors-status--ok', 'selectors-status--bad', 'selectors-status--idle');
    if (status === 'ok') {
      entry.statusEl.textContent = '🟢';
      entry.statusEl.classList.add('selectors-status--ok');
      return;
    }
    if (status === 'bad') {
      entry.statusEl.textContent = '🔴';
      entry.statusEl.classList.add('selectors-status--bad');
      return;
    }
    entry.statusEl.textContent = '⚪';
    entry.statusEl.classList.add('selectors-status--idle');
  };

  const syncSelectorSaveState = (entry) => {
    if (!entry?.saveBtn) return;
    entry.saveBtn.disabled = !entry.dirty;
  };

  const buildSelectorsRow = (field) => {
    const row = document.createElement('div');
    row.className = 'selectors-row';
    row.dataset.key = field.key;
    row.innerHTML = `
      <div class="selectors-row-header">
        <span class="selectors-status selectors-status--idle">⚪</span>
        <span class="selectors-label">${escapeHtml(field.label)}</span>
        <div class="selectors-actions">
          <button class="selectors-btn selectors-btn-pick" type="button" data-action="pick" aria-label="Pick">🎯</button>
          <button class="selectors-btn selectors-btn-record" type="button" data-action="record" aria-label="Record">⬤</button>
          <button class="selectors-btn selectors-btn-test" type="button" data-action="test">Test</button>
          <button class="selectors-btn selectors-btn-save" type="button" data-action="save">Save</button>
          <button class="selectors-btn selectors-btn-clear" type="button" data-action="clear" aria-label="Clear selector">🗑️</button>
        </div>
      </div>
      <input class="selectors-input" type="text" placeholder="CSS selector" />
    `;
    return row;
  };

  const updateSelectorInput = (entry, rawValue) => {
    const value = String(rawValue || '').trim();
    entry.value = value;
    if (entry.inputEl) {
      entry.inputEl.value = value;
      entry.inputEl.title = value;
    }
    entry.dirty = value !== entry.savedValue;
    updateSelectorStatus(entry, value ? 'idle' : 'idle');
    syncSelectorSaveState(entry);
  };

  const testSelectorEntry = (entry) => {
    if (!entry) return;
    const selector = String(entry.value || '').trim();
    if (!selector) {
      updateSelectorStatus(entry, 'idle');
      showSelectorsStatus('Selector is empty');
      return;
    }
    try {
      const matches = document.querySelectorAll(selector);
      updateSelectorStatus(entry, matches.length === 1 ? 'ok' : 'bad');
      if (matches.length > 0) {
        const element = matches[0];
        const prev = {
          outline: element.style.outline || '',
          outlineOffset: element.style.outlineOffset || '',
          boxShadow: element.style.boxShadow || ''
        };
        element.style.outline = '2px solid #2ecc71';
        element.style.outlineOffset = '2px';
        element.style.boxShadow = '0 0 0 2px #2ecc71';
        window.setTimeout(() => {
          element.style.outline = prev.outline;
          element.style.outlineOffset = prev.outlineOffset;
          element.style.boxShadow = prev.boxShadow;
        }, 5000);
      }
    } catch (error) {
      updateSelectorStatus(entry, 'bad');
      showSelectorsStatus('Invalid selector');
    }
  };

  const sendRuntimeMessage = (payload) =>
    new Promise((resolve) => {
      if (!chrome?.runtime?.sendMessage) {
        resolve({ status: 'error', error: 'runtime unavailable' });
        return;
      }
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime?.lastError) {
          resolve({ status: 'error', error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { status: 'error', error: 'no response' });
      });
    });

  const saveSelectorEntry = async (entry) => {
    if (!entry) return;
    const selector = String(entry.value || '').trim();
    if (!selector) {
      showSelectorsStatus('Selector is empty');
      return;
    }
    if (!state.selectors.modelName) {
      showSelectorsStatus('Unknown platform');
      return;
    }
    showSelectorsStatus('Saving selector…');
    const response = await sendRuntimeMessage({
      type: 'SAVE_SELECTOR_OVERRIDE',
      modelName: state.selectors.modelName,
      elementType: entry.key,
      selector,
      reason: 'scratch selectors tab'
    });
    if (response?.status !== 'ok') {
      showSelectorsStatus(response?.error || 'Save failed');
      return;
    }
    entry.savedValue = selector;
    entry.dirty = false;
    syncSelectorSaveState(entry);
    showSelectorsStatus('Saved');
  };

  const saveAllSelectors = async () => {
    const entries = Array.from(state.selectors.entries.values()).filter((entry) => entry.dirty);
    if (!entries.length) {
      showSelectorsStatus('No changes to save');
      return;
    }
    for (const entry of entries) {
      // eslint-disable-next-line no-await-in-loop
      await saveSelectorEntry(entry);
    }
  };

  const cssEscape = (value) => {
    if (globalThis.CSS && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  };

  const isUniqueSelector = (selector, root = document) => {
    try {
      return root.querySelectorAll(selector).length === 1;
    } catch (_) {
      return false;
    }
  };

  const isDynamicClass = (className) => {
    if (!className) return true;
    if (className.length > 32) return true;
    if (/^[a-f0-9]{6,}$/i.test(className)) return true;
    if (/\d{6,}/.test(className)) return true;
    if (/^(css|sc|jss|chakra|mui)-/.test(className)) return true;
    return false;
  };

  const getStableClasses = (element) =>
    Array.from(element.classList || []).filter((cls) => !isDynamicClass(cls));

  const getNthOfTypeIndex = (element) => {
    const parent = element.parentElement;
    if (!parent) return 1;
    const siblings = Array.from(parent.children).filter(
      (child) => child.tagName === element.tagName
    );
    return siblings.indexOf(element) + 1;
  };

  const needsNthOfType = (element) => {
    const parent = element.parentElement;
    if (!parent) return false;
    const siblings = Array.from(parent.children).filter(
      (child) => child.tagName === element.tagName
    );
    return siblings.length > 1;
  };

  const buildAttributeSelector = (element) => {
    const attrs = [
      'data-testid',
      'data-test-id',
      'data-qa',
      'data-qa-id',
      'data-qa-name',
      'data-cy',
      'data-automation-id',
      'data-automation',
      'aria-label',
      'aria-labelledby',
      'name',
      'title',
      'placeholder',
      'role'
    ];
    const tag = element.tagName ? element.tagName.toLowerCase() : '';
    for (const attr of attrs) {
      const value = element.getAttribute(attr);
      if (!value) continue;
      const selector = `[${attr}="${cssEscape(value)}"]`;
      const tagged = tag ? `${tag}${selector}` : selector;
      if (tag && isUniqueSelector(tagged)) return tagged;
      if (isUniqueSelector(selector)) return selector;
    }
    return null;
  };

  const buildPathSelector = (element) => {
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      let part = tag;
      const classes = getStableClasses(current).slice(0, 2);
      if (classes.length) {
        part += `.${classes.map(cssEscape).join('.')}`;
      }
      if (needsNthOfType(current)) {
        part += `:nth-of-type(${getNthOfTypeIndex(current)})`;
      }
      parts.unshift(part);
      const selector = parts.join(' > ');
      if (isUniqueSelector(selector)) return selector;
      current = current.parentElement;
    }
    return parts.join(' > ');
  };

  const buildSelectorForElement = (element) => {
    if (!element || element.nodeType !== 1) return null;
    if (element.id) {
      const idSelector = `#${cssEscape(element.id)}`;
      if (isUniqueSelector(idSelector)) return idSelector;
    }
    const attrSelector = buildAttributeSelector(element);
    if (attrSelector) return attrSelector;
    const pathSelector = buildPathSelector(element);
    if (pathSelector) return pathSelector;
    return element.tagName ? element.tagName.toLowerCase() : null;
  };

  const resolveRecordTarget = (target, entryKey) => {
    if (!target) return null;
    if (entryKey === 'sendButton') {
      return target.closest('button, [role="button"], input[type="submit"], input[type="button"]') || target;
    }
    return target;
  };

  const stopSelectorRecord = (reason) => {
    const record = state.selectors.record;
    const entry = record?.key ? getSelectorEntry(record.key) : null;
    if (record?.timer) clearTimeout(record.timer);
    if (record?.clickHandler) document.removeEventListener('click', record.clickHandler, true);
    if (record?.keyHandler) document.removeEventListener('keydown', record.keyHandler, true);
    if (entry?.recordBtn) entry.recordBtn.classList.remove('is-active');
    state.selectors.record = {
      key: null,
      timer: null,
      clickHandler: null,
      keyHandler: null
    };
    if (reason === 'timeout') showSelectorsStatus('Record timeout');
    if (reason === 'cancel') showSelectorsStatus('Record cancelled');
  };

  const startSelectorRecord = (entry) => {
    if (!entry) return;
    if (state.selectors.record.key) {
      stopSelectorRecord('cancel');
    }
    entry.recordBtn?.classList.add('is-active');
    showSelectorsStatus('Recording… click target');
    const clickHandler = (event) => {
      const rawTarget = event.target;
      if (rawTarget?.closest?.('#codex-notes-sidebar-host')) return;
      const target = resolveRecordTarget(rawTarget, entry.key);
      const selector = buildSelectorForElement(target);
      if (!selector) {
        stopSelectorRecord('cancel');
        showSelectorsStatus('Selector not found');
        return;
      }
      updateSelectorInput(entry, selector);
      testSelectorEntry(entry);
      stopSelectorRecord('done');
      showSelectorsStatus('Recorded');
    };
    const keyHandler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        stopSelectorRecord('cancel');
      }
    };
    document.addEventListener('click', clickHandler, true);
    document.addEventListener('keydown', keyHandler, true);
    const timer = setTimeout(() => stopSelectorRecord('timeout'), 15000);
    state.selectors.record = {
      key: entry.key,
      timer,
      clickHandler,
      keyHandler
    };
  };

  const pickSelectorEntry = async (entry) => {
    if (!entry) return;
    if (state.pickerActive) {
      showSelectorsStatus('Picker already active');
      return;
    }
    const picker = globalThis.CodexElementPicker?.startPick;
    if (!picker) {
      showSelectorsStatus('Picker unavailable');
      return;
    }
    state.pickerActive = true;
    showSelectorsStatus('Pick an element');
    try {
      const result = await picker({ mode: 'selector' });
      state.pickerActive = false;
      if (!result) {
        showSelectorsStatus('Picker cancelled');
        return;
      }
      if (result.ok === false) {
        showSelectorsStatus(result.error || 'Pick failed');
        return;
      }
      const selector = String(result.selector || '').trim();
      if (!selector) {
        showSelectorsStatus('Selector empty');
        return;
      }
      updateSelectorInput(entry, selector);
      testSelectorEntry(entry);
      showSelectorsStatus('Picked');
    } catch (error) {
      state.pickerActive = false;
      showSelectorsStatus('Picker cancelled');
    }
  };

  const getSelectorEntry = (key) => state.selectors.entries.get(key);

  const setSelectorsPlatform = (platform) => {
    if (!selectorsList) return;
    const normalized = String(platform || '').trim() || resolvePlatformKey();
    if (!normalized) return;
    if (state.selectors.initialized && state.selectors.platform === normalized) {
      if (selectorsPlatformSelect) {
        ensurePlatformOptions();
        selectorsPlatformSelect.value = normalized;
      }
      return;
    }
    state.selectors.initialized = true;
    state.selectors.platform = normalized;
    state.selectors.modelName = resolveModelName(normalized);
    if (selectorsPlatformSelect) {
      ensurePlatformOptions();
      selectorsPlatformSelect.value = normalized;
    }
    selectorsList.innerHTML = '';
    state.selectors.entries.clear();
    SELECTOR_FIELDS.forEach((field) => {
      const row = buildSelectorsRow(field);
      selectorsList.appendChild(row);
      const entry = {
        key: field.key,
        value: '',
        savedValue: '',
        dirty: false,
        status: 'idle',
        row,
        statusEl: row.querySelector('.selectors-status'),
        inputEl: row.querySelector('.selectors-input'),
        pickBtn: row.querySelector('[data-action="pick"]'),
        recordBtn: row.querySelector('[data-action="record"]'),
        testBtn: row.querySelector('[data-action="test"]'),
        saveBtn: row.querySelector('[data-action="save"]'),
        clearBtn: row.querySelector('[data-action="clear"]')
      };
      const initialValue = resolveSelectorDefault(normalized, state.selectors.modelName, field.key);
      entry.savedValue = String(initialValue || '').trim();
      updateSelectorInput(entry, entry.savedValue);
      entry.dirty = false;
      syncSelectorSaveState(entry);
      updateSelectorStatus(entry, entry.savedValue ? 'idle' : 'idle');
      entry.inputEl?.addEventListener('input', (event) => {
        updateSelectorInput(entry, event.target?.value || '');
      });
      entry.pickBtn?.addEventListener('click', () => pickSelectorEntry(entry));
      entry.recordBtn?.addEventListener('click', () => {
        if (state.selectors.record.key === entry.key) {
          stopSelectorRecord('cancel');
          return;
        }
        startSelectorRecord(entry);
      });
      entry.testBtn?.addEventListener('click', () => testSelectorEntry(entry));
      entry.saveBtn?.addEventListener('click', () => saveSelectorEntry(entry));
      entry.clearBtn?.addEventListener('click', () => {
        updateSelectorInput(entry, '');
        updateSelectorStatus(entry, 'idle');
        showSelectorsStatus('Cleared');
      });
      state.selectors.entries.set(entry.key, entry);
    });

    loadManualOverrides().then((overrides) => {
      state.selectors.entries.forEach((entry) => {
        if (!entry || entry.dirty) return;
        const overrideValue = resolveOverrideValue(overrides, state.selectors.modelName, entry.key);
        if (!overrideValue) return;
        entry.savedValue = overrideValue;
        updateSelectorInput(entry, overrideValue);
        entry.dirty = false;
        syncSelectorSaveState(entry);
        updateSelectorStatus(entry, entry.savedValue ? 'idle' : 'idle');
      });
    });
  };

  const ensureSelectorsInitialized = () => {
    setSelectorsPlatform(getActivePlatform());
  };

  const formatSelectorsFilename = (platform = 'selectors') => {
    const date = new Date();
    const pad = (num) => String(num).padStart(2, '0');
    return `${platform}-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`;
  };

  const buildSelectorsExportPayload = () => {
    const selectors = {};
    state.selectors.entries.forEach((entry, key) => {
      selectors[key] = entry?.value ? entry.value : null;
    });
    return {
      platform: getActivePlatform(),
      version: chrome.runtime?.getManifest?.().version || '',
      exported: new Date().toISOString(),
      selectors
    };
  };

  const exportSelectorsJson = () => {
    ensureSelectorsInitialized();
    const payload = buildSelectorsExportPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = formatSelectorsFilename(payload.platform || 'selectors');
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showSelectorsStatus('Exported');
  };

  const applySelectorsImport = (payload) => {
    if (!payload || typeof payload !== 'object') {
      showSelectorsStatus('Invalid file');
      return;
    }
    const payloadPlatform = String(payload.platform || '').toLowerCase();
    const currentPlatform = String(getActivePlatform()).toLowerCase();
    if (payloadPlatform && currentPlatform && payloadPlatform !== currentPlatform) {
      const proceed = confirm(`File is for ${payload.platform}, you are on ${resolvePlatformLabel(currentPlatform)}. Apply anyway?`);
      if (!proceed) return;
    }
    if (payloadPlatform) {
      setSelectorsPlatform(payloadPlatform);
    } else {
      ensureSelectorsInitialized();
    }
    const imported = payload.selectors || {};
    state.selectors.entries.forEach((entry, key) => {
      if (Object.prototype.hasOwnProperty.call(imported, key)) {
        updateSelectorInput(entry, imported[key] || '');
        testSelectorEntry(entry);
      }
    });
    showSelectorsStatus('Imported');
  };

  const handleSelectorsImportFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || ''));
        applySelectorsImport(parsed);
      } catch (error) {
        showSelectorsStatus('Invalid JSON');
      }
    };
    reader.readAsText(file);
  };

  const MESSAGE_ROLE_ATTRS = [
    'data-message-author-role',
    'data-author-role',
    'data-role',
    'data-message-type'
  ];

  const ROLE_HINTS = {
    assistant: ['assistant', 'bot', 'model', 'response', 'ai'],
    user: ['user', 'human', 'prompt', 'question', 'query', 'input']
  };

  const ROLE_CONTEXT_HINTS = [
    'message',
    'response',
    'prompt',
    'conversation',
    'chat',
    'answer',
    'turn'
  ];

  const detectRoleFromValue = (value, { requireContext = false } = {}) => {
    const raw = String(value || '').toLowerCase();
    if (!raw) return null;
    const hasContext = ROLE_CONTEXT_HINTS.some((hint) => raw.includes(hint));
    if (requireContext && !hasContext && raw !== 'assistant' && raw !== 'user') {
      return null;
    }
    if (ROLE_HINTS.assistant.some((hint) => raw.includes(hint))) return 'assistant';
    if (ROLE_HINTS.user.some((hint) => raw.includes(hint))) return 'user';
    return null;
  };

  const detectMessageRole = (element) => {
    if (!element || element.nodeType !== 1) return null;
    for (const attr of MESSAGE_ROLE_ATTRS) {
      const value = element.getAttribute(attr);
      const role = detectRoleFromValue(value);
      if (role) return role;
    }
    const testId = element.getAttribute('data-testid') || element.getAttribute('data-test-id');
    const roleFromTestId = detectRoleFromValue(testId, { requireContext: true });
    if (roleFromTestId) return roleFromTestId;
    const className = typeof element.className === 'string' ? element.className : '';
    return detectRoleFromValue(className, { requireContext: true });
  };

  const ROLE_FALLBACK_SELECTORS = {
    chatgpt: {
      assistant: [
        '[data-message-author-role="assistant"]',
        '[data-author-role="assistant"]',
        '[data-role="assistant"]',
        '[data-testid*="assistant" i]'
      ],
      user: [
        '[data-message-author-role="user"]',
        '[data-author-role="user"]',
        '[data-role="user"]',
        '[data-testid*="user" i]'
      ]
    },
    claude: {
      assistant: [
        'div[data-testid="conversation-turn"][data-author-role="assistant"]',
        'div[data-testid="conversation-turn"][data-role="assistant"]',
        '[data-message-author-role="assistant"]',
        '[data-role="assistant"]',
        '[data-is-response="true"]'
      ],
      user: [
        'div[data-testid="conversation-turn"][data-author-role="user"]',
        'div[data-testid="conversation-turn"][data-role="user"]',
        '[data-message-author-role="user"]',
        '[data-role="user"]'
      ]
    },
    gemini: {
      assistant: [
        '[data-test-id*="model-response" i]',
        '[data-testid*="model-response" i]',
        '.model-response'
      ],
      user: [
        '[data-test-id*="user-message" i]',
        '[data-testid*="user-message" i]',
        '[data-test-id*="user-prompt" i]',
        '[data-testid*="user-prompt" i]',
        '.user-message'
      ]
    },
    grok: {
      assistant: [
        '[data-message-author-role="assistant"]',
        '[data-role="assistant"]',
        'article[data-role="assistant"]',
        '[data-testid*="assistant" i]'
      ],
      user: [
        '[data-message-author-role="user"]',
        '[data-role="user"]',
        'article[data-role="user"]',
        '[data-testid*="user" i]'
      ]
    },
    perplexity: {
      assistant: [
        '[data-testid*="answer" i]',
        '[data-testid*="response" i]',
        '.answer',
        '.prose'
      ],
      user: [
        '[data-testid*="query" i]',
        '[data-testid*="prompt" i]',
        '.query',
        '.question'
      ]
    },
    deepseek: {
      assistant: [
        '.message-item[data-role="assistant"]',
        '[data-role="assistant"]',
        '.assistant-message',
        '.markdown-body'
      ],
      user: [
        '.message-item[data-role="user"]',
        '[data-role="user"]',
        '.user-message'
      ]
    },
    qwen: {
      assistant: [
        '[data-role*="assistant"]',
        '.message-bot',
        '.bot-message'
      ],
      user: [
        '[data-role*="user"]',
        '.message-user',
        '.user-message'
      ]
    },
    lechat: {
      assistant: [
        '[data-role="assistant"]',
        '.assistant-message',
        'article'
      ],
      user: [
        '[data-role="user"]',
        '.user-message'
      ]
    },
    generic: {
      assistant: [
        '[data-message-author-role="assistant"]',
        '[data-author-role="assistant"]',
        '[data-role="assistant"]',
        '.assistant',
        '.response',
        '.answer',
        'article'
      ],
      user: [
        '[data-message-author-role="user"]',
        '[data-author-role="user"]',
        '[data-role="user"]',
        '.user',
        '.prompt',
        '.question'
      ]
    }
  };

  const getConversationRoot = () => {
    const selectorBundle = globalThis.AnswerPipelineSelectors;
    const platform = resolvePlatformKey();
    const selectors = selectorBundle?.PLATFORM_SELECTORS?.[platform]
      || selectorBundle?.PLATFORM_SELECTORS?.[platform === 'chatgpt' ? 'gpt' : platform];
    if (selectors?.answerContainer) {
      const node = document.querySelector(selectors.answerContainer);
      if (node) return node;
    }
    if (selectors?.lastMessage) {
      const node = document.querySelector(selectors.lastMessage);
      if (node) {
        const container = node.closest(
          '[data-testid*="conversation" i], [data-testid*="chat" i], [class*="conversation" i], [class*="chat" i], [role="log"], [role="main"], main, article'
        );
        return container || node.parentElement || node;
      }
    }
    return document.querySelector('main') || document.body || document.documentElement;
  };

  const getElementText = (element) =>
    normalizeScratchText(element?.innerText || element?.textContent || '').trim();

  const pickBestContentElement = (element) => {
    if (!element) return null;
    const selectors = [
      '[data-testid="message-text"]',
      '[data-testid="message-content"]',
      '[data-testid*="message" i]',
      '.prose',
      '.markdown',
      '.markdown-body',
      'article',
      '[role="article"]',
      '.message-content',
      '.assistant-message',
      '.user-message'
    ];
    const baseText = getElementText(element);
    let best = null;
    let bestLen = 0;
    selectors.forEach((selector) => {
      element.querySelectorAll(selector).forEach((node) => {
        const len = getElementText(node).length;
        if (len > bestLen) {
          bestLen = len;
          best = node;
        }
      });
    });
    if (best && bestLen >= Math.max(30, Math.floor(baseText.length * 0.4))) {
      return best;
    }
    return element;
  };

  const dedupeByAncestor = (entries, root) => {
    const elements = new Set(entries.map((entry) => entry.element));
    return entries.filter((entry) => {
      let current = entry.element?.parentElement;
      while (current && current !== root) {
        if (elements.has(current)) return false;
        current = current.parentElement;
      }
      return true;
    });
  };

  const sortByDomOrder = (entries) =>
    entries.slice().sort((a, b) => {
      if (a.element === b.element) return 0;
      const pos = a.element.compareDocumentPosition(b.element);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

  const collectRoleBasedMessages = (root) => {
    const selector = MESSAGE_ROLE_ATTRS.map((attr) => `[${attr}]`).join(', ');
    const nodes = Array.from(root.querySelectorAll(selector));
    const entries = nodes.map((node) => ({ element: node, role: detectMessageRole(node) }))
      .filter((entry) => entry.role && getElementText(entry.element));
    return dedupeByAncestor(entries, root);
  };

  const collectFallbackMessages = (root, platform, { needAssistant = true, needUser = true } = {}) => {
    const config = ROLE_FALLBACK_SELECTORS[platform] || ROLE_FALLBACK_SELECTORS.generic;
    const entries = [];
    if (needAssistant) {
      config.assistant.forEach((selector) => {
        root.querySelectorAll(selector).forEach((node) => {
          if (getElementText(node)) entries.push({ element: node, role: 'assistant' });
        });
      });
    }
    if (needUser) {
      config.user.forEach((selector) => {
        root.querySelectorAll(selector).forEach((node) => {
          if (getElementText(node)) entries.push({ element: node, role: 'user' });
        });
      });
    }
    return dedupeByAncestor(entries, root);
  };

  const buildConversationEntries = () => {
    const root = getConversationRoot();
    const platform = resolvePlatformKey();
    let entries = collectRoleBasedMessages(root);
    const hasAssistant = entries.some((entry) => entry.role === 'assistant');
    const hasUser = entries.some((entry) => entry.role === 'user');
    if (!hasAssistant || !hasUser) {
      const fallback = collectFallbackMessages(root, platform, {
        needAssistant: !hasAssistant,
        needUser: !hasUser
      });
      const seen = new Set(entries.map((entry) => entry.element));
      fallback.forEach((entry) => {
        if (!seen.has(entry.element)) {
          entries.push(entry);
          seen.add(entry.element);
        }
      });
    }
    entries = sortByDomOrder(entries);
    return entries
      .map((entry) => {
        const element = pickBestContentElement(entry.element);
        const text = getElementText(element);
        const html = buildInlineHtml(element);
        if (!text && !html) return null;
        return { role: entry.role, text, html };
      })
      .filter(Boolean);
  };

  const formatConversationPayload = (entries) => {
    const blocks = [];
    const textBlocks = [];
    entries.forEach((entry) => {
      const label = entry.role === 'user' ? 'User' : 'GPT';
      const bodyText = entry.text || stripHtml(entry.html);
      if (!bodyText.trim()) return;
      const cleanText = normalizeScratchText(bodyText).trim();
      textBlocks.push(`${label}:\n${cleanText}`.trim());
      const bodyHtml = entry.html && entry.html.trim()
        ? entry.html.trim()
        : htmlFromText(cleanText);
      const labelHtml = `<div><strong>${escapeHtml(label)}:</strong></div>`;
      blocks.push(`${labelHtml}${bodyHtml}`);
    });
    return {
      text: textBlocks.join('\n\n'),
      html: blocks.join('<br><br>')
    };
  };

  const findClosestRoleElement = (element, wantedRole) => {
    let current = element;
    while (current && current !== document.body) {
      const role = detectMessageRole(current);
      if (role) {
        if (!wantedRole || role === wantedRole) {
          return { element: current, role };
        }
        return { element: current, role };
      }
      current = current.parentElement;
    }
    return null;
  };

  const findAnswerElement = (element) => {
    if (!element) return null;
    const roleMatch = findClosestRoleElement(element, 'assistant');
    if (roleMatch?.role === 'assistant') return roleMatch.element;
    if (roleMatch?.role === 'user') return null;
    return element.closest(
      '[data-message-author-role="assistant"], [data-author-role="assistant"], [data-role="assistant"], [data-testid*="answer" i], [data-testid*="response" i], .prose, article, [role="article"]'
    ) || element;
  };

  const runInlinePicker = (mode = 'text') =>
    new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = 'codex-notes-inline-picker';
      overlay.style.cssText = `
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 2147483647;
      `;
      const highlight = document.createElement('div');
      highlight.style.cssText = `
        position: absolute;
        border: 2px solid #ff6b3d;
        background: rgba(255, 107, 61, 0.12);
        box-shadow: 0 0 0 3px rgba(255, 107, 61, 0.18);
        border-radius: 6px;
        transition: all 0.05s ease;
      `;
      overlay.appendChild(highlight);
      document.documentElement.appendChild(overlay);

      const cursorStyle = document.createElement('style');
      cursorStyle.textContent = '* { cursor: crosshair !important; }';
      document.documentElement.appendChild(cursorStyle);

      const cleanup = () => {
        document.removeEventListener('mousemove', handleMove, true);
        document.removeEventListener('click', handleClick, true);
        document.removeEventListener('keydown', handleKeydown, true);
        overlay.remove();
        cursorStyle.remove();
      };

      const isIgnoredTarget = (element) => {
        if (!element) return true;
        if (element === document.documentElement || element === document.body) return true;
        if (element.closest?.('#codex-notes-sidebar-host')) return true;
        if (element.closest?.('#codex-notes-inline-picker')) return true;
        return false;
      };

      const resolveTarget = (event) => {
        const node = event.target;
        const element = node?.nodeType === 1 ? node : node?.parentElement;
        if (!element || isIgnoredTarget(element)) return null;
        return element;
      };

      const updateHighlight = (element) => {
        if (!element) return;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) {
          highlight.style.opacity = '0';
          return;
        }
        highlight.style.opacity = '1';
        highlight.style.top = `${rect.top}px`;
        highlight.style.left = `${rect.left}px`;
        highlight.style.width = `${rect.width}px`;
        highlight.style.height = `${rect.height}px`;
      };

      const buildPayload = (element) => {
        if (!element) return null;
        if (mode === 'text') {
          const selection = getSelectionContent();
          const text = selection?.text || (element.innerText || element.textContent || '').trim();
          const html = selection?.html || buildInlineHtml(element);
          if (!text.trim() && !html.trim()) {
            return { ok: false, error: 'No text found', title: document.title, url: window.location.href };
          }
          return {
            ok: true,
            mode,
            text: text.trim(),
            html: String(html || '').trim(),
            title: document.title,
            url: window.location.href
          };
        }
        if (mode === 'answer') {
          const target = findAnswerElement(element);
          if (!target) {
            return { ok: false, error: 'Pick an answer', title: document.title, url: window.location.href };
          }
          const text = getElementText(target);
          const html = buildInlineHtml(target);
          if (!text.trim() && !html.trim()) {
            return { ok: false, error: 'No answer found', title: document.title, url: window.location.href };
          }
          return {
            ok: true,
            mode,
            text: text.trim(),
            html: String(html || '').trim(),
            title: document.title,
            url: window.location.href
          };
        }
        return {
          ok: false,
          error: 'Unsupported pick mode',
          title: document.title,
          url: window.location.href
        };
      };

      const handleMove = (event) => {
        const target = resolveTarget(event);
        if (!target) return;
        updateHighlight(target);
      };

      const handleClick = (event) => {
        if (event.button !== 0) return;
        const target = resolveTarget(event);
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        const payload = buildPayload(target);
        cleanup();
        resolve(payload);
      };

      const handleKeydown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cleanup();
          resolve(null);
        }
      };

      document.addEventListener('mousemove', handleMove, true);
      document.addEventListener('click', handleClick, true);
      document.addEventListener('keydown', handleKeydown, true);
    });

  const appendToNotes = (content, meta) => {
    const payload = typeof content === 'string' ? { text: content } : (content || {});
    const text = normalizeScratchText(payload.text || '');
    const rawHtml = String(payload.html || '');
    const html = sanitizeHtmlFragment(rawHtml);
    if (!text.trim() && !html.trim()) return false;
    state.hasUserInput = true;
    const existingText = getScratchPlainText();
    const existingHtml = getScratchHtml();
    const hasContent = existingText.trim().length > 0 || existingHtml.trim().length > 0;
    const headerLine = hasContent ? '' : buildHeaderLine(meta);
    const headerHtml = headerLine ? `${htmlFromText(headerLine)}<br><br>` : '';
    const bodyHtml = html || htmlFromText(text);
    const entryHtml = `${headerHtml}${bodyHtml}`;
    const prefixHtml = hasContent ? '<br><br>' : '';
    setScratchHtml(`${existingHtml}${prefixHtml}${entryHtml}`);
    scheduleSave();
    return true;
  };

  const startPicker = async (mode) => {
    if (state.pickerActive) {
      showStatus('Picker already active');
      return;
    }
    state.pickerActive = true;
    showStatus('Pick an element on the page');
    const picker = globalThis.CodexElementPicker?.startPick;
    try {
      const result = picker
        ? await picker({ mode })
        : await runInlinePicker(mode);
      state.pickerActive = false;
      if (!result) {
        showStatus('Picker cancelled');
        return;
      }
      if (result.ok === false) {
        showStatus(result.error || 'No text found');
        return;
      }
      if (appendToNotes({ text: result.text, html: result.html }, { title: result.title, url: result.url })) {
        showStatus('Added to notes');
      } else {
        showStatus('No text found');
      }
    } catch (error) {
      state.pickerActive = false;
      showStatus('Picker cancelled');
    }
  };

  const getSelectionContent = () => {
    const selection = globalThis.getSelection?.();
    if (!selection) return null;
    const text = selection.toString() || '';
    if (!text.trim()) return null;
    let html = '';
    if (selection.rangeCount) {
      const range = selection.getRangeAt(0);
      html = buildSelectionHtmlWithStyles(range);
    }
    return {
      text: text.trim(),
      html: html.trim()
    };
  };

  const appendSelection = () => {
    const selection = getSelectionContent();
    if (!selection) {
      showStatus('No selection');
      return;
    }
    appendToNotes(selection, { title: document.title, url: window.location.href });
    showStatus('Selection added');
  };

  const appendConversation = () => {
    const entries = buildConversationEntries();
    if (!entries.length) {
      showStatus('No messages found');
      return;
    }
    const payload = formatConversationPayload(entries);
    if (appendToNotes(payload, { title: document.title, url: window.location.href })) {
      showStatus('Added conversation');
    } else {
      showStatus('No messages found');
    }
  };

  const pickAnswer = async () => {
    if (state.pickerActive) {
      showStatus('Picker already active');
      return;
    }
    state.pickerActive = true;
    showStatus('Pick an answer on the page');
    try {
      const result = await runInlinePicker('answer');
      state.pickerActive = false;
      if (!result) {
        showStatus('Picker cancelled');
        return;
      }
      if (result.ok === false) {
        showStatus(result.error || 'No answer found');
        return;
      }
      const payload = formatConversationPayload([
        { role: 'assistant', text: result.text, html: result.html }
      ]);
      if (appendToNotes(payload, { title: result.title, url: result.url })) {
        showStatus('Answer added');
      } else {
        showStatus('No answer found');
      }
    } catch (error) {
      state.pickerActive = false;
      showStatus('Picker cancelled');
    }
  };

  const isLikelyNoteId = (value, types = []) => {
    const text = String(value || '').trim();
    if (!text) return false;
    if (types.includes('text/html')) return false;
    if (text.startsWith('notes_')) return true;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text);
  };

  const extractDroppedContent = (event) => {
    const dt = event?.dataTransfer;
    if (!dt) return { text: '', html: '' };
    const types = Array.from(dt.types || []);
    const raw = dt.getData?.(DRAG_MIME);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.text) {
          return {
            text: String(parsed.text || '').trim(),
            html: String(parsed.html || '').trim()
          };
        }
      } catch (_) {}
    }
    const plain = dt.getData?.('text/plain');
    if (plain) {
      if (isLikelyNoteId(plain, types)) return { text: '', html: '' };
      const html = dt.getData?.('text/html') || '';
      return {
        text: String(plain || '').trim(),
        html: String(html || '').trim()
      };
    }
    const html = dt.getData?.('text/html');
    if (!html) return { text: '', html: '' };
    return { text: stripHtml(html), html: String(html || '').trim() };
  };

  const canAcceptScratchDrop = (event) => {
    const types = Array.from(event?.dataTransfer?.types || []);
    return types.includes(DRAG_MIME) || types.includes('text/plain') || types.includes('text/html');
  };

  const handleScratchDragOver = (event) => {
    if (!canAcceptScratchDrop(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  };

  const handleScratchDrop = async (event, { openPanel = false } = {}) => {
    if (!event) return;
    event.preventDefault();
    event.stopPropagation();
    const payload = extractDroppedContent(event);
    const text = String(payload?.text || '').trim();
    const html = String(payload?.html || '').trim();
    if (!text && !html) {
      showStatus('No text dropped');
      return;
    }
    if (state.scratchLoading) {
      showStatus('Loading notes…');
    }
    await loadScratch();
    if (appendToNotes({ text, html }, { title: document.title, url: window.location.href })) {
      showStatus('Dropped');
    } else {
      showStatus('Drop failed');
    }
    if (openPanel && !state.open) {
      setOpen(true);
    }
  };

  const buildHtmlFromText = (text) => {
    const escaped = escapeHtml(text);
    return `<div>${escaped.replace(/\n/g, '<br>')}</div>`;
  };

  const buildHtmlDocument = (bodyHtml, title = 'Scratch') => {
    const safeTitle = escapeHtml(title);
    const body = bodyHtml || '';
    return [
      '<!doctype html>',
      '<html>',
      '<head>',
      '<meta charset="utf-8">',
      `<title>${safeTitle}</title>`,
      '</head>',
      '<body>',
      body,
      '</body>',
      '</html>'
    ].join('');
  };

  const formatExportFilename = (value = new Date()) => {
    const date = value instanceof Date ? value : new Date(value);
    const pad = (num) => String(num).padStart(2, '0');
    return `scratch-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.html`;
  };

  const downloadScratchHtml = (text, htmlBody) => {
    if (!document.body) return false;
    const title = buildScratchTitle(text);
    const body = htmlBody && htmlBody.trim() ? htmlBody : buildHtmlFromText(text);
    const html = buildHtmlDocument(body, title);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = formatExportFilename();
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return true;
  };

  const copyWithExecCommand = (text, html) => {
    if (!document.body) return false;
    const container = document.createElement('div');
    container.setAttribute('contenteditable', 'true');
    container.style.position = 'fixed';
    container.style.left = '-9999px';
    container.style.top = '0';
    container.style.opacity = '0';
    container.style.pointerEvents = 'none';
    container.innerHTML = html;

    const handleCopy = (event) => {
      if (!event.clipboardData) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', text);
      event.clipboardData.setData('text/html', html);
    };

    container.addEventListener('copy', handleCopy);
    document.body.appendChild(container);

    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(container);
    selection?.removeAllRanges();
    selection?.addRange(range);

    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (error) {
      ok = false;
    }

    selection?.removeAllRanges();
    container.removeEventListener('copy', handleCopy);
    container.remove();
    return ok;
  };

  const copyScratchHtml = async (text, htmlBody) => {
    const html = htmlBody && htmlBody.trim() ? htmlBody : buildHtmlFromText(text);
    if (navigator.clipboard?.write && globalThis.ClipboardItem) {
      try {
        const item = new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' })
        });
        await navigator.clipboard.write([item]);
        return true;
      } catch (error) {
        console.warn('[notes-sidebar] clipboard write failed', error);
      }
    }
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (error) {
        console.warn('[notes-sidebar] clipboard text failed', error);
      }
    }
    return copyWithExecCommand(text, html);
  };

  const exportScratchHtml = async () => {
    if (state.scratchLoading) {
      showStatus('Loading notes…');
      return;
    }
    await loadScratch();
    if (!notesEditor) {
      showStatus('Notes unavailable');
      return;
    }
    const text = getScratchPlainText();
    const htmlBody = getScratchExportHtml();
    if (!text.trim()) {
      showStatus('No content');
      return;
    }
    try {
      const downloaded = downloadScratchHtml(text, htmlBody);
      if (downloaded) {
        showStatus('HTML saved');
        return;
      }
      const copied = await copyScratchHtml(text, htmlBody);
      showStatus(copied ? 'HTML copied' : 'Export failed');
    } catch (error) {
      console.warn('[notes-sidebar] export failed', error);
      showStatus('Export failed');
    }
  };

  const saveScratch = async () => {
    if (state.scratchLoading) {
      showStatus('Loading notes…');
      return;
    }
    await loadScratch();
    if (!notesEditor) {
      showStatus('Notes unavailable');
      return;
    }
    const text = getScratchPlainText();
    if (!text.trim()) {
      showStatus('No content');
      return;
    }
    const html = sanitizeHtmlFragment(getScratchHtml());
    state.hasUserInput = true;

    if (state.savedNoteId) {
      try {
        await sendCommand(COMMANDS.NOTE_UPDATE_TEXT, { noteId: state.savedNoteId, text, html });
        setSavedStatus('Saved');
      } catch (error) {
        console.warn('[notes-sidebar] save failed', error);
        showStatus('Save failed');
      }
      return;
    }

    const title = buildScratchTitle(text);
    const activeTab = await getActiveNotesTab();
    const payload = { title, text, html };
    if (activeTab?.tabId) {
      payload.tabId = activeTab.tabId;
    }
    try {
      const created = await sendCommand(COMMANDS.NOTE_CREATE, payload);
      state.savedNoteId = created?.noteId || null;
      setSavedStatus('Saved');
    } catch (error) {
      console.warn('[notes-sidebar] save failed', error);
      showStatus('Save failed');
    }
  };

  const clearScratch = async ({ resetLink = false, silent = false } = {}) => {
    if (resetLink) state.savedNoteId = null;
    clearSavedStatus();
    if (state.scratchLoading) {
      if (!silent) showStatus('Loading notes…');
      return;
    }
    await loadScratch();
    if (!notesEditor) {
      if (!silent) showStatus('Notes unavailable');
      return;
    }
    if (!getScratchPlainText().trim()) {
      if (!silent) showStatus('Already empty');
      return;
    }
    state.hasUserInput = true;
    setScratchHtml('');
    if (!state.noteId) {
      if (!silent) showStatus('Cleared locally');
      return;
    }
    state.pendingSave = true;
    try {
      await sendCommand(COMMANDS.NOTE_UPDATE_TEXT, { noteId: state.noteId, text: '' });
      state.lastSavedText = '';
      if (!silent) showStatus('Cleared');
    } catch (error) {
      console.warn('[notes-sidebar] clear failed', error);
      if (!silent) showStatus('Clear failed');
    } finally {
      state.pendingSave = false;
    }
  };

  toggleBtn?.addEventListener('click', () => setOpen(!state.open));
  closeBtn?.addEventListener('click', () => setOpen(false));
  headerTitle?.addEventListener('dblclick', () => setExpanded(!state.expanded));
  notesTabBtn?.addEventListener('click', () => {
    stopSelectorRecord('cancel');
    setActiveTab('notes');
  });
  selectorsTabBtn?.addEventListener('click', () => setActiveTab('selectors'));

  selectorsHeaderButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-selectors-action');
      if (action === 'export') exportSelectorsJson();
      if (action === 'import') selectorsFileInput?.click();
      if (action === 'save-all') saveAllSelectors();
    });
  });
  selectorsPlatformSelect?.addEventListener('change', (event) => {
    const value = String(event.target?.value || '').trim();
    if (!value) return;
    stopSelectorRecord('cancel');
    setSelectorsPlatform(value);
    showSelectorsStatus('Platform updated');
  });
  selectorsFileInput?.addEventListener('change', (event) => {
    const file = event.target?.files?.[0];
    if (file) handleSelectorsImportFile(file);
    if (selectorsFileInput) selectorsFileInput.value = '';
  });

  actionButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-action');
      if (action === 'new-scratch') clearScratch({ resetLink: true, silent: true });
      if (action === 'append-selection') appendSelection();
      if (action === 'pick-text') startPicker('text');
      if (action === 'pick-answer') pickAnswer();
      if (action === 'append-conversation') appendConversation();
      if (action === 'export-html') exportScratchHtml();
      if (action === 'save-scratch') saveScratch();
      if (action === 'clear-scratch') clearScratch();
    });
  });

  setActiveTab(state.activeTab);

  notesEditor?.addEventListener('input', () => {
    state.hasUserInput = true;
    if (!getScratchPlainText().trim()) {
      setScratchHtml('');
    }
    scheduleSave();
  });

  notesEditor?.addEventListener('blur', () => {
    if (getScratchPlainText() !== state.lastSavedText) {
      scheduleSave();
    }
  });

  notesEditor?.addEventListener('dragover', handleScratchDragOver);
  notesEditor?.addEventListener('drop', (event) => handleScratchDrop(event));

  toggleBtn?.addEventListener('dragover', handleScratchDragOver);
  toggleBtn?.addEventListener('drop', (event) => handleScratchDrop(event, { openPanel: true }));

  globalThis.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || !event.shiftKey || event.code !== 'KeyS') return;
    event.preventDefault();
    setOpen(!state.open);
  });

  chrome.runtime?.onMessage?.addListener((message) => {
    if (!message) return;
    if (message.type === 'NOTES_EVENT') {
      if (message.event !== EVENTS.REVISION_BUMP) return;
      if (!state.tabId || message.tabId !== state.tabId) return;
      refreshScratch();
      return;
    }
    if (message.type === 'NOTES_SIDEBAR_TOGGLE') {
      setOpen(message.open ?? !state.open);
    }
  });
})();
