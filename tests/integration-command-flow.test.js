const { JSDOM } = require('jsdom');

describe('Integration: CommandExecutor + StateManager', () => {
  let CommandExecutor;
  let StateManager;
  let chromeStore;

  beforeEach(() => {
    const dom = new JSDOM(`<!DOCTYPE html><p>Hi</p>`, { url: 'https://example.com' });
    global.window = dom.window;
    global.document = dom.window.document;
    global.MutationObserver = dom.window.MutationObserver;
    chromeStore = {};
    global.chrome = {
      storage: {
        local: {
          async get(key) {
            if (!key) return chromeStore;
            return { [key]: chromeStore[key] };
          },
          async set(obj) {
            Object.assign(chromeStore, obj);
          }
        },
        onChanged: { addListener: jest.fn(), removeListener: jest.fn() }
      },
      runtime: { sendMessage: jest.fn() }
    };
    jest.isolateModules(() => {
      require('../content-scripts/pragmatist-core.js');
      CommandExecutor = global.window.PragmatistCore.CommandExecutor;
      StateManager = global.window.PragmatistCore.StateManager;
    });
  });

  test('executes pending command for matching platform and writes ACK with platform', async () => {
    const adapter = {
      name: 'grok',
      submitPrompt: jest.fn(),
      stopGeneration: jest.fn()
    };
    const sm = new StateManager('sess-int-cmd', 'grok');
    const exec = new CommandExecutor(adapter, sm);
    const pending = {
      id: 'cmd123',
      action: 'submit_prompt',
      payload: { prompt: 'hello', platforms: ['grok'] },
      createdAt: Date.now()
    };
    chromeStore.pending_command = pending;
    await exec._check();
    expect(adapter.submitPrompt).toHaveBeenCalledWith('hello');
    const ackKey = `cmd_ack_${pending.id}_${sm.getSessionId()}`;
    expect(chromeStore[ackKey]).toBeDefined();
    expect(chromeStore[ackKey].platform).toBe('grok');
  });

  test('skips pending command for other platform', async () => {
    const adapter = {
      name: 'grok',
      submitPrompt: jest.fn(),
      stopGeneration: jest.fn()
    };
    const sm = new StateManager('sess-int-cmd2', 'grok');
    const exec = new CommandExecutor(adapter, sm);
    chromeStore.pending_command = {
      id: 'cmd999',
      action: 'submit_prompt',
      payload: { prompt: 'hi', platforms: ['claude'] },
      createdAt: Date.now()
    };
    await exec._check();
    expect(adapter.submitPrompt).not.toHaveBeenCalled();
    const ackKey = `cmd_ack_cmd999_${sm.getSessionId()}`;
    expect(chromeStore[ackKey]).toBeUndefined();
  });
});
