(function () {
  const globalObject = typeof window !== 'undefined' ? window : self;
  globalObject.SelectorConfigRegistry = globalObject.SelectorConfigRegistry || {};
  if (globalObject.SelectorConfigRegistry.Gemini) return;

  globalObject.SelectorConfigRegistry.Gemini = {
    versions: [],
    emergencyFallbacks: {
      composer: [
        'textarea[aria-label*="Prompt"]',
        'textarea',
        'div[role="textbox"]',
        '[contenteditable="true"]'
      ],
      sendButton: [
        'button[aria-label*="Send"]',
        'button[data-mdc-dialog-action="submit"]',
        'button[type="submit"]'
      ],
      response: [
        '[data-test-id*="model-response"]',
        '[data-testid*="model-response"]',
        '.model-response',
        'model-response',
        'message-content',
        '[data-message-author-role="assistant"]',
        '[data-role="assistant"]'
      ]
    },
    observationDefaults: {
      rootSelector: 'main',
      targetSelectors: [
        '[data-test-id*="model-response"]',
        '[data-testid*="model-response"]',
        '.model-response',
        'model-response',
        'message-content',
        '[data-message-author-role="assistant"]',
        '[data-role="assistant"]'
      ],
      stabilizationDelayMs: 1800,
      endGenerationMarkers: [
        { selector: '[aria-live="polite"] .progress', type: 'disappear' }
      ]
    }
  };
})();
