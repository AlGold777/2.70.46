(() => {
  if (globalThis.NotesClient) return;

  const { NotesConstants } = globalThis;
  if (!NotesConstants) {
    console.warn('[NotesClient] NotesConstants missing');
    return;
  }

  const { COMMANDS, EVENTS } = NotesConstants;

  const sendCommand = (command, payload = {}) =>
    new Promise((resolve, reject) => {
      if (!globalThis.chrome?.runtime?.sendMessage) {
        reject(new Error('chrome.runtime is unavailable'));
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

  const eventHandlers = new Set();

  if (globalThis.chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== 'NOTES_EVENT') return;
      eventHandlers.forEach((handler) => {
        try {
          handler(message);
        } catch (error) {
          console.warn('[NotesClient] handler failed', error);
        }
      });
    });
  }

  const onEvent = (handler) => {
    if (typeof handler !== 'function') return () => {};
    eventHandlers.add(handler);
    return () => eventHandlers.delete(handler);
  };

  const call = (command, payload) => sendCommand(command, payload);

  globalThis.NotesClient = {
    EVENTS,
    onEvent,
    init: () => call(COMMANDS.INIT),
    listTabs: () => call(COMMANDS.TAB_LIST),
    createTab: (payload) => call(COMMANDS.TAB_CREATE, payload),
    renameTab: (payload) => call(COMMANDS.TAB_RENAME, payload),
    deleteTab: (payload) => call(COMMANDS.TAB_DELETE, payload),
    createNote: (payload) => call(COMMANDS.NOTE_CREATE, payload),
    getNote: (payload) => call(COMMANDS.NOTE_GET, payload),
    listChildren: (payload) => call(COMMANDS.NOTE_LIST_CHILDREN, payload),
    updateNoteText: (payload) => call(COMMANDS.NOTE_UPDATE_TEXT, payload),
    moveNote: (payload) => call(COMMANDS.NOTE_MOVE, payload),
    deleteNote: (payload) => call(COMMANDS.NOTE_DELETE, payload),
    getOrCreateScratch: (payload) => call(COMMANDS.NOTE_GET_OR_CREATE_SCRATCH, payload)
  };
})();
