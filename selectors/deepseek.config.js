(function () {
  const globalObject = typeof window !== 'undefined' ? window : self;
  globalObject.SelectorConfigRegistry = globalObject.SelectorConfigRegistry || {};
  if (globalObject.SelectorConfigRegistry.DeepSeek) return;

  globalObject.SelectorConfigRegistry.DeepSeek = {
    versions: [],
    emergencyFallbacks: {
      composer: [
        'textarea[aria-label*="prompt"]',
        'textarea',
        '[contenteditable="true"]',
        'div[role="textbox"]'
      ],
      sendButton: [
        'button[aria-label*="send" i]',
        'button[aria-label*="send message" i]',
        'button[aria-label*="submit" i]',
        'button[aria-label*="post" i]',
        'button[type="submit"]',
        'button[data-testid*="send"]',
        'div[role="button"][aria-label*="send" i]',
        'div[role="button"][data-testid*="send"]'
      ],
      response: [
        '.response',
        '.prose',
        'main article',
        'main'
      ]
    },
    observationDefaults: {
      rootSelector: 'main',
      targetSelectors: [
        '.response',
        '.prose',
        'main article'
      ],
      stabilizationDelayMs: 1800,
      endGenerationMarkers: [
        { selector: '.loading-spinner', type: 'disappear' }
      ]
    }
  };
})();
