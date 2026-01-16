const { JSDOM } = require('jsdom');

describe('Integration: StreamWatcher + StateManager', () => {
  let StreamWatcher;
  let StateManager;

  beforeEach(() => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="root"></div></body></html>`, { url: 'https://example.com' });
    global.window = dom.window;
    global.document = dom.window.document;
    global.MutationObserver = dom.window.MutationObserver;
    global.Node = dom.window.Node;
    global.chrome = { storage: { local: { set: jest.fn(), get: jest.fn(async () => ({})) } } };

    jest.isolateModules(() => {
      require('../content-scripts/pragmatist-core.js');
      StreamWatcher = global.window.PragmatistCore.StreamWatcher;
      StateManager = global.window.PragmatistCore.StateManager;
    });
  });

  test('mutation triggers state update with debounced processing', async () => {
    jest.useFakeTimers();
    // Подготовим контейнер ответа
    const respNode = document.createElement('div');
    respNode.id = 'resp';
    document.body.appendChild(respNode);
    const adapter = {
      selectors: { responseContainer: '#resp' },
      extractResponseText: jest.fn(() => 'hello world'),
      isGenerating: jest.fn(() => true)
    };
    const sm = new StateManager('sess-int', 'chatgpt');
    const watcher = new StreamWatcher(adapter, sm);

    // Подготовили контейнер, connect должен сработать (если нет — пробуем reconnect)
    const connected = watcher.connect() || watcher.reconnect();
    expect(connected).toBeTruthy();
    const resp = document.querySelector('#resp');
    expect(resp).not.toBeNull();
    if (resp) {
      resp.textContent = 'hello world';
    }

    const node = document.createElement('span');
    node.textContent = '!';
    resp.appendChild(node);

    watcher._process();
    await Promise.resolve();
    jest.advanceTimersByTime(400); // flush debounce but не доводим completion до завершения
    expect(adapter.extractResponseText).toHaveBeenCalled();
    expect(sm.getText()).toBe('hello world');
    expect(sm.getStatus()).toBe('generating');
    watcher.disconnect();
    jest.useRealTimers();
  });
});
