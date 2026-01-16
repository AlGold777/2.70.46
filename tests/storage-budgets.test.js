const { computeStorageCleanup } = require('../shared/storage-budgets.js');

describe('Storage budgets (cleanup + guard)', () => {
  test('maxKeys eviction and TTL pruning for state/ack/pending', () => {
    const now = Date.now();
    const states = Array.from({ length: 55 }).reduce((acc, _, idx) => {
      acc[`state_tab_${idx}`] = { updatedAt: now - idx * 1000 };
      return acc;
    }, {});
    const data = Object.assign({
      'cmd_ack_old': { executedAt: now - 400000 },
      'cmd_ack_fresh': { executedAt: now - 1000 },
      pending_command: { createdAt: now - 120000 },
      '__diagnostics_events__': [{ ts: now - 1000 }, { ts: now - 25 * 60 * 60 * 1000 }]
    }, states);

    const { removals, updates } = computeStorageCleanup(data, {
      now,
      timing: { ackTTL: 300000, commandTTL: 60000, stateTTL: 24 * 60 * 60 * 1000 },
      storage: { maxKeys: 50 }
    });

    expect(removals).toContain('cmd_ack_old');
    expect(removals).toContain('pending_command');
    // Oldest states beyond maxKeys should be evicted
    expect(removals.some((k) => k.startsWith('state_tab_'))).toBe(true);
    expect(updates['__diagnostics_events__']).toHaveLength(1);
  });

  test('StateManager guard keeps storage payload within budget and debounces writes', async () => {
    jest.useFakeTimers();
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!DOCTYPE html><div></div>', { url: 'https://example.com' });
    global.window = dom.window;
    global.document = dom.window.document;
    const setCalls = [];
    global.chrome = {
      storage: { local: { set: async (obj) => setCalls.push(obj), get: async () => ({}) } }
    };
    jest.isolateModules(() => {
      require('../content-scripts/pragmatist-core.js');
      const StateManager = global.window.PragmatistCore.StateManager;
      const sm = new StateManager('sess-bgt', 'chatgpt');
      sm.onStreamUpdate('hello', true);
      sm.onStreamUpdate('hello world'.repeat(200), false); // big text, preview trimmed
      jest.runAllTimers();
    });
    jest.useRealTimers();
    // Теперь допускаем одно дополнительное срабатывание из-за троттлинга стриминга
    expect(setCalls.length).toBeLessThanOrEqual(3);
    const payload = Object.values(setCalls.pop())[0];
    expect(payload.preview.length).toBeLessThanOrEqual(512);
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(1024);
  });
});
