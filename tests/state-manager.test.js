const { JSDOM } = require('jsdom');

describe('StateManager basic invariants', () => {
  let StateManager;

  beforeAll(() => {
    const dom = new JSDOM(`<!DOCTYPE html><p>Hello</p>`, { url: 'https://example.com' });
    global.window = dom.window;
    global.document = dom.window.document;
    global.chrome = {
      storage: { local: { set: jest.fn(), get: jest.fn(() => ({})) } }
    };
    // load module
    jest.isolateModules(() => {
      require('../content-scripts/pragmatist-core.js');
      StateManager = global.window.PragmatistCore.StateManager;
    });
  });

  test('onStreamUpdate moves to completed when generation stops', async () => {
    const sm = new StateManager('s1', 'chatgpt');
    sm.onStreamUpdate('hello', true);
    expect(sm.getStatus()).toBe('generating');
    sm.onStreamUpdate('hello world', false);
    expect(sm.getStatus()).toBe('completed');
  });

  test('debounced save respects size guard', async () => {
    jest.useFakeTimers();
    const sm = new StateManager('s2', 'chatgpt');
    sm.onStreamUpdate('x'.repeat(2048), true);
    sm.onStreamUpdate('x'.repeat(2048), false);
    jest.runAllTimers();
    // should not throw; length limited by guard in core
    expect(typeof sm.getText()).toBe('string');
    jest.useRealTimers();
  });
});
