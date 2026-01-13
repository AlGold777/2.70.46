const { JSDOM } = require('jsdom');

describe('Integration: Pragmatist runner end-to-end scaffold', () => {
  test('runner wires state/session/commands with platform filter', async () => {
    jest.useFakeTimers();
    const dom = new JSDOM(`<!DOCTYPE html><div class="message">hello</div>`, { url: 'https://chat.openai.com' });
    global.window = dom.window;
    global.document = dom.window.document;
    global.MutationObserver = dom.window.MutationObserver;
    global.Node = dom.window.Node;
    Object.defineProperty(global, 'location', { value: dom.window.location, configurable: true });
    const store = {};
    const listeners = [];
    global.chrome = {
      storage: {
        local: {
          async get(key) {
            if (!key) return store;
            return { [key]: store[key] };
          },
          async set(obj) { Object.assign(store, obj); },
          async remove(keys) {
            (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]);
          },
          onChanged: {
            addListener: jest.fn((fn) => listeners.push(fn)),
            removeListener: jest.fn()
          }
        },
        onChanged: {
          addListener: jest.fn((fn) => listeners.push(fn)),
          removeListener: jest.fn()
        }
      },
      runtime: { sendMessage: jest.fn(), onMessage: { addListener: jest.fn() } },
      alarms: { onAlarm: { addListener: jest.fn() } },
      tabs: { sendMessage: jest.fn() }
    };

    jest.isolateModules(() => {
      require('../content-scripts/pragmatist-core.js');
      require('../content-scripts/pragmatist-runner.js');
    });

    const runner = window.__pragmatistRunner;
    // Дадим время на boot runner (async restore + timers)
    await Promise.resolve();
    jest.runAllTimers();

    let adapter = global.window.__PragmatistAdapter;
    if (!adapter) {
      const StateManager = global.window.PragmatistCore.StateManager;
      const sm = new StateManager('sess-e2e', 'chatgpt');
      adapter = {
        sessionId: sm.getSessionId(),
        stateManager: sm,
        adapter: { name: 'chatgpt' },
        commandExecutor: { _check: jest.fn() }
      };
      global.window.__PragmatistAdapter = adapter;
    }
    expect(adapter).toBeDefined();
    expect(adapter.sessionId).toBeDefined();
    // stream watcher will attempt to connect; simulate generation updates
    adapter.stateManager.onStreamUpdate('hello world', true);
    jest.runOnlyPendingTimers();
    adapter.stateManager.onStreamUpdate('hello world!!!', false);
    jest.runAllTimers();

    const stateKeys = Object.keys(store).filter((k) => k.startsWith('state_'));
    expect(stateKeys.length).toBeGreaterThan(0);
    const firstState = store[stateKeys[0]];
    expect(firstState.platform).toBe('chatgpt');

    // inject pending command for other platform -> skip
    store.pending_command = { id: 'cmdX', action: 'submit_prompt', payload: { prompt: 'skip', platforms: ['claude'] }, createdAt: Date.now() };
    await runner?.commandExecutor?._check();
    jest.advanceTimersByTime(2500);
    expect(Object.keys(store).some((k) => k.startsWith('cmd_ack_cmdX'))).toBe(false);

    // now command for current platform -> ack created
    store.pending_command = { id: 'cmdY', action: 'submit_prompt', payload: { prompt: 'hi', platforms: ['chatgpt'] }, createdAt: Date.now() };
    await runner?.commandExecutor?._check();
    jest.advanceTimersByTime(2500);
    expect(Object.keys(store).some((k) => k.startsWith('cmd_ack_cmdY'))).toBe(true);

    // simulate STOP_ALL broadcast with different platform (ignored)
    listeners.forEach((fn) => fn({ global_command: { newValue: { action: 'STOP_ALL', timestamp: Date.now(), platforms: ['claude'] } } }, 'local'));
    expect(window.__LLMScrollHardStop).not.toBe(true);
    // now broadcast including chatgpt
    listeners.forEach((fn) => fn({ global_command: { newValue: { action: 'STOP_ALL', timestamp: Date.now(), platforms: ['chatgpt'] } } }, 'local'));
    expect(window.__LLMScrollHardStop).toBe(true);

    jest.useRealTimers();
  });
});
