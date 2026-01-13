(function () {
  const globalObject = typeof window !== 'undefined' ? window : self;
  globalObject.SelectorConfigRegistry = globalObject.SelectorConfigRegistry || {};
  if (globalObject.SelectorConfigRegistry.Perplexity) return;

  globalObject.SelectorConfigRegistry.Perplexity = {
    versions: [],
    emergencyFallbacks: {
      composer: [
        'textarea[aria-label*="Ask"]',
        'textarea',
        'div[role="textbox"]',
        '[contenteditable="true"]'
      ],
      sendButton: [
        'button[aria-label*="Ask"]',
        'button[type="submit"]',
        'button'
      ],
      response: [
        '[data-testid="answer-card"]',
        '[data-testid="answer-card"] .prose',
        '[data-testid="answer"]',
        '[data-testid="answer"] .prose',
        '[data-testid="chat-message"] .prose',
        '[data-testid="conversation-turn"] .prose',
        '.answer',
        '.prose',
        'article'
      ]
    },
    observationDefaults: {
      rootSelector: 'main',
      targetSelectors: [
        '[data-testid="answer-card"]',
        '[data-testid="answer"]',
        '[data-testid="chat-message"] .prose',
        '[data-testid="conversation-turn"] .prose',
        '.answer',
        '.prose',
        'article'
      ],
      stabilizationDelayMs: 1800,
      endGenerationMarkers: [
        { selector: '.loading-indicator', type: 'disappear' }
      ]
    }
  };
})();
