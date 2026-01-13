(function initAnswerPipelineSelectors() {
  if (window.AnswerPipelineSelectors) return;

  const detectPlatform = () => {
    const h = (location.hostname || '').toLowerCase();
    if (h.includes('chatgpt') || h.includes('openai')) return 'chatgpt';
    if (h.includes('claude.ai')) return 'claude';
    if (h.includes('gemini.google') || h.includes('bard.google')) return 'gemini';
    if (h.includes('grok.com') || h.includes('grok.x.ai') || h.includes('x.ai') || h === 'x.com') return 'grok';
    if (h.includes('perplexity.ai')) return 'perplexity';
    if (h.includes('deepseek')) return 'deepseek';
    if (h.includes('qwen')) return 'qwen';
    if (h.includes('mistral')) return 'lechat';
    return 'generic';
  };

  const PLATFORM_SELECTORS = {
    chatgpt: {
      answerContainer: '[data-testid=\"conversation-panel\"], [data-testid=\"conversation-container\"], main, [data-testid=\"conversation-turn\"]',
      lastMessage: [
        '[data-testid=\"conversation-turn\"][data-message-author-role=\"assistant\"]',
        '[data-testid=\"conversation-turn\"][data-author-role=\"assistant\"]',
        '[data-testid=\"conversation-turn\"][data-role=\"assistant\"]',
        '[data-message-author-role=\"assistant\"]',
        '[data-author-role=\"assistant\"]',
        '[data-role=\"assistant\"]'
      ].join(', '),
      streamStart: [
        '[data-testid=\"conversation-turn\"][data-message-author-role=\"assistant\"]',
        '[data-testid=\"conversation-turn\"][data-author-role=\"assistant\"]',
        '[data-testid=\"conversation-turn\"][data-role=\"assistant\"]',
        '[data-message-author-role=\"assistant\"]',
        '[data-author-role=\"assistant\"]',
        '[data-role=\"assistant\"]',
        '.agent-turn'
      ],
      generatingIndicators: [
        'button[aria-label*=\"Stop\" i]:not([disabled]):not([aria-disabled=\"true\"]):not([aria-hidden=\"true\"])',
        'button[data-testid=\"stop-button\"]:not([disabled]):not([aria-disabled=\"true\"])',
        'button[data-testid*=\"stop\"]:not([disabled]):not([aria-disabled=\"true\"])'
      ],
      completionIndicators: [
        'button[data-testid=\"regenerate-button\"]',
        'button[aria-label*=\"Regenerate\" i]',
        'button[aria-label*=\"Continue\" i]',
        'button[data-testid*=\"continue\"]',
        'button[data-testid*=\"regenerate\"]'
      ],
      stopButton: 'button[aria-label*=\"Stop\" i], button[data-testid=\"stop-button\"], button[data-testid*=\"stop\"]'
    },
    claude: {
      answerContainer: '[data-testid=\"conversation-content\"], [data-testid*=\"conversation\"], [class*=\"conversation\" i], main, [role=\"main\"]',
      lastMessage: [
        'div[data-testid=\"conversation-turn\"][data-author-role=\"assistant\"] [data-testid=\"message-text\"]:not([data-testid*=\"thinking\" i]):not([data-testid*=\"thought\" i]):not([data-testid*=\"reason\" i]):not([data-testid*=\"analysis\" i]):not([data-testid*=\"scratch\" i]):not([data-testid*=\"work\" i]):not([data-testid*=\"step\" i]):not([data-testid*=\"draft\" i]):not([data-testid*=\"trace\" i]):not([data-testid*=\"internal\" i]):not([data-testid*=\"reflection\" i])',
        'div[data-testid=\"conversation-turn\"][data-role=\"assistant\"] [data-testid=\"message-text\"]:not([data-testid*=\"thinking\" i]):not([data-testid*=\"thought\" i]):not([data-testid*=\"reason\" i]):not([data-testid*=\"analysis\" i]):not([data-testid*=\"scratch\" i]):not([data-testid*=\"work\" i]):not([data-testid*=\"step\" i]):not([data-testid*=\"draft\" i]):not([data-testid*=\"trace\" i]):not([data-testid*=\"internal\" i]):not([data-testid*=\"reflection\" i])',
        'div[data-is-response=\"true\"][data-author-role=\"assistant\"] [data-testid=\"message-text\"]:not([data-testid*=\"thinking\" i]):not([data-testid*=\"thought\" i]):not([data-testid*=\"reason\" i]):not([data-testid*=\"analysis\" i]):not([data-testid*=\"scratch\" i]):not([data-testid*=\"work\" i]):not([data-testid*=\"step\" i]):not([data-testid*=\"draft\" i]):not([data-testid*=\"trace\" i]):not([data-testid*=\"internal\" i]):not([data-testid*=\"reflection\" i])',
        'div[data-is-response=\"true\"][data-role=\"assistant\"] [data-testid=\"message-text\"]:not([data-testid*=\"thinking\" i]):not([data-testid*=\"thought\" i]):not([data-testid*=\"reason\" i]):not([data-testid*=\"analysis\" i]):not([data-testid*=\"scratch\" i]):not([data-testid*=\"work\" i]):not([data-testid*=\"step\" i]):not([data-testid*=\"draft\" i]):not([data-testid*=\"trace\" i]):not([data-testid*=\"internal\" i]):not([data-testid*=\"reflection\" i])',
        'div[data-testid=\"conversation-turn\"][data-author-role=\"assistant\"] article:not([data-testid*=\"thinking\" i]):not([data-testid*=\"thought\" i]):not([data-testid*=\"reason\" i]):not([data-testid*=\"analysis\" i]):not([data-testid*=\"scratch\" i]):not([data-testid*=\"work\" i]):not([data-testid*=\"step\" i]):not([data-testid*=\"draft\" i]):not([data-testid*=\"trace\" i]):not([data-testid*=\"internal\" i]):not([data-testid*=\"reflection\" i])',
        'div[data-testid=\"conversation-turn\"][data-role=\"assistant\"] article:not([data-testid*=\"thinking\" i]):not([data-testid*=\"thought\" i]):not([data-testid*=\"reason\" i]):not([data-testid*=\"analysis\" i]):not([data-testid*=\"scratch\" i]):not([data-testid*=\"work\" i]):not([data-testid*=\"step\" i]):not([data-testid*=\"draft\" i]):not([data-testid*=\"trace\" i]):not([data-testid*=\"internal\" i]):not([data-testid*=\"reflection\" i])',
        'div[data-is-response=\"true\"][data-author-role=\"assistant\"] article:not([data-testid*=\"thinking\" i]):not([data-testid*=\"thought\" i]):not([data-testid*=\"reason\" i]):not([data-testid*=\"analysis\" i]):not([data-testid*=\"scratch\" i]):not([data-testid*=\"work\" i]):not([data-testid*=\"step\" i]):not([data-testid*=\"draft\" i]):not([data-testid*=\"trace\" i]):not([data-testid*=\"internal\" i]):not([data-testid*=\"reflection\" i])',
        'div[data-is-response=\"true\"][data-role=\"assistant\"] article:not([data-testid*=\"thinking\" i]):not([data-testid*=\"thought\" i]):not([data-testid*=\"reason\" i]):not([data-testid*=\"analysis\" i]):not([data-testid*=\"scratch\" i]):not([data-testid*=\"work\" i]):not([data-testid*=\"step\" i]):not([data-testid*=\"draft\" i]):not([data-testid*=\"trace\" i]):not([data-testid*=\"internal\" i]):not([data-testid*=\"reflection\" i])',
        'div[data-testid=\"conversation-turn\"][data-author-role=\"assistant\"]:not([data-testid*=\"thinking\" i]):not([data-testid*=\"thought\" i]):not([data-testid*=\"reason\" i]):not([data-testid*=\"analysis\" i]):not([data-testid*=\"scratch\" i]):not([data-testid*=\"work\" i]):not([data-testid*=\"step\" i]):not([data-testid*=\"draft\" i]):not([data-testid*=\"trace\" i]):not([data-testid*=\"internal\" i]):not([data-testid*=\"reflection\" i])',
        'div[data-testid=\"conversation-turn\"][data-role=\"assistant\"]:not([data-testid*=\"thinking\" i]):not([data-testid*=\"thought\" i]):not([data-testid*=\"reason\" i]):not([data-testid*=\"analysis\" i]):not([data-testid*=\"scratch\" i]):not([data-testid*=\"work\" i]):not([data-testid*=\"step\" i]):not([data-testid*=\"draft\" i]):not([data-testid*=\"trace\" i]):not([data-testid*=\"internal\" i]):not([data-testid*=\"reflection\" i])',
        'div[data-is-response=\"true\"][data-author-role=\"assistant\"]:not([data-testid*=\"thinking\" i]):not([data-testid*=\"thought\" i]):not([data-testid*=\"reason\" i]):not([data-testid*=\"analysis\" i]):not([data-testid*=\"scratch\" i]):not([data-testid*=\"work\" i]):not([data-testid*=\"step\" i]):not([data-testid*=\"draft\" i]):not([data-testid*=\"trace\" i]):not([data-testid*=\"internal\" i]):not([data-testid*=\"reflection\" i])',
        'div[data-is-response=\"true\"][data-role=\"assistant\"]:not([data-testid*=\"thinking\" i]):not([data-testid*=\"thought\" i]):not([data-testid*=\"reason\" i]):not([data-testid*=\"analysis\" i]):not([data-testid*=\"scratch\" i]):not([data-testid*=\"work\" i]):not([data-testid*=\"step\" i]):not([data-testid*=\"draft\" i]):not([data-testid*=\"trace\" i]):not([data-testid*=\"internal\" i]):not([data-testid*=\"reflection\" i])',
        'div[data-message-author-role=\"assistant\"]:not([data-testid*=\"thinking\" i]):not([data-testid*=\"thought\" i]):not([data-testid*=\"reason\" i]):not([data-testid*=\"analysis\" i]):not([data-testid*=\"scratch\" i]):not([data-testid*=\"work\" i]):not([data-testid*=\"step\" i]):not([data-testid*=\"draft\" i]):not([data-testid*=\"trace\" i]):not([data-testid*=\"internal\" i]):not([data-testid*=\"reflection\" i])',
        '[data-testid=\"assistant-message\"]:not([data-testid*=\"thinking\" i]):not([data-testid*=\"thought\" i]):not([data-testid*=\"reason\" i]):not([data-testid*=\"analysis\" i]):not([data-testid*=\"scratch\" i]):not([data-testid*=\"work\" i]):not([data-testid*=\"step\" i]):not([data-testid*=\"draft\" i]):not([data-testid*=\"trace\" i]):not([data-testid*=\"internal\" i]):not([data-testid*=\"reflection\" i])',
        '[data-testid=\"assistant-response\"]:not([data-testid*=\"thinking\" i]):not([data-testid*=\"thought\" i]):not([data-testid*=\"reason\" i]):not([data-testid*=\"analysis\" i]):not([data-testid*=\"scratch\" i]):not([data-testid*=\"work\" i]):not([data-testid*=\"step\" i]):not([data-testid*=\"draft\" i]):not([data-testid*=\"trace\" i]):not([data-testid*=\"internal\" i]):not([data-testid*=\"reflection\" i])',
        '[data-testid=\"chat-response\"]:not([data-testid*=\"thinking\" i]):not([data-testid*=\"thought\" i]):not([data-testid*=\"reason\" i]):not([data-testid*=\"analysis\" i]):not([data-testid*=\"scratch\" i]):not([data-testid*=\"work\" i]):not([data-testid*=\"step\" i]):not([data-testid*=\"draft\" i]):not([data-testid*=\"trace\" i]):not([data-testid*=\"internal\" i]):not([data-testid*=\"reflection\" i])'
      ].join(', '),
      streamStart: [
        '[data-testid=\"assistant-message\"]',
        'div[data-testid=\"conversation-turn\"][data-author-role=\"assistant\"]',
        'div[data-testid=\"conversation-turn\"][data-role=\"assistant\"]',
        'div[data-is-response=\"true\"]',
        '.font-claude-message',
        '[class*=\"font-claude\" i]'
      ],
      generatingIndicators: [
        'button[aria-label*=\"Stop\" i]',
        'button[data-testid*=\"stop\"]',
        '[data-testid=\"chat-loader\"]',
        '[data-testid=\"chat-spinner\"]',
        '[data-testid=\"typing\"]',
        '[data-is-streaming=\"true\"]',
        '[class*=\"streaming\" i]',
        '.typing-indicator',
        '.animate-pulse'
      ],
      completionIndicators: [
        'button[aria-label*=\"Regenerate\" i]',
        'button[aria-label*=\"Retry\" i]',
        'button[aria-label*=\"Continue\" i]',
        'button[data-testid*=\"regenerate\"]',
        'button[data-testid*=\"retry\"]',
        'button[data-testid*=\"continue\"]'
      ],
      stopButton: 'button[aria-label*=\"Stop\" i], button[data-testid*=\"stop\"]'
    },
    gemini: {
      answerContainer: 'main, [role=\"main\"], [class*=\"conversation\" i]',
      lastMessage: [
        '[data-test-id*=\"model-response\"]',
        '[data-testid*=\"model-response\"]',
        '.model-response',
        'model-response',
        'message-content',
        '[data-message-author-role=\"assistant\"]',
        '[data-role=\"assistant\"]'
      ].join(', '),
      streamStart: ['[data-test-id*=\"model-response\"]', '[data-testid*=\"model-response\"]', '.model-response', 'model-response', 'message-content', '[data-message-author-role=\"assistant\"]', '[data-role=\"assistant\"]'],
      generatingIndicators: ['.loading', '[aria-busy=\"true\"]', '[data-is-loading=\"true\"]', '[data-loading=\"true\"]', '[data-streaming=\"true\"]'],
      completionIndicators: ['rich-textarea', 'textarea[aria-label*=\"Prompt\" i]', 'textarea[aria-label*=\"Message\" i]', 'textarea[aria-label*=\"Ask\" i]'],
      stopButton: 'button[aria-label*=\"Stop\" i]'
    },
    grok: {
      answerContainer: 'main[role=\"main\"], [data-testid=\"conversation-container\"], [data-testid*=\"conversation\"], [role=\"log\"], main',
      lastMessage: [
        '[data-testid=\"grok-response\"]',
        '[data-testid=\"message\"]',
        '[data-testid*=\"chat-message\"]',
        '[data-message-author-role=\"assistant\"]',
        '[data-role=\"assistant\"]',
        'article[data-role=\"assistant\"]',
        'div[class*=\"assistant\" i]',
        '[role=\"article\"]',
        'div.flex.flex-col:nth-of-type(2) > div.relative.group > div.message-bubble.relative:nth-of-type(1)',
        'div.message-bubble.relative.rounded-3xl.text-primary.min-h-7.prose',
        'div.message-bubble',
        '.prose',
        'article'
      ].join(', '),
      streamStart: ['[data-testid=\"grok-response\"]', '[data-testid=\"message\"]', '[data-testid*=\"chat-message\"]', '[data-message-author-role=\"assistant\"]', '[data-role=\"assistant\"]', 'article[data-role=\"assistant\"]', 'div[class*=\"assistant\" i]', '[role=\"article\"]', 'div.message-bubble.relative.rounded-3xl.text-primary.min-h-7.prose', 'div.message-bubble', '.prose', 'article'],
      generatingIndicators: ['.animate-pulse', '[aria-busy=\"true\"]', '[data-streaming=\"true\"]', '[data-generating=\"true\"]', '[class*=\"typing\" i]', '[class*=\"streaming\" i]', '.typing-indicator', 'button[aria-label*=\"Stop\" i]', '[data-testid*=\"loading\"]'],
      completionIndicators: ['[data-testid=\"grok-send-button\"]', 'button[data-testid=\"grok-send-button\"]:not([disabled])', 'button[aria-label*=\"Send\" i]:not([disabled])', 'textarea[role=\"textbox\"]'],
      stopButton: 'button[aria-label*=\"Stop\" i], button[data-testid=\"grok-stop-button\"]'
    },
    perplexity: {
      answerContainer: 'main, [role=\"main\"], [data-testid=\"conversation-container\"], [data-testid=\"layout-wrapper\"], [class*=\"answer-container\" i], [data-testid*=\"answer\"], [data-testid*=\"response\"], article',
      lastMessage: [
        '[data-testid=\"answer-card\"]',
        '[data-testid=\"answer\"]',
        '[data-testid*=\"answer\"]',
        '[data-testid*=\"response\"]',
        '[class*=\"answer-container\" i] > :last-child',
        '[class*=\"answer-container\" i] .prose',
        '[data-testid=\"chat-message\"] .prose',
        '[data-testid=\"conversation-turn\"]',
        '.answer',
        '.prose',
        'article'
      ].join(', '),
      streamStart: [
        '[data-testid=\"answer-card\"]',
        '[data-testid=\"answer\"]',
        '[data-testid*=\"answer\"]',
        '[data-testid*=\"response\"]',
        '[class*=\"answer-container\" i]',
        '[data-testid=\"chat-message\"]',
        '[data-testid=\"conversation-turn\"]',
        '.answer',
        '.prose',
        'article'
      ],
      generatingIndicators: ['.loading-indicator', '[data-testid=\"loading-indicator\"]', '[aria-busy=\"true\"]', '[data-generating=\"true\"]', '[class*=\"streaming\" i]', 'button[aria-label*=\"Stop\" i]', '[data-testid=\"stop-button\"]'],
      completionIndicators: ['textarea[aria-label*=\"Ask\" i]', 'textarea[aria-label*=\"Search\" i]', 'textarea[aria-label*=\"Message\" i]', 'button[aria-label*=\"Ask\" i]', 'button[data-testid=\"send-button\"]:not([disabled])', 'button[type=\"submit\"]:not([disabled])'],
      stopButton: 'button[aria-label*=\"Stop\" i], button[data-testid=\"stop-button\"]'
    },
    qwen: {
      answerContainer: 'main, article',
      lastMessage: [
        '[data-testid=\"chat-response\"]',
        '[data-message-type=\"assistant\"]',
        '[data-role*=\"assistant\"]',
        '[data-testid*=\"assistant\"]',
        'article[data-role*=\"assistant\"]',
        'section[data-role*=\"assistant\"]',
        'div[class*=\"assistant-message\"]',
        'div[class*=\"assistantMessage\"]',
        '[class*=\"response\"]',
        '.prose',
        'div[class*=\"markdown\"]',
        'main article'
      ].join(', '),
      streamStart: [
        '[data-testid=\"chat-response\"]',
        '[data-message-type=\"assistant\"]',
        '[data-role*=\"assistant\"]',
        '[data-testid*=\"assistant\"]',
        'article[data-role*=\"assistant\"]',
        'section[data-role*=\"assistant\"]',
        'div[class*=\"assistant-message\"]',
        '[class*=\"response\"]',
        '.prose',
        'main article'
      ],
      generatingIndicators: ['[data-testid=\"chat-loader\"]', '[aria-busy=\"true\"]', '.loading', '.spinner', '[data-streaming=\"true\"]', '[class*=\"streaming\" i]', '.typing-indicator', 'button[aria-label*=\"Stop\" i]'],
      completionIndicators: ['button[data-testid*=\"send\"]:not([disabled])', 'textarea[role=\"textbox\"]:not([disabled])'],
      stopButton: 'button[aria-label*=\"Stop\" i]'
    },
    deepseek: {
      answerContainer: 'main, [role=\"main\"], .chat-content, [class*=\"conversation\" i], [class*=\"chat\" i], article',
      lastMessage: [
        '.message-item[data-role=\"assistant\"]',
        'div[class*=\"assistant\" i]',
        '[data-role=\"assistant\"]',
        '[data-testid*=\"assistant\"]',
        '[data-testid*=\"chat-response\"]',
        '[data-testid*=\"message\"]',
        '.assistant-message',
        '.message-content',
        '.markdown-body',
        '[class*=\"message\" i][class*=\"assistant\" i]',
        '[class*=\"response\" i]',
        'div[role=\"article\"]',
        'article',
        '.prose'
      ].join(', '),
      streamStart: ['.message-item[data-role=\"assistant\"]', 'div[class*=\"assistant\" i]', '[data-role=\"assistant\"]', '[data-testid*=\"assistant\"]', '[data-testid*=\"chat-response\"]', '[data-testid*=\"message\"]', '.assistant-message', '.message-content', '.markdown-body', '[class*=\"message\" i][class*=\"assistant\" i]', '[class*=\"response\" i]', 'div[role=\"article\"]', 'article', '.prose'],
      generatingIndicators: ['[aria-busy=\"true\"]', '.loading', '[data-generating=\"true\"]', '[data-streaming=\"true\"]', '.typing-indicator', '.spinner', '.loader', '.animate-pulse', '[class*=\"streaming\" i]', '[data-testid*=\"loading\"]', 'button[aria-label*=\"Stop\" i]'],
      completionIndicators: ['textarea:not([disabled])', 'textarea[role=\"textbox\"]:not([disabled])', 'button[type=\"submit\"]:not([disabled])', 'button[aria-label*=\"Send\" i]:not([disabled])', 'button[data-testid*=\"send\"]:not([disabled])'],
      stopButton: 'button[aria-label*=\"Stop\" i]'
    },
    lechat: {
      answerContainer: 'main, article',
      lastMessage: [
        'div[data-testid=\"lechat-response\"] .prose',
        '[data-testid=\"answer\"] .prose',
        '[data-testid*=\"message-content\"]',
        'div[class*=\"message-content\"]',
        '[role=\"article\"] .prose',
        '[data-role=\"assistant\"]',
        '[data-message-author-role=\"assistant\"]',
        'article',
        '.prose'
      ].join(', '),
      streamStart: ['div[data-testid=\"lechat-response\"]', '[data-testid=\"answer\"]', '[data-testid*=\"message-content\"]', 'div[class*=\"message-content\"]', '[data-role=\"assistant\"]', '[data-message-author-role=\"assistant\"]', 'article', '.prose'],
      generatingIndicators: ['[aria-busy=\"true\"]', '.loading', '.animate-pulse', '.typing-indicator', '[class*=\"streaming\" i]', '[data-testid=\"generation\"]', '[data-testid*=\"loading\"]'],
      completionIndicators: ['button[type=\"submit\"]:not([disabled])', 'textarea[role=\"textbox\"]:not([disabled])'],
      stopButton: 'button[aria-label*=\"Stop\" i]'
    },
    generic: {
      answerContainer: 'main, [role=\"main\"], article',
      lastMessage: '.prose, article',
      streamStart: ['.prose', 'article', '[role=\"log\"]'],
      generatingIndicators: ['.loading', '.spinner', '[aria-busy=\"true\"]'],
      completionIndicators: ['textarea:not([disabled])', 'button[type=\"submit\"]:not([disabled])'],
      stopButton: 'button[aria-label*=\"Stop\" i]'
    }
  };

  window.AnswerPipelineSelectors = { PLATFORM_SELECTORS, detectPlatform };
})();
