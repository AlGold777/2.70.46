(function () {
  const globalObject = typeof window !== 'undefined' ? window : self;
  globalObject.SelectorConfigRegistry = globalObject.SelectorConfigRegistry || {};
  if (globalObject.SelectorConfigRegistry.Qwen) return;

  globalObject.SelectorConfigRegistry.Qwen = {
    versions: [],
    emergencyFallbacks: {
      composer: [
        'textarea[aria-label*="question"]',
        'textarea',
        'div[role="textbox"]',
        '[contenteditable="true"]'
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
        '[data-testid="chat-response"]',
        'main article',
        '.prose',
        'main'
      ]
    },
    observationDefaults: {
      rootSelector: 'main',
      targetSelectors: [
        '[data-testid="chat-response"]',
        'main article',
        '.prose'
      ],
      stabilizationDelayMs: 1800,
      endGenerationMarkers: [
        { selector: '[data-testid="chat-loader"]', type: 'disappear' }
      ]
    }
  };
})();
