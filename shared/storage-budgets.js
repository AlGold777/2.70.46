// shared/storage-budgets.js
// Pure helper to compute storage cleanup/removal decisions for Pragmatist budgets.
(function initStorageBudgets() {
  const computeStorageCleanup = (all = {}, opts = {}) => {
    const now = opts.now || Date.now();
    const timing = opts.timing || {};
    const storage = opts.storage || {};
    const ackTtl = timing.ackTTL ?? 300000; // 5m
    const cmdTtl = timing.commandTTL ?? 60000; // 60s
    const maxStateAge = timing.stateTTL ?? 24 * 60 * 60 * 1000;
    const maxKeys = storage.maxKeys ?? 50;

    const removals = [];
    const updates = {};
    const stateEntries = [];

    Object.entries(all || {}).forEach(([key, value]) => {
      if (key.startsWith('cmd_ack_')) {
        const ts = value?.executedAt || value?.ts || 0;
        if (ts && now - ts > ackTtl) removals.push(key);
      } else if (key === 'pending_command') {
        const ts = value?.createdAt || 0;
        if (ts && now - ts > cmdTtl) removals.push(key);
      } else if (key.startsWith('state_')) {
        const ts = value?.updatedAt || 0;
        stateEntries.push({ key, ts });
        if (ts && now - ts > maxStateAge) removals.push(key);
      } else if (key === '__diagnostics_events__') {
        const arr = Array.isArray(value) ? value : [];
        const fresh = arr.filter((e) => (now - (e?.ts || 0)) < maxStateAge);
        if (fresh.length !== arr.length) {
          updates[key] = fresh;
        }
      }
    });

    if (stateEntries.length > maxKeys) {
      stateEntries.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const extra = stateEntries.length - maxKeys;
      const drop = stateEntries.slice(0, extra).map((e) => e.key);
      removals.push(...drop);
    }

    return { removals: Array.from(new Set(removals)), updates };
  };

  if (typeof module !== 'undefined') {
    module.exports = { computeStorageCleanup };
  }
  if (typeof globalThis !== 'undefined' && !globalThis.computeStorageCleanup) {
    globalThis.computeStorageCleanup = computeStorageCleanup;
  }
})();
