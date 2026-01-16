// Embedded Pragmatist v2.0 budgets and write contracts
// This file defines global constants used across background/content scripts
// to enforce rate limits, debounce intervals, TTLs, and allowed storage keys.

(function initPragmatistBudgets() {
  const root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
  if (root.__PRAGMATIST_BUDGETS) return;

  root.__PRAGMATIST_BUDGETS = {
    storage: {
      writeQPS: 1,            // use 1 of ~10 QPS budget
      maxKeys: 50,
      maxValueSize: 1024      // 1KB metadata, no raw text
    },
    memory: {
      perTabBytes: 20 * 1024 * 1024,
      textBufferBytes: 5 * 1024 * 1024
    },
    timing: {
      debounceStorage: 2000,
      debounceLocalStorage: 1000,
      navigationPollInterval: 1000,
      commandPollInterval: 2000,
      foregroundTimeout: 500,
      backgroundTimeout: 3000,
      commandTTL: 60000,
      ackTTL: 300000
    },
    cpu: {
      maxBlockingMs: 50
    }
  };

  root.__PRAGMATIST_WRITE_CONTRACTS = {
    contentScript: ['state_<sessionId>', 'cmd_ack_<cmdId>_<sessionId>'],
    serviceWorker: ['pending_command', 'global_command'],
    popup: ['settings']
  };
})();
