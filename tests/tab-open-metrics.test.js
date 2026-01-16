const { JSDOM } = require('jsdom');

describe('NavigationDetector tab/open timing', () => {
  let NavigationDetector;

  beforeEach(() => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, { url: 'https://chat.openai.com/?q=1' });
    global.window = dom.window;
    global.document = dom.window.document;
    // jsdom navigation setters выбрасывают not implemented; клонируем объект
    global.location = { pathname: '/?q=1', search: '?q=1' };
    jest.useFakeTimers();
    jest.isolateModules(() => {
      require('../content-scripts/pragmatist-core.js');
      NavigationDetector = window.PragmatistCore.NavigationDetector;
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('fires onNavigate when pathname differs on check', () => {
    const onNavigate = jest.fn();
    const detector = new NavigationDetector(onNavigate);
    detector.start();
    detector.lastPath = '/old';
    detector._check();
    expect(onNavigate).toHaveBeenCalledTimes(1);
    detector.stop();
  });

  test('fires onNavigate when search differs on check', () => {
    const onNavigate = jest.fn();
    const detector = new NavigationDetector(onNavigate);
    detector.start();
    detector.lastSearch = '?old';
    detector._check();
    expect(onNavigate).toHaveBeenCalledTimes(1);
    detector.stop();
  });
});
