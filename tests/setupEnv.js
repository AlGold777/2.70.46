// Mock chrome.runtime messaging used inside selector-manager.
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

// jsdom не реализует scrollBy; в тестах глушим
if (typeof window !== 'undefined') {
  window.scrollBy = window.scrollBy || (() => {});
}

global.chrome = {
  runtime: {
    sendMessage: jest.fn(),
    lastError: null
  },
  storage: {
    local: {
      _store: new Map(),
      async get(key) {
        if (key === null) {
          const obj = {};
          this._store.forEach((value, k) => { obj[k] = value; });
          return obj;
        }
        if (typeof key === 'string') {
          return { [key]: this._store.get(key) };
        }
        const result = {};
        Object.keys(key || {}).forEach((k) => {
          result[k] = this._store.get(k) ?? key[k];
        });
        return result;
      },
      async set(obj) {
        Object.entries(obj || {}).forEach(([k, v]) => {
          this._store.set(k, v);
        });
      },
      async remove(keys) {
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => this._store.delete(k));
      }
    },
    onChanged: {
      addListener: jest.fn()
    }
  }
};
