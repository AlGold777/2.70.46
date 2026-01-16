(() => {
  if (globalThis.NotesConstants) return;

  const NOTES_DB_NAME = 'codex_notes';
  const NOTES_DB_VERSION = 1;

  const STORES = {
    META: 'meta',
    TABS: 'tabs',
    NODES: 'nodes',
    CHUNKS: 'contentChunks',
    OPLOG: 'oplog',
    TASKS: 'tasks',
    BACKUP_STATE: 'backupState',
    SEARCH_INDEX: 'searchIndex_v1',
    NOTE_TOKENS: 'noteTokens'
  };

  const DEFAULT_TAB_NAME = 'Home';
  const DEFAULT_CHUNK_SIZE = 65536;
  const DEFAULT_ORDER_STEP = 1000n;

  const COMMANDS = {
    INIT: 'NOTES_INIT',
    TAB_LIST: 'TAB_LIST',
    TAB_CREATE: 'TAB_CREATE',
    TAB_RENAME: 'TAB_RENAME',
    TAB_DELETE: 'TAB_DELETE',
    NOTE_CREATE: 'NOTE_CREATE',
    NOTE_GET: 'NOTE_GET',
    NOTE_LIST_CHILDREN: 'NOTE_LIST_CHILDREN',
    NOTE_UPDATE_TEXT: 'NOTE_UPDATE_TEXT',
    NOTE_MOVE: 'NOTE_MOVE',
    NOTE_DELETE: 'NOTE_DELETE',
    NOTE_GET_OR_CREATE_SCRATCH: 'NOTE_GET_OR_CREATE_SCRATCH'
  };

  const EVENTS = {
    REVISION_BUMP: 'REVISION_BUMP',
    TASK_PROGRESS: 'TASK_PROGRESS',
    BACKUP_HEALTH: 'BACKUP_HEALTH'
  };

  globalThis.NotesConstants = {
    NOTES_DB_NAME,
    NOTES_DB_VERSION,
    STORES,
    DEFAULT_TAB_NAME,
    DEFAULT_CHUNK_SIZE,
    DEFAULT_ORDER_STEP,
    COMMANDS,
    EVENTS
  };
})();
