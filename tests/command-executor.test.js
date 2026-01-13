const { JSDOM } = require('jsdom');

describe('CommandExecutor invariants', () => {
  let CommandExecutor;
  let StateManager;
  let adapter;

  beforeAll(() => {
    const dom = new JSDOM(`<!DOCTYPE html><p>Hello</p>`, { url: 'https://example.com' });
    global.window = dom.window;
    global.document = dom.window.document;
    global.chrome = {
      storage: {
        local: {
          set: jest.fn(),
          get: jest.fn(async () => ({}))
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
    adapter = { name: 'chatgpt', submitPrompt: jest.fn(), stopGeneration: jest.fn() };
  });

  beforeEach(() => {
    global.chrome.storage.local.set.mockClear();
    global.chrome.storage.local.get.mockClear();
    global.chrome.runtime.sendMessage.mockClear();
    global.window.__LLMScrollHardStop = false;
  });

  test('skips execution when hard-stopped', async () => {
    global.window.__LLMScrollHardStop = true;
    const sm = new StateManager('s2', 'chatgpt');
    const exec = new CommandExecutor(adapter, sm);
    await exec._check();
    expect(adapter.submitPrompt).not.toHaveBeenCalled();
  });

  test('skips expired command by TTL and platform filter', async () => {
    global.window.__LLMScrollHardStop = false;
    const sm = new StateManager('s3', 'chatgpt');
    const exec = new CommandExecutor(adapter, sm);
    const old = Date.now() - 120000;
    global.chrome.storage.local.get.mockResolvedValueOnce({
      pending_command: { id: 'cmd1', action: 'submit_prompt', createdAt: old, payload: { prompt: 'hello', platforms: ['claude'] } }
    });
    await exec._check();
    expect(adapter.submitPrompt).not.toHaveBeenCalled();
  });

  test('writes ACK with platform on success', async () => {
    global.window.__LLMScrollHardStop = false;
    const sm = new StateManager('s4', 'chatgpt');
    const exec = new CommandExecutor(adapter, sm);
    const pending = {
      id: 'cmd-ok',
      action: 'submit_prompt',
      payload: { prompt: 'hi', platforms: ['chatgpt'] },
      createdAt: Date.now()
    };
    await exec._execute(pending);
    const ackKey = `cmd_ack_${pending.id}_${sm.getSessionId()}`;
    const ackCall = global.chrome.storage.local.set.mock.calls.reverse().find((c) => c && c[0] && c[0][ackKey]);
    expect(ackCall).toBeTruthy();
    const ackObj = ackCall[0][ackKey];
    expect(ackObj.platform).toBe('chatgpt');
    expect(ackObj.commandId).toBe('cmd-ok');
  });
});
