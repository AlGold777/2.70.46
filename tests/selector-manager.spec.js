const fs = require('fs');
const path = require('path');

const loadScript = (filename) => {
  const content = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
  // eslint-disable-next-line no-eval
  eval(content);
};

const bootstrapSelectorFinder = () => {
  delete window.SelectorConfig;
  delete window.SelectorConfigRegistry;
  delete window.SelectorFinder;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  loadScript('selector-manager-strategies.js');
  loadScript('selectors/grok.config.js');
  loadScript('selectors-config.js');
  loadScript('selector-manager.js');
};

describe('SelectorFinder core layers', () => {
  beforeEach(() => {
    bootstrapSelectorFinder();
  });

  afterEach(() => {
    delete window.LLM_DEBUG;
    chrome.runtime.sendMessage.mockClear();
    chrome.storage.local._store.clear();
  });

  test('resolves Grok composer via versioned selectors while respecting exclusion hints', async () => {
    const root = document.createElement('main');
    root.setAttribute('role', 'main');

    const search = document.createElement('input');
    search.setAttribute('type', 'search');
    search.setAttribute('aria-label', 'Search site');
    root.appendChild(search);

    const composerShell = document.createElement('div');
    composerShell.setAttribute('data-testid', 'grok-editor');
    const composer = document.createElement('div');
    composer.setAttribute('role', 'textbox');
    composer.setAttribute('contenteditable', 'true');
    composerShell.appendChild(composer);
    root.appendChild(composerShell);

    document.body.appendChild(root);

    const result = await window.SelectorFinder.findOrDetectSelector({
      modelName: 'Grok',
      elementType: 'composer'
    });

    expect(result).toBeTruthy();
    expect(result.element).toBe(composer);
  });

  test('finds Grok send button relative to composer and highlights element in debug mode', async () => {
    const root = document.createElement('main');
    root.setAttribute('role', 'main');

    const composerShell = document.createElement('div');
    composerShell.setAttribute('data-testid', 'grok-editor');
    const composer = document.createElement('div');
    composer.setAttribute('role', 'textbox');
    composer.setAttribute('contenteditable', 'true');
    composerShell.appendChild(composer);

    const sendButton = document.createElement('button');
    sendButton.setAttribute('data-testid', 'grok-send-button');
    sendButton.textContent = 'Send';
    composerShell.appendChild(sendButton);

    root.appendChild(composerShell);
    document.body.appendChild(root);

    const composerMatch = await window.SelectorFinder.findOrDetectSelector({
      modelName: 'Grok',
      elementType: 'composer'
    });

    window.LLM_DEBUG = true;
    const buttonMatch = await window.SelectorFinder.findOrDetectSelector({
      modelName: 'Grok',
      elementType: 'sendButton',
      referenceElement: composerMatch.element
    });

    expect(buttonMatch).toBeTruthy();
    expect(buttonMatch.element).toBe(sendButton);
    expect(sendButton.classList.contains('selector-finder__debug-highlight')).toBe(true);
  });

  test('auto-discovery locates fallback article when selectors fail', async () => {
    const feed = document.createElement('div');
    feed.setAttribute('role', 'feed');

    const article = document.createElement('article');
    article.textContent = 'Generated answer text';
    feed.appendChild(article);
    document.body.appendChild(feed);

    // Remove selector config to force auto-discovery
    window.SelectorConfig.models.Grok.versions.forEach((v) => {
      v.selectors.response = { primary: [], fallback: [] };
    });

    const result = await window.SelectorFinder.findOrDetectSelector({
      modelName: 'Grok',
      elementType: 'response',
      forceDiscovery: true
    });

    expect(result).toBeTruthy();
    expect(result.element).toBe(article);
  });

  test('waitForElement resolves after mutation observer detects response text', async () => {
    // Speed up stabilization for the test.
    window.SelectorConfig.models.Grok.versions.forEach((version) => {
      if (!version.observation) return;
      version.observation.stabilizationDelayMs = 10;
      version.observation.fallbackDelayMs = 20;
    });

    const root = document.createElement('main');
    root.setAttribute('role', 'main');
    const responseContainer = document.createElement('div');
    responseContainer.setAttribute('data-testid', 'grok-response');
    root.appendChild(responseContainer);
    document.body.appendChild(root);

    const waitPromise = window.SelectorFinder.waitForElement({
      modelName: 'Grok',
      elementType: 'response',
      timeout: 2000,
      prompt: 'User prompt'
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const prose = document.createElement('div');
    prose.className = 'prose';
    prose.textContent = 'Assistant reply content.';
    responseContainer.appendChild(prose);

    const result = await waitPromise;
    expect(result.text).toBe('Assistant reply content.');
    expect(result.element).toBe(prose);
  });
});
