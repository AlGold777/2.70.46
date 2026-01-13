// content-perplexity.js

//-- Защита от дублирования --//
const resolveExtensionVersion = () => {
  try {
    return chrome?.runtime?.getManifest?.()?.version || 'unknown';
  } catch (_) {
    return 'unknown';
  }
};
if (window.perplexityContentScriptLoaded) {
  console.warn('[content-perplexity] Script already loaded, skipping duplicate initialization');
  throw new Error('Duplicate script load prevented');
}
window.perplexityContentScriptLoaded = {
  timestamp: Date.now(),
  version: resolveExtensionVersion(),
  source: 'content-perplexity'
};
console.log('[content-perplexity] First load, initializing...');
//-- 2. Очистка кэша селекторов на старте -//
chrome.storage.local.remove([
  'selector_cache_Perplexity_inputField',
  'selector_cache_Perplexity_sendButton'
]);

//-- Конец защиты --//

const MODEL = "Perplexity";
const PERPLEXITY_FALLBACK_LAST_MESSAGE_SELECTORS = [
  '[data-testid="answer-card"]',
  '[data-testid="answer-card"] .prose',
  '[data-testid="answer"]',
  '[data-testid="answer"] .prose',
  '[data-testid="chat-message"] .prose',
  '[data-testid="conversation-turn"] .prose',
  '[class*="answer-container" i] .prose',
  '.answer',
  '.prose',
  'article'
];

const buildInlineHtml = (node) => {
  if (!node) return '';
  const builder = window.ContentUtils?.buildInlineHtml;
  if (typeof builder === 'function') {
    return String(builder(node, { includeRoot: true }) || '').trim();
  }
  return String(node.innerHTML || '').trim();
};

const normalizeResponsePayload = (resp, fallbackHtml = '') => {
  if (resp && typeof resp === 'object') {
    return {
      text: String(resp.text || resp.answer || ''),
      html: String(resp.html || resp.answerHtml || fallbackHtml || '')
    };
  }
  return {
    text: String(resp ?? ''),
    html: String(fallbackHtml || '')
  };
};

function grabLatestAssistantMarkup() {
  try {
    const selectorsFromBundle = (window.AnswerPipelineSelectors?.PLATFORM_SELECTORS?.perplexity?.lastMessage
      ? [window.AnswerPipelineSelectors.PLATFORM_SELECTORS.perplexity.lastMessage]
      : []).flat().filter(Boolean);
    const candidates = selectorsFromBundle.length ? selectorsFromBundle : PERPLEXITY_FALLBACK_LAST_MESSAGE_SELECTORS;
    for (const sel of candidates) {
      const nodes = Array.from(document.querySelectorAll(sel));
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        if (!node) continue;
        const html = buildInlineHtml(node);
        const text = (node.innerText || node.textContent || '').trim();
        if (html || text) return { html, text, node };
      }
    }
  } catch (err) {
    console.warn('[content-perplexity] grabLatestAssistantMarkup failed', err);
  }
  return { html: '', text: '', node: null };
}

async function trySelectorFinderResponse(prompt, timeoutMs = 60000) {
  const finder = window.SelectorFinder;
  if (!finder?.waitForElement) return '';
  try {
    const res = await finder.waitForElement({
      modelName: MODEL,
      elementType: 'response',
      timeout: timeoutMs,
      prompt: prompt || ''
    });
    return (res?.text || '').trim();
  } catch (err) {
    console.warn('[content-perplexity] SelectorFinder response fallback failed', err);
    return '';
  }
}

window.setupHumanoidFetchMonitor?.(MODEL, ({ status, retryAfter }) => {
  if (status !== 429) return;
  const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 || 60000 : 60000;
  chrome.runtime.sendMessage({
    type: 'LLM_RESPONSE',
    llmName: MODEL,
    answer: 'Error: Rate limit detected. Please wait.',
    error: {
      type: 'rate_limit',
      message: `HTTP 429 detected. Suggested wait time: ${waitTime}ms`,
      waitTime
    }
  });
});
  const getLifecycleMode = () => {
    if (typeof window !== 'undefined') {
      if (window.__humanoidActivityMode) return window.__humanoidActivityMode;
      if (document?.visibilityState === 'hidden') return 'background';
    }
    return 'interactive';
  };
  // Pragmatist integration
  const prag = window.__PragmatistAdapter;
  const getPragSessionId = () => prag?.sessionId;
  const getPragPlatform = () => prag?.adapter?.name || 'perplexity';
  const pipelineOverrides = prag
    ? { sessionId: getPragSessionId(), platform: getPragPlatform(), llmName: MODEL }
    : { llmName: MODEL };
  let lastResponseHtml = '';
const buildLifecycleContext = (prompt = '', extra = {}) => ({
  promptLength: prompt?.length || 0,
  evaluator: Boolean(extra.evaluator),
  mode: extra.mode || getLifecycleMode()
});
const getForceStopRegistry = () => {
  if (window.__humanoidForceStopRegistry) {
    return window.__humanoidForceStopRegistry;
  }
  const handlers = new Set();
  window.__humanoidForceStopRegistry = {
    register(handler) {
      if (typeof handler !== 'function') return () => {};
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    run(reason) {
      handlers.forEach((fn) => {
        try { fn(reason); } catch (_) {}
      });
    }
  };
  return window.__humanoidForceStopRegistry;
};
const registerForceStopHandler = (handler) => getForceStopRegistry().register(handler);
const handleForceStopMessage = (traceId) => {
  if (traceId && window.HumanoidEvents?.stop) {
    try {
      window.HumanoidEvents.stop(traceId, { status: 'forced', reason: 'background-force-stop' });
    } catch (_) {}
  }
  getForceStopRegistry().run('background-force-stop');
};

const cleanupScope = window.HumanoidCleanup?.createScope?.(`${MODEL.toLowerCase()}-content`) || {
  trackInterval: (id) => id,
  trackTimeout: (id) => id,
  trackObserver: (observer) => observer,
  trackAbortController: (controller) => controller,
  register: () => () => {},
  addEventListener: () => () => {},
  cleanup: () => {},
  isCleaned: () => false,
  getReason: () => null
};
let scriptStopped = false;
const stopContentScript = (reason = 'manual-stop') => {
  if (scriptStopped) return cleanupScope.getReason?.() || reason;
  scriptStopped = true;
  console.warn('[content-perplexity] Cleanup triggered:', reason);
  try {
    getForceStopRegistry().run(reason);
  } catch (_) {}
  try {
    cleanupScope.cleanup?.(reason);
  } catch (err) {
    console.warn('[content-perplexity] Cleanup scope failed', err);
  }
  try {
    window.perplexityContentScriptLoaded = null;
  } catch (_) {}
  return reason;
};
window.__cleanup_perplexity = stopContentScript;
cleanupScope.addEventListener?.(window, 'pagehide', () => stopContentScript('pagehide'));
cleanupScope.addEventListener?.(window, 'beforeunload', () => stopContentScript('beforeunload'));

//-- V3.0 START: Advanced Content Cleaning System --//
class ContentCleaner {
  constructor() {
    this.cleaningRules = this.initializeCleaningRules();
    this.cleaningStats = { elementsRemoved: 0, charactersRemoved: 0, rulesApplied: 0 };
  }

  initializeCleaningRules() {
    return {
      // UI-элементы и фразы интерфейса
      uiPhrases: [
        /\b(Send|Menu|Settings|New chat|Clear|Like|Reply|Copy|Share|Follow|Subscribe)\b/gi,
        /\b(Upload|Download|Save|Delete|Edit|Search|Filter|Sort)\b/gi,
        /\b(Perplexity|PPLX|Pro Search)\b/gi
      ],
      // Временные метки и даты
      timePatterns: [
        /\b\d{1,2}:\d{2}\s*(?:AM|PM)?\b/gi,
        /\b\d+\s*(?:hours?|minutes?|seconds?)\s*ago\b/gi,
        /\b(?:Just now|Yesterday|Today|Tomorrow)\b/gi
      ],
      // Символы форматирования
      formattingSymbols: [
        /\xa0/g, /&nbsp;/g, /&[a-z]+;/gi
      ],
      // URL
      urlPatterns: [
        /\bhttps?:\/\/[^\s"]+?\b/gi, /\bwww\.[^\s"]+?\b/gi
      ]
    };
  }

  cleanContent(content, options = {}) {
    const startTime = Date.now();
    this.cleaningStats = { elementsRemoved: 0, charactersRemoved: 0, rulesApplied: 0 };
    console.log('[ContentCleaner] Starting content cleaning, initial length:', content.length);

    let textContent = content;
    if (/<\/?[a-z][\s\S]*>/i.test(content)) {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(content, 'text/html');
        doc.querySelectorAll('script,style,svg,canvas,noscript,header,footer,nav,aside,[aria-hidden="true"]').forEach(el => el.remove());
        textContent = doc.body?.textContent || '';
      } catch (err) {
        console.warn('[ContentCleaner] DOMParser failed in Perplexity cleaner, falling back to textContent', err);
        const fallbackDiv = document.createElement('div');
        fallbackDiv.textContent = content;
        textContent = fallbackDiv.textContent || '';
      }
    }

    let cleanedContent = this.cleanTextContent(textContent, options);

    if (options.maxLength && cleanedContent.length > options.maxLength) {
      cleanedContent = this.applyLengthLimit(cleanedContent, options.maxLength);
    }

    const processingTime = Date.now() - startTime;
    console.log(`[ContentCleaner] Cleaning completed in ${processingTime}ms. Final length: ${cleanedContent.length}`);
    return cleanedContent;
  }

  cleanTextContent(textContent, options) {
    let cleanedText = textContent;
    const allRules = [
      ...this.cleaningRules.uiPhrases,
      ...this.cleaningRules.timePatterns,
      ...this.cleaningRules.urlPatterns,
      ...this.cleaningRules.formattingSymbols
    ];

    allRules.forEach(pattern => {
      const originalLength = cleanedText.length;
      cleanedText = cleanedText.replace(pattern, ' ');
      this.recordRemoval(originalLength - cleanedText.length);
    });

    return this.finalNormalization(cleanedText);
  }

  recordRemoval(charactersRemoved) {
    if (charactersRemoved > 0) {
      this.cleaningStats.charactersRemoved += charactersRemoved;
      this.cleaningStats.rulesApplied++;
    }
  }

  applyLengthLimit(content, maxLength) {
    if (content.length <= maxLength) return content;
    const truncated = content.substring(0, maxLength);
    const lastSentenceEnd = Math.max(
      truncated.lastIndexOf('. '), truncated.lastIndexOf('! '),
      truncated.lastIndexOf('? '), truncated.lastIndexOf('\n\n')
    );
    if (lastSentenceEnd > maxLength * 0.7) {
      return truncated.substring(0, lastSentenceEnd + 1) + '\n\n[Content truncated]';
    }
    return truncated + '\n\n[Content truncated]';
  }

  finalNormalization(text) {
    return text
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  getCleaningStats() {
    return { ...this.cleaningStats };
  }
}
window.contentCleaner = new ContentCleaner();
//-- V3.0 END: Advanced Content Cleaning System --//

const sleep = (ms) => (window.ContentUtils?.sleep ? window.ContentUtils.sleep(ms) : new Promise((r) => setTimeout(r, ms)));
const getHumanoid = () => (typeof window !== 'undefined' ? window.Humanoid : null);
const isUserInteracting = () => {
  if (document.hidden) return true;
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
};
const keepAliveMutex = (() => {
  const key = '__keepAliveMutex';
  if (window[key]) return window[key];
  let locked = false;
  const queue = [];
  const run = async (fn) => {
    if (locked) await new Promise((res) => queue.push(res));
    locked = true;
    try { return await fn(); } finally {
      locked = false;
      const next = queue.shift();
      if (next) next();
    }
  };
  const mutex = { run };
  window[key] = mutex;
  return mutex;
})();

const runLifecycle = (source, context, executor) => {
  if (typeof window.withHumanoidActivity === 'function') {
    return window.withHumanoidActivity(source, context, executor);
  }
  return executor({
    traceId: null,
    heartbeat: () => {},
    stop: () => {},
    error: () => {}
  });
};

const pipelineExpectedLength = (text = '') => {
  const len = (text || '').length;
  if (len > 4000) return 'veryLong';
  if (len > 2000) return 'long';
  if (len > 800) return 'medium';
  return 'short';
};

  async function tryPerplexityPipeline(promptText = '', lifecycle = {}) {
    const { heartbeat, stop } = lifecycle || {};
  if (!window.UnifiedAnswerPipeline) return null;
  heartbeat?.({
    stage: 'start',
    expectedLength: pipelineExpectedLength(promptText),
    pipeline: 'UnifiedAnswerPipeline'
  });
  try {
    const pipeline = new window.UnifiedAnswerPipeline('perplexity', Object.assign({
      expectedLength: pipelineExpectedLength(promptText)
    }, pipelineOverrides));
    const result = await pipeline.execute();
    console.log("[DIAGNOSTIC] Perplexity pipeline result:", { success: result?.success, hasAnswer: !!result?.answer, answerLength: result?.answer?.length, error: result?.error });
    if (result?.success && result.answer) {
      heartbeat?.({
        stage: 'success',
        answerLength: result.answer.length,
        pipeline: 'UnifiedAnswerPipeline'
      });
      if (typeof stop === 'function') {
        await stop({
          status: 'success',
          source: 'pipeline',
          answer: result.answer,
          answerHtml: result.answerHtml || '',
          answerLength: result.answer.length
        });
      }
      return result;
    }
    heartbeat?.({
      stage: 'empty',
      status: 'no-answer',
      pipeline: 'UnifiedAnswerPipeline'
    });
  } catch (err) {
    heartbeat?.({
      stage: 'error',
      error: err?.message || String(err),
      pipeline: 'UnifiedAnswerPipeline'
    });
    console.warn('[content-perplexity] UnifiedAnswerPipeline failed, falling back to legacy watcher', err);
  }
  return null;
}

const startDriftFallback = (intensity = 'soft') => {
  const humanoid = getHumanoid();
  if (humanoid?.startAntiSleepDrift) {
    humanoid.startAntiSleepDrift(intensity);
    return;
  }
  const delta = intensity === 'hard' ? 24 : intensity === 'medium' ? 16 : 10;
  window.scrollBy({ top: (Math.random() > 0.5 ? 1 : -1) * delta, behavior: 'auto' });
};

const stopDriftFallback = () => {
  const humanoid = getHumanoid();
  humanoid?.stopAntiSleepDrift?.();
};

const createKeepAliveHeartbeat = (source) => {
  let traceId = null;
  let cleanupTimer = null;
  return (meta = {}) => {
    const lifecycle = window.HumanoidEvents;
    if (!lifecycle?.start) return;
    if (!traceId) {
      try {
        traceId = lifecycle.start(source, { mode: 'anti-sleep', source });
      } catch (err) {
        console.warn(`[${source}] keepalive trace failed`, err);
        return;
      }
    }
    try {
      lifecycle.heartbeat(traceId, meta.progress || 0, Object.assign({ phase: 'keepalive-pulse' }, meta));
    } catch (err) {
      console.warn(`[${source}] keepalive heartbeat failed`, err);
    }
    if (cleanupTimer) clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(() => {
      try { lifecycle.stop(traceId, { status: 'idle' }); } catch (_) {}
      traceId = null;
    }, 8000);
  };
};
const emitKeepAliveHeartbeat = createKeepAliveHeartbeat(`${MODEL.toLowerCase()}:keepalive`);

async function perplexityHumanRead(duration = 480) {
  const humanoid = getHumanoid();
  if (humanoid?.readPage) {
    try {
      await humanoid.readPage(duration);
    } catch (err) {
      console.warn('[content-perplexity] Humanoid.readPage failed', err);
    }
  }
}

async function perplexityHumanClick(element) {
  const humanoid = getHumanoid();
  if (!element) return;
  if (humanoid?.click) {
    try {
      await humanoid.click(element);
      return;
    } catch (err) {
      console.warn('[content-perplexity] Humanoid.click failed', err);
    }
  }
  element.click();
}

const runAntiSleepPulse = (intensity = 'soft') => {
  emitKeepAliveHeartbeat({ action: 'keep-alive-ping', intensity, model: MODEL });
  const delta = intensity === 'hard' ? 28 : intensity === 'medium' ? 16 : 8;
  try {
    const Toolkit = window.__UniversalScrollToolkit;
    if (Toolkit) {
      const tk = new Toolkit({ idleThreshold: 800, driftStepMs: 40 });
      tk.keepAliveTick?.((Math.random() > 0.5 ? 1 : -1) * delta);
      return;
    }
  } catch (_) {}
  startDriftFallback(intensity);
};

const perplexityScrollCoordinator = window.ScrollCoordinator
  ? new window.ScrollCoordinator({
      source: `${MODEL.toLowerCase()}-smart-scroll`,
      getLifecycleMode,
      registerForceStopHandler,
      startDrift: () => startDriftFallback('soft'),
      stopDrift: () => stopDriftFallback(),
      logPrefix: `[${MODEL}] SmartScroll`
    })
  : null;

async function withSmartScroll(asyncOperation, options = {}) {
  if (window.ContentUtils?.withSmartScroll) {
    return window.ContentUtils.withSmartScroll(asyncOperation, { coordinator: perplexityScrollCoordinator, ...options });
  }
  if (perplexityScrollCoordinator) {
    return perplexityScrollCoordinator.run(asyncOperation, options);
  }
  return asyncOperation();
}

function perplexityTriggerEvents(element, data = '') {
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function setContentEditableParagraphs(element, text) {
  if (!element) return;
  const doc = element.ownerDocument || document;
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
  const lines = String(text).split(/\n/);
  if (!lines.length) {
    const p = doc.createElement('p');
    p.textContent = '\u200B';
    element.appendChild(p);
    return;
  }
  lines.forEach(line => {
    const paragraph = doc.createElement('p');
    paragraph.textContent = line || '\u200B';
    element.appendChild(paragraph);
  });
}

async function fallbackPerplexityType(element, text) {
  const setNativeValue = (el, value) => {
    try {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      const setter = desc && desc.set;
      const ownSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      (ownSetter || setter)?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_) {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  try {
    element.focus({ preventScroll: true });
  } catch (_) {
    element.focus?.();
  }
  await sleep(80);
  if ('value' in element) {
    setNativeValue(element, text);
  } else {
    setContentEditableParagraphs(element, text);
  }
  perplexityTriggerEvents(element, text);
  await sleep(150);
}

async function perplexityHumanType(element, text, options = {}) {
  const humanoid = getHumanoid();
  if (humanoid?.typeText) {
    try {
      await humanoid.typeText(element, text, options);
      return;
    } catch (err) {
      console.warn('[content-perplexity] Humanoid.typeText failed', err);
    }
  }
  await fallbackPerplexityType(element, text);
}

// ---- Attachment helpers ---- //
const parseDataUrlToBytes = (dataUrl = '') => {
  try {
    const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    const base64Part = match ? match[2] : dataUrl;
    const binary = atob(base64Part || '');
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch (err) {
    console.warn('[content-perplexity] Failed to parse data URL', err);
    return null;
  }
};

const hydrateAttachments = (raw = []) =>
    raw
        .map((item) => {
            if (!item || !item.name || !item.base64) return null;
            try {
                const bytes = parseDataUrlToBytes(item.base64);
                if (!bytes) return null;
                return new File([bytes], item.name, { type: item.type || 'application/octet-stream' });
            } catch (err) {
                console.warn('[content-perplexity] Failed to hydrate attachment', item?.name, err);
                return null;
            }
        })
        .filter(Boolean);

const waitForElement = async (selectors, timeoutMs = 3000, intervalMs = 150) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    await sleep(intervalMs);
  }
  return null;
};

// ---- Main world bridge (drop/text) ---- //
async function ensureMainWorldBridge() {
  if (window.__extMainBridgeInjected) return true;
  const existing = document.querySelector('script[data-ext-main-bridge="1"]');
  if (existing) {
    window.__extMainBridgeInjected = true;
    return true;
  }
  return new Promise((resolve) => {
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('content-scripts/content-bridge.js');
      script.async = true;
      script.dataset.extMainBridge = '1';
      script.onload = () => {
        window.__extMainBridgeInjected = true;
        resolve(true);
      };
      script.onerror = () => resolve(false);
      (document.head || document.documentElement).appendChild(script);
    } catch (_) {
      resolve(false);
    }
  });
}

async function attachFilesToComposer(target, attachments = []) {
  if (!attachments || !attachments.length) return false;
  const files = hydrateAttachments(attachments).slice(0, 5);
  if (!files.length) return false;

  await ensureMainWorldBridge();
  try {
    window.dispatchEvent(new CustomEvent('EXT_ATTACH', {
      detail: {
        attachments,
        dropSelectors: [
          'textarea[data-testid="search-input"]',
          'form[role="search"] textarea',
          'div[contenteditable="true"][role="textbox"]',
          'div[contenteditable="true"]',
          'textarea',
          'main',
          'form',
          'body',
          'html'
        ],
        attachSelectors: [
          'button[aria-label*="Attach"]',
          'button[data-testid*="attach"]',
          'button[data-testid*="upload"]',
          'button[aria-label*="Upload"]'
        ],
        inputSelectors: [
          'input[type="file"][accept*="image"]',
          'input[type="file"][accept*="pdf"]',
          'input[type="file"]'
        ]
      }
    }));
  } catch (_) {}

    const makeDataTransfer = () => {
        const dt = new DataTransfer();
        files.forEach((f) => {
            try { dt.items.add(f); } catch (_) {}
        });
        dt.effectAllowed = 'copy';
        return dt;
    };

    const dispatchPasteSequence = async (targets = []) => {
        const dt = makeDataTransfer();
        const factory = () => {
            const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
            if (!ev.clipboardData) {
                try { Object.defineProperty(ev, 'clipboardData', { value: dt }); } catch (_) {}
            } else if (dt.items?.length) {
                dt.items.forEach((item) => ev.clipboardData.items.add(item.getAsFile()));
            }
            return ev;
        };
        for (const el of targets) {
            if (!el) continue;
            try {
                el.dispatchEvent(factory());
                await sleep(100);
                el.dispatchEvent(factory());
                await sleep(1200);
                return true;
            } catch (err) {
                console.warn('[content-perplexity] paste dispatch failed', err);
            }
        }
        return false;
    };

    const dispatchDropSequence = async (el) => {
        if (!el) return false;
        const dt = makeDataTransfer();
        try {
            for (const type of ['dragenter', 'dragover', 'drop']) {
                const rect = el.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
                const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
                el.dispatchEvent(ev);
                await sleep(40);
            }
            await sleep(1400);
            return true;
    } catch (err) {
      console.warn('[content-perplexity] drop dispatch failed', err);
      return false;
    }
  };

    const dropTargets = [
        target,
        target?.parentElement,
        ...Array.from(document.querySelectorAll('[contenteditable="true"], textarea')),
        document.querySelector('main'),
        document.querySelector('form'),
        document.body,
        document.documentElement
    ].filter(Boolean);
    for (const el of dropTargets) {
        if (await dispatchDropSequence(el)) return true;
    }
    if (await dispatchPasteSequence(dropTargets)) return true;

  const attachButtonSelectors = [
    'button[aria-label*="Attach"]',
    'button[data-testid*="attach"]',
    'button[data-testid*="upload"]',
    'button[aria-label*="Upload"]'
  ];
  const inputSelectors = [
    'input[type="file"][accept*="image"]',
    'input[type="file"][accept*="pdf"]',
    'input[type="file"]'
  ];

  const attachButton = await waitForElement(attachButtonSelectors, 1200, 120);
  if (attachButton) {
    try { attachButton.click(); await sleep(300); } catch (_) {}
  }

    const allInputs = Array.from(document.querySelectorAll('input[type="file"]'));
    const fileInput = await waitForElement(inputSelectors, 3000, 120) || allInputs[0];
    if (!fileInput) {
        console.warn('[content-perplexity] File input not found, skipping attachments');
        return false;
    }

    const dt = makeDataTransfer();
    try { fileInput.files = dt.files; } catch (err) { console.warn('[content-perplexity] set files failed', err); }
    try {
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (err) {
        console.warn('[content-perplexity] input/change dispatch failed', err);
    }
    try { fileInput.focus?.({ preventScroll: true }); } catch (_) { try { fileInput.focus?.(); } catch (_) {} }
    await sleep(1800);
    return true;
}

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
function isElementInteractable(element) {
  if (window.ContentUtils?.isElementInteractable) return window.ContentUtils.isElementInteractable(element);
  //-- 4. Нативная установка значения для React-контролируемых textarea -//
function setNativeValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
              || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
              || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

  if (!element) return false;
  if (element.offsetParent === null) return false;
  if (element.getAttribute('disabled') !== null) return false;
  if (element.style.display === 'none') return false;
  if (element.style.visibility === 'hidden') return false;
  const rect = element.getBoundingClientRect();
  return rect.top >= 0 && rect.left >= 0 &&
    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth);
}

// --- Self-Healing Selector Logic ---
async function findAndCacheElement(selectorKey, selectorArray, timeout = 30000) {
  if (window.ContentUtils?.findAndCacheElement) {
    const found = await window.ContentUtils.findAndCacheElement(selectorKey, selectorArray, { timeout, model: MODEL });
    if (found) return found;
    throw new Error(`Element not found for '${selectorKey}'`);
  }
  const storageKey = `selector_cache_${MODEL}_${selectorKey}`;
  try {
    const result = await chrome.storage.local.get(storageKey);
    const cachedSelector = result[storageKey];
    if (cachedSelector) {
      const el = document.querySelector(cachedSelector);
      if (el && isElementInteractable(el)) {
        console.log(`[Self-Healing] Found element using cached selector for '${selectorKey}'`);
        return el;
      }
    }
  } catch (e) { console.warn('[content-perplexity] Storage access failed, continuing without cache'); }

  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const selector of selectorArray) {
      try {
        const el = document.querySelector(selector);
        if (el && isElementInteractable(el)) {
          console.log(`[Self-Healing] Found element with '${selector}'. Caching for '${selectorKey}'.`);
          try { await chrome.storage.local.set({ [storageKey]: selector }); } catch (e) {}
          return el;
        }
      } catch (error) { console.warn(`[content-perplexity] Selector error for ${selector}:`, error); }
    }
    await sleep(1000);
  }
  throw new Error(`Element not found for '${selectorKey}' with any selector`);
}

// --- ОСНОВНАЯ ФУНКЦИЯ ОБРАБОТКИ ---
async function injectAndGetResponse(prompt, attachments = [], meta = null) {
  const dispatchMeta = meta && typeof meta === 'object' ? meta : null;
  return runLifecycle('perplexity:inject', buildLifecycleContext(prompt), async (activity) => {
    console.log('[content-perplexity] Starting Perplexity injection process');
    try {
    await sleep(120);

    // Ввод: Perplexity может использовать textarea или contenteditable
    const inputSelectors = [
      'textarea[data-testid="search-input"]',
      'form[role="search"] textarea',
      'form textarea[placeholder*="Ask"]',
      'div[contenteditable="true"][role="textbox"]'
    ];

    // Кнопка отправки (иконка-стрелка, submit, aria-label)
    const sendButtonSelectors = [
      'button[type="submit"]',
      'button[aria-label*="Send"]',
      'button[data-testid="send-button"]',
      'form button:has(svg)',
      'button:has([data-icon="send"])'
    ];

    console.log('[content-perplexity] Looking for input field...');
    activity.heartbeat(0.2, { phase: 'composer-search' });
    const inputField = await findAndCacheElement('inputField', inputSelectors)
      .catch(err => { throw { type: 'selector_not_found', message: 'Perplexity input field not found' }; });

    try { await attachFilesToComposer(inputField, attachments); } catch (err) { console.warn('[content-perplexity] attach failed', err); }

    console.log('[content-perplexity] Input field found. Injecting prompt...');
    await fallbackPerplexityType(inputField, prompt);
    activity.heartbeat(0.3, { phase: 'typing' });
    await sleep(100);
    const __val = (inputField.value ?? inputField.textContent ?? '').trim();
    if (!__val.length) {
      throw { type: 'injection_failed', message: 'Textarea did not accept value (React guard).' };
    }
    await sleep(2000);

    const dispatchEnter = (mods = {}) => {
      inputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, ctrlKey: !!mods.ctrlKey }));
      inputField.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, ctrlKey: !!mods.ctrlKey }));
    };

    const confirmPerplexitySend = async (sendButtonCandidate, timeout = 2000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const typing = document.querySelector('[aria-busy="true"], .loading-indicator, [data-testid="loading-indicator"], [data-generating="true"], [class*="streaming" i]');
        if (typing) return true;
        if (sendButtonCandidate && (sendButtonCandidate.disabled || sendButtonCandidate.getAttribute?.('aria-disabled') === 'true')) return true;
        const current = (inputField.value ?? inputField.textContent ?? '').trim();
        if (!current.length) return true;
        await sleep(120);
      }
      return false;
    };

    console.log('[content-perplexity] Trying Ctrl+Enter send');
    dispatchEnter({ ctrlKey: true });
    let confirmed = await confirmPerplexitySend(null);
    let sendButton = null;
    if (!confirmed) {
      console.log('[content-perplexity] Ctrl+Enter not confirmed, looking for send button');
      activity.heartbeat(0.4, { phase: 'send-button-search' });
      sendButton = await findAndCacheElement('sendButton', sendButtonSelectors).catch(() => null);
      if (sendButton) {
        await perplexityHumanClick(sendButton);
        confirmed = await confirmPerplexitySend(sendButton);
      }
    }
    if (!confirmed) {
      console.warn('[content-perplexity] Send not confirmed, using Enter fallback');
      dispatchEnter();
      confirmed = await confirmPerplexitySend(sendButton);
    }
    activity.heartbeat(0.55, { phase: 'send-dispatched' });
    try { chrome.runtime.sendMessage({ type: 'PROMPT_SUBMITTED', llmName: MODEL, ts: Date.now(), meta: dispatchMeta }); } catch (_) {}

    console.log('[content-perplexity] Message sent, waiting for response...');
    activity.heartbeat(0.6, { phase: 'waiting-response' });

    let pipelineAnswer = null;
    await tryPerplexityPipeline(prompt, {
      heartbeat: (meta = {}) => activity.heartbeat(0.8, Object.assign({ phase: 'pipeline' }, meta)),
      stop: async ({ answer, answerHtml }) => {
        console.log('[content-perplexity] UnifiedAnswerPipeline captured response, skipping legacy watcher');
        const cleanedPipelineResponse = window.contentCleaner.cleanContent(answer, {
          maxLength: 50000
        });
        const html = String(answerHtml || '').trim();
        if (html) lastResponseHtml = html;
        pipelineAnswer = { text: cleanedPipelineResponse, html };
        activity.stop({ status: 'success', answerLength: cleanedPipelineResponse.length, source: 'pipeline' });
        return pipelineAnswer;
      }
    });
    if (pipelineAnswer) {
      return pipelineAnswer;
    }

    // Fallback: extract latest assistant text if pipeline missed it
    try {
      const latestMarkup = grabLatestAssistantMarkup();
      const cleanedFallback = window.contentCleaner.cleanContent(latestMarkup.html || latestMarkup.text || '', { maxLength: 50000 });
      if (cleanedFallback) {
        console.warn('[content-perplexity] Pipeline empty, using DOM fallback');
        if (latestMarkup.html) lastResponseHtml = latestMarkup.html;
        activity.stop({ status: 'success', answerLength: cleanedFallback.length, source: 'dom-fallback' });
        return { text: cleanedFallback, html: latestMarkup.html || '' };
      }
    } catch (fallbackErr) {
      console.warn('[content-perplexity] DOM fallback failed', fallbackErr);
    }

    // Last resort: SelectorFinder observation-based extraction (can traverse shadow DOM).
    try {
      const finderText = await trySelectorFinderResponse(prompt, 60000);
      const cleanedFinder = window.contentCleaner.cleanContent(finderText || '', { maxLength: 50000 });
      if (cleanedFinder) {
        console.warn('[content-perplexity] DOM fallback empty, using SelectorFinder response');
        activity.stop({ status: 'success', answerLength: cleanedFinder.length, source: 'selector-finder' });
        return cleanedFinder;
      }
    } catch (finderErr) {
      console.warn('[content-perplexity] SelectorFinder fallback crashed', finderErr);
    }

    throw new Error('Pipeline did not return answer');

  } catch (error) {
    if (error?.code === 'background-force-stop') {
      activity.error(error, false);
      throw error;
    }
    console.error('[content-perplexity] Error in injectAndGetResponse:', error);
    activity.error(error, true);
    throw error;
  }
  });
}

// --- ОБРАБОТЧИК СООБЩЕНИЙ ---
const onRuntimeMessage = (message, sender, sendResponse) => {
  if (!message) return false;
  console.log('[content-perplexity] Received:', message.type);

  if (message?.type === 'STOP_AND_CLEANUP') {
    handleForceStopMessage(message.payload?.traceId);
    stopContentScript('manual-toggle');
    if (typeof sendResponse === 'function') {
      sendResponse({ status: 'cleaned', llmName: MODEL });
    }
    return false;
  }

  if (message?.type === 'HUMANOID_FORCE_STOP') {
    handleForceStopMessage(message.payload?.traceId);
    if (typeof sendResponse === 'function') {
      sendResponse({ status: 'force_stop_ack' });
    }
    return false;
  }

  if (message?.type === 'HEALTH_CHECK_PING') {
    sendResponse({ type: 'HEALTH_CHECK_PONG', pingId: message.pingId, llmName: MODEL });
    return true;
  }

  if (message?.type === 'ANTI_SLEEP_PING') {
    if (window.__LLMScrollHardStop) return false;
    if (isUserInteracting()) {
      stopDriftFallback();
      return false;
    }
    keepAliveMutex.run(async () => {
      runAntiSleepPulse(message.intensity || 'soft');
    });
    return false;
  }

  if (message.type === 'GET_ANSWER' || message.type === 'GET_FINAL_ANSWER') {
    injectAndGetResponse(message.prompt, message.attachments, message.meta || null)
      .then(result => {
        if (message.isFireAndForget) {
          sendResponse?.({ status: 'success_fire_and_forget' });
          return;
        }
        const responseType = message.type === 'GET_ANSWER' ? 'LLM_RESPONSE' : 'FINAL_LLM_RESPONSE';

        const stats = window.contentCleaner.getCleaningStats();
        chrome.runtime.sendMessage({
          type: 'CONTENT_CLEANING_STATS', llmName: MODEL, stats: stats, timestamp: Date.now()
        });

        const payload = normalizeResponsePayload(result, lastResponseHtml);
        chrome.runtime.sendMessage({
          type: responseType,
          llmName: MODEL,
          answer: payload.text,
          answerHtml: payload.html,
          meta: message.meta || null
        });
        sendResponse?.({ status: 'success' });
      })
      .catch(error => {
        if (error?.code === 'background-force-stop') {
          sendResponse?.({ status: 'force_stopped' });
          return;
        }
        const errorMessage = error.message || 'Unknown error in Perplexity content script';
        const responseType = message.type === 'GET_ANSWER' ? 'LLM_RESPONSE' : 'FINAL_LLM_RESPONSE';

        chrome.runtime.sendMessage({
          type: responseType, llmName: MODEL, answer: `Error: ${errorMessage}`,
          error: { type: error.type || 'generic_error', message: errorMessage },
          meta: message.meta || null
        });
        sendResponse?.({ status: 'error', message: errorMessage });
      });
    return true; // Для асинхронной обработки
  }

  return false;
};
chrome.runtime.onMessage.addListener(onRuntimeMessage);
cleanupScope.register?.(() => {
  try {
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  } catch (_) {}
});

// --- БАЗОВЫЙ HEARTBEAT ДЛЯ АКТИВНОСТИ ---
function startBasicHeartbeat() { return; }

console.log('[content-perplexity] Initialization complete');

// v2.54.1 (2025-12-19 19:50): КРИТИЧЕСКОЕ - Early ready signal для Perplexity
// Perplexity ждал 30+ секунд без этого сигнала - теперь отправка за 0.5-1.5s
(async () => {
  const checkReady = async () => {
    if (document.readyState !== 'loading') {
      // Perplexity использует textarea с data-testid="search-input" или form[role="search"] textarea
      const textarea = document.querySelector('textarea[data-testid="search-input"]')
                    || document.querySelector('form[role="search"] textarea')
                    || document.querySelector('form textarea[placeholder*="Ask"]');
      const sendButton = document.querySelector('button[type="submit"]');

      if (textarea && sendButton) {
        try {
          chrome.runtime.sendMessage({
            type: 'SCRIPT_READY_EARLY',
            llmName: MODEL
          });
          console.log('[content-perplexity] ⚡ Early ready signal sent');
          return true;
        } catch (err) {
          console.warn('[content-perplexity] Failed to send early ready signal:', err);
        }
      }
    }
    return false;
  };

  // Try immediately
  if (await checkReady()) return;

  // If not ready, wait up to 2 seconds
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await sleep(250);
    if (await checkReady()) return;
  }
})();
