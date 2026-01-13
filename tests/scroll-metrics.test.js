const { JSDOM } = require('jsdom');

describe('ScrollToolkit metrics hook', () => {
  beforeEach(() => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body><div style="height:2000px"></div></body></html>`, { url: 'https://example.com' });
    global.window = dom.window;
    global.document = dom.window.document;
    global.Node = dom.window.Node;
    // provide scrollBy spy
    window.scrollBy = jest.fn();
    jest.isolateModules(() => {
      require('../scroll-toolkit.js');
    });
  });

  test('micro jitter emits two events and uses scrollBy twice', () => {
    const events = [];
    window.__setScrollEventHook((e) => events.push(e));
    const Toolkit = window.__UniversalScrollToolkit;
    const tk = new Toolkit({ jitterRange: [2, 2] });
    tk._testMicroJitter();
    expect(window.scrollBy).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.origin === 'micro_jitter').length).toBe(2);
  });
});
