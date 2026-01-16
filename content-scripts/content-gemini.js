//-- Защита от дублирования, адаптированная из Claude --//
const resolveExtensionVersion = () => {
    try {
        return chrome?.runtime?.getManifest?.()?.version || 'unknown';
    } catch (_) {
        return 'unknown';
    }
};
if (window.geminiContentScriptLoaded) {
    console.warn('[content-gemini] Script already loaded, skipping duplicate initialization');
    throw new Error('Duplicate script load prevented');
}
window.geminiContentScriptLoaded = {
    timestamp: Date.now(),
    version: resolveExtensionVersion(),
    source: 'content-gemini'
};
console.log('[content-gemini] First load, initializing...');
//-- Конец защиты --//

const MODEL = "Gemini";
const GEMINI_FALLBACK_LAST_MESSAGE_SELECTORS = [
  '[data-test-id*="model-response"]',
  '[data-testid*="model-response"]',
  '.model-response',
  'model-response',
  'message-content',
  '[data-message-author-role="assistant"]',
  '[data-role="assistant"]'
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
    const selectorsFromBundle = (window.AnswerPipelineSelectors?.PLATFORM_SELECTORS?.gemini?.lastMessage
      ? [window.AnswerPipelineSelectors.PLATFORM_SELECTORS.gemini.lastMessage]
      : []).flat().filter(Boolean);
    const candidates = selectorsFromBundle.length ? selectorsFromBundle : GEMINI_FALLBACK_LAST_MESSAGE_SELECTORS;
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
    console.warn('[content-gemini] grabLatestAssistantMarkup failed', err);
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
    console.warn('[content-gemini] SelectorFinder response fallback failed', err);
    return '';
  }
}

// --- Idempotency / singleflight (prevents periodic re-insertion on duplicate GET_ANSWER) ---
let geminiSharedInjection = null;
let geminiSharedFingerprint = null;
let geminiSharedStartedAt = 0;
let lastResponseHtml = '';
let geminiLastSubmittedFingerprint = null;
let geminiLastSubmittedAt = 0;
let geminiSessionId = null;
const GEMINI_SUBMIT_DEDUPE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function quickHash(s) {
  const str = String(s || '');
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function fingerprintPrompt(prompt = '') {
  const s = String(prompt || '');
  return `${s.length}:${quickHash(s.slice(0, 600))}`;
}

function readComposerText(el) {
  if (!el) return '';
  try {
    if ('value' in el) return String(el.value || '').trim();
  } catch (_) {}
  try {
    const raw = (el.innerText || el.textContent || '');
    return String(raw).replace(/\u200B/g, '').trim();
  } catch (_) {
    return '';
  }
}

function ensureSession(nextSessionId) {
  if (!nextSessionId) return;
  if (geminiSessionId === nextSessionId) return;
  geminiSessionId = nextSessionId;
  geminiSharedInjection = null;
  geminiSharedFingerprint = null;
  geminiSharedStartedAt = 0;
  geminiLastSubmittedFingerprint = null;
  geminiLastSubmittedAt = 0;
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
  const getPragPlatform = () => prag?.adapter?.name || 'gemini';
  const pipelineOverrides = prag
    ? { sessionId: getPragSessionId(), platform: getPragPlatform(), llmName: MODEL }
    : { llmName: MODEL };
const buildLifecycleContext = (prompt = '', extra = {}) => ({
  promptLength: prompt?.length || 0,
  evaluator: Boolean(extra.evaluator),
  mode: extra.mode || getLifecycleMode()
});
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
  console.warn('[content-gemini] Cleanup triggered:', reason);
  try {
    getForceStopRegistry().run(reason);
  } catch (_) {}
  try {
    cleanupScope.cleanup?.(reason);
  } catch (err) {
    console.warn('[content-gemini] Cleanup scope failed', err);
  }
  try {
    window.geminiContentScriptLoaded = null;
  } catch (_) {}
  return reason;
};
window.__cleanup_gemini = stopContentScript;
cleanupScope.addEventListener?.(window, 'pagehide', () => stopContentScript('pagehide'));
cleanupScope.addEventListener?.(window, 'beforeunload', () => stopContentScript('beforeunload'));

async function tryGeminiPipeline(promptText = '', lifecycle = {}) {
  const { heartbeat, stop } = lifecycle || {};
  if (!window.UnifiedAnswerPipeline) return null;
  heartbeat?.({
    stage: 'start',
    expectedLength: pipelineExpectedLength(promptText),
    pipeline: 'UnifiedAnswerPipeline'
  });
  try {
    const pipeline = new window.UnifiedAnswerPipeline('gemini', Object.assign({
      expectedLength: pipelineExpectedLength(promptText)
    }, pipelineOverrides));
    const result = await pipeline.execute();
    console.log("[DIAGNOSTIC] Gemini pipeline result:", { success: result?.success, hasAnswer: !!result?.answer, answerLength: result?.answer?.length, error: result?.error });
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
          answerLength: result.answer.length,
          metadata: result.metadata
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
    console.warn('[content-gemini] UnifiedAnswerPipeline failed, using legacy watcher', err);
  }
  return null;
}

async function geminiHumanRead(duration = 500) {
  const humanoid = getHumanoid();
  if (humanoid?.readPage) {
    try {
      await humanoid.readPage(duration);
    } catch (err) {
      console.warn('[content-gemini] Humanoid.readPage failed', err);
    }
  }
}

async function geminiHumanClick(element) {
  const humanoid = getHumanoid();
  if (!element) return;
  if (humanoid?.click) {
    try {
      await humanoid.click(element);
      return;
    } catch (err) {
      console.warn('[content-gemini] Humanoid.click failed', err);
    }
  }
  element.click();
}

const geminiScrollCoordinator = window.ScrollCoordinator
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
        return window.ContentUtils.withSmartScroll(asyncOperation, { coordinator: geminiScrollCoordinator, ...options });
    }
    if (geminiScrollCoordinator) {
        return geminiScrollCoordinator.run(asyncOperation, options);
    }
    return asyncOperation();
}
function setContentEditableParagraphs(element, text) {
  if (!element) return;
  const doc = element.ownerDocument || document;
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
  const lines = String(text).split(/\n/);
  if (lines.length === 0) {
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

async function fallbackTypeGemini(element, text) {
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
  await sleep(350);
  if ('value' in element) {
    setNativeValue(element, text);
  } else {
    setContentEditableParagraphs(element, text);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
  await sleep(180);
}

async function geminiHumanType(element, text, options = {}) {
  const humanoid = getHumanoid();
  if (humanoid?.typeText) {
    try {
      await humanoid.typeText(element, text, options);
      return;
    } catch (err) {
      console.warn('[content-gemini] Humanoid.typeText failed', err);
    }
  }
  await fallbackTypeGemini(element, text);
}

const startDriftFallback = (intensity = 'soft') => {
  const humanoid = getHumanoid();
  if (humanoid?.startAntiSleepDrift) {
    humanoid.startAntiSleepDrift(intensity);
    return;
  }
  window.scrollBy({ top: (Math.random() > 0.5 ? 1 : -1) * (intensity === 'hard' ? 24 : 12), behavior: 'auto' });
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

//-- V3.0 START: Advanced Content Cleaning System (перенесено из Claude) --//
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
                /\b(Gemini|Google)\b/gi // Адаптировано для Gemini
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
                /\bhttps?:\/\/[^\s<>"]+?\b/gi, /\bwww\.[^\s<>"]+?\b/gi
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
                console.warn('[ContentCleaner] DOMParser failed in Gemini cleaner, using text fallback', err);
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

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (перенесено из Claude) ---
function isElementInteractable(element) {
    if (window.ContentUtils?.isElementInteractable) return window.ContentUtils.isElementInteractable(element);
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

// --- Self-Healing Selector Logic (улучшенная версия из Claude) ---
async function findAndCacheElement(selectorKey, selectorArray, timeout = 30000) {
    if (window.ContentUtils?.findAndCacheElement) {
        const found = await window.ContentUtils.findAndCacheElement(selectorKey, selectorArray, { timeout, model: MODEL });
        if (found) return found;
        throw new Error(`Element not found for '${selectorKey}' with any selector`);
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
    } catch (e) { console.warn('[content-gemini] Storage access failed, continuing without cache'); }

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
            } catch (error) { console.warn(`[content-gemini] Selector error for ${selector}:`, error); }
        }
        await sleep(1000);
    }
    throw new Error(`Element not found for '${selectorKey}' with any selector`);
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
        console.warn('[content-gemini] Failed to parse data URL', err);
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
                console.warn('[content-gemini] Failed to hydrate attachment', item?.name, err);
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
    if (window.ContentUtils?.ensureMainWorldBridge) {
        try { await window.ContentUtils.ensureMainWorldBridge(); } catch (_) {}
        return;
    }
    if (window.__extMainBridgeInjected) return;
    if (window.__extMainBridgePromise) return window.__extMainBridgePromise;
    window.__extMainBridgePromise = new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('content-scripts/content-bridge.js');
        script.onload = () => {
            window.__extMainBridgeInjected = true;
            script.remove();
            resolve(true);
        };
        script.onerror = (err) => {
            console.warn('[content-gemini] Failed to load main bridge', err);
            script.remove();
            resolve(false);
        };
        (document.head || document.documentElement || document.body).appendChild(script);
    }).finally(() => {
        window.__extMainBridgePromise = null;
    });
    await window.__extMainBridgePromise;
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
                    'div[contenteditable=\"true\"]',
                    'textarea',
                    '[role=\"textbox\"]',
                    'main',
                    'form',
                    'body',
                    'html'
                ],
                attachSelectors: [
                    'button[aria-label*=\"Attach\"]',
                    'button[data-testid*=\"attach\"]',
                    'button[data-testid*=\"upload\"]',
                    'button[aria-label*=\"Upload\"]'
                ],
                inputSelectors: [
                    'input[type=\"file\"][accept*=\"image\"]',
                    'input[type=\"file\"][accept*=\"pdf\"]',
                    'input[type=\"file\"]'
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
                console.warn('[content-gemini] paste dispatch failed', err);
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
            console.warn('[content-gemini] drop dispatch failed', err);
            return false;
        }
    };

    const dropTargets = [
        target,
        target?.parentElement,
        ...Array.from(document.querySelectorAll('[contenteditable=\"true\"], textarea')),
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
        console.warn('[content-gemini] File input not found, skipping attachments');
        return false;
    }

    const dt = makeDataTransfer();
    try { fileInput.files = dt.files; } catch (err) { console.warn('[content-gemini] set files failed', err); }
    try {
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (err) {
        console.warn('[content-gemini] input/change dispatch failed', err);
    }
    try { fileInput.focus?.({ preventScroll: true }); } catch (_) { try { fileInput.focus?.(); } catch (_) {} }
    await sleep(1800);
    return true;
}

// --- ОСНОВНАЯ ФУНКЦИЯ ОБРАБОТКИ (сохранена логика Gemini, улучшена структура) ---
async function injectAndGetResponse(prompt, attachments = [], meta = null) {
    const dispatchMeta = meta && typeof meta === 'object' ? meta : null;
    const sessionKey = dispatchMeta?.sessionId ? String(dispatchMeta.sessionId) : 'no_session';
    const fp = `${sessionKey}:${fingerprintPrompt(prompt)}`;
    if (geminiSharedInjection && fp === geminiSharedFingerprint && Date.now() - geminiSharedStartedAt < 30000) {
        console.warn('[content-gemini] Reusing in-flight injection promise');
        return geminiSharedInjection;
    }
    geminiSharedFingerprint = fp;
    geminiSharedStartedAt = Date.now();

    const opPromise = runLifecycle('gemini:inject', buildLifecycleContext(prompt), async (activity) => {
        console.log('[content-gemini] Starting Gemini injection process');
        try {
        // If this exact prompt was already submitted recently, do not touch the composer again.
        if (geminiLastSubmittedFingerprint === fp && (Date.now() - geminiLastSubmittedAt) < GEMINI_SUBMIT_DEDUPE_WINDOW_MS) {
            console.warn('[content-gemini] Duplicate GET_ANSWER detected; skipping re-insert and re-send');
            try { chrome.runtime.sendMessage({ type: 'PROMPT_SUBMITTED', llmName: MODEL, ts: Date.now(), meta: dispatchMeta }); } catch (_) {}
            activity.heartbeat(0.6, { phase: 'waiting-response' });
            let pipelineAnswer = null;
            await tryGeminiPipeline(prompt, {
                heartbeat: (meta = {}) => activity.heartbeat(0.85, Object.assign({ phase: 'pipeline' }, meta)),
                stop: async ({ answer, answerHtml, metadata }) => {
                    console.log('[content-gemini] UnifiedAnswerPipeline captured response (dedupe path)', metadata || {});
                    const cleanedResponse = window.contentCleaner.cleanContent(answer, { maxLength: 50000 });
                    const html = String(answerHtml || '').trim();
                    if (html) lastResponseHtml = html;
                    pipelineAnswer = { text: cleanedResponse, html };
                    activity.stop({ status: 'success', answerLength: cleanedResponse.length, source: 'pipeline' });
                    return pipelineAnswer;
                }
            });
            if (pipelineAnswer) return pipelineAnswer;
            throw new Error('Pipeline did not return answer');
        }

        await sleep(1000);

        const inputSelectors = [
            'div.ql-editor[contenteditable="true"]',
            'rich-textarea div[contenteditable="true"]',
            'div[contenteditable="true"][role="textbox"]'
        ];
        const sendButtonSelectors = [
            'button[data-testid="send-button"]',
            'button.send-button',
            'button:has(mat-icon[svgicon="send"])', // Более специфичный для Gemini
            'button[aria-label*="Send"]'
        ];

        console.log('[content-gemini] Looking for input field...');
        activity.heartbeat(0.2, { phase: 'composer-search' });
        const inputField = await findAndCacheElement('inputField', inputSelectors)
            .catch(err => { throw { type: 'selector_not_found', message: 'Gemini input field not found' }; });
        
        try { await attachFilesToComposer(inputField, attachments); } catch (err) { console.warn('[content-gemini] attach failed', err); }

        console.log('[content-gemini] Input field found. Injecting prompt...');
        try {
            await ensureMainWorldBridge();
            window.dispatchEvent(new CustomEvent('EXT_SET_TEXT', {
                detail: {
                    text: prompt,
                    selectors: [
                        'div[contenteditable="true"]',
                        'textarea',
                        '[role="textbox"]',
                        'main'
                    ]
                }
            }));
            await sleep(150);
        } catch (err) {
            console.warn('[content-gemini] main-world text setter failed', err);
        }
        
        // Avoid double-typing if the main-world setter already populated the composer.
        const afterSetter = readComposerText(inputField);
        if (!afterSetter || afterSetter.slice(0, Math.min(afterSetter.length, 24)) !== String(prompt || '').slice(0, Math.min(24, String(prompt || '').length))) {
            await geminiHumanType(inputField, prompt, { wpm: 115 });
        }
        activity.heartbeat(0.4, { phase: 'typing' });

        await sleep(2000);

        const confirmGeminiSend = async (sendButtonCandidate, timeout = 2000) => {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                const typing = document.querySelector('[aria-busy="true"], .loading, .spinner, [data-is-loading="true"], [data-streaming="true"]');
                if (typing) return true;
                if (sendButtonCandidate?.disabled || sendButtonCandidate?.getAttribute?.('aria-disabled') === 'true') return true;
                const current = readComposerText(inputField);
                if (!current.length) return true;
                await sleep(120);
            }
            return false;
        };

        const tryCtrlEnterSend = async () => {
            try { inputField.focus?.({ preventScroll: true }); } catch (_) { try { inputField.focus?.(); } catch (_) {} }
            inputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, ctrlKey: true }));
            inputField.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, ctrlKey: true }));
        };

        console.log('[content-gemini] Trying Ctrl+Enter send');
        await tryCtrlEnterSend();
        let confirmed = await confirmGeminiSend(null);
        let sendButton = null;
        if (!confirmed) {
            console.log('[content-gemini] Ctrl+Enter not confirmed, looking for send button');
            activity.heartbeat(0.55, { phase: 'send-button-search' });
            sendButton = await findAndCacheElement('sendButton', sendButtonSelectors).catch(() => null);
            if (sendButton) {
                await geminiHumanClick(sendButton);
                confirmed = await confirmGeminiSend(sendButton);
            }
        }
        if (!confirmed) {
            console.warn('[content-gemini] Send not confirmed, using Enter fallback');
            inputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            inputField.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            confirmed = await confirmGeminiSend(sendButton);
        }
        activity.heartbeat(0.6, { phase: 'send-dispatched' });
        geminiLastSubmittedFingerprint = fp;
        geminiLastSubmittedAt = Date.now();
        try { chrome.runtime.sendMessage({ type: 'PROMPT_SUBMITTED', llmName: MODEL, ts: Date.now(), meta: dispatchMeta }); } catch (_) {}

        console.log('[content-gemini] Message sent, waiting for response...');
        activity.heartbeat(0.7, { phase: 'waiting-response' });

        let pipelineAnswer = null;
        await tryGeminiPipeline(prompt, {
            heartbeat: (meta = {}) => activity.heartbeat(0.85, Object.assign({ phase: 'pipeline' }, meta)),
            stop: async ({ answer, answerHtml, metadata }) => {
                console.log('[content-gemini] UnifiedAnswerPipeline captured response, skipping legacy wait', metadata || {});
                const cleanedResponse = window.contentCleaner.cleanContent(answer, {
                    maxLength: 50000
                });
                const html = String(answerHtml || '').trim();
                if (html) lastResponseHtml = html;
                pipelineAnswer = { text: cleanedResponse, html };
                activity.stop({ status: 'success', answerLength: cleanedResponse.length, source: 'pipeline' });
                return pipelineAnswer;
            }
        });
        if (pipelineAnswer) {
            return pipelineAnswer;
        }
        // Fallback: read last assistant message if pipeline missed
        try {
          const latestMarkup = grabLatestAssistantMarkup();
          const cleanedFallback = window.contentCleaner.cleanContent(latestMarkup.html || latestMarkup.text || '', { maxLength: 50000 });
          if (cleanedFallback) {
            console.warn('[content-gemini] Pipeline empty, using DOM fallback');
            if (latestMarkup.html) lastResponseHtml = latestMarkup.html;
            activity.stop({ status: 'success', answerLength: cleanedFallback.length, source: 'dom-fallback' });
            return { text: cleanedFallback, html: latestMarkup.html || '' };
          }
        } catch (fallbackErr) {
          console.warn('[content-gemini] DOM fallback failed', fallbackErr);
        }
        // Last resort: SelectorFinder observation-based extraction (can traverse shadow DOM).
        try {
          const finderText = await trySelectorFinderResponse(prompt, 60000);
          const cleanedFinder = window.contentCleaner.cleanContent(finderText || '', { maxLength: 50000 });
          if (cleanedFinder) {
            console.warn('[content-gemini] DOM fallback empty, using SelectorFinder response');
            activity.stop({ status: 'success', answerLength: cleanedFinder.length, source: 'selector-finder' });
            return cleanedFinder;
          }
        } catch (finderErr) {
          console.warn('[content-gemini] SelectorFinder fallback crashed', finderErr);
        }
        throw new Error('Pipeline did not return answer');
        } catch (error) {
        if (error?.code === 'background-force-stop') {
            activity.error(error, false);
            throw error;
        }

        // Only fatal errors (selector/injection) set error status
        // Other errors handled by handleLLMResponse
        const isFatal = String(error).includes('selector') || String(error).includes('injection');

        if (isFatal) {
            activity.error(error, true);
        } else {
            activity.stop({ status: 'error' });
        }

        throw error;
      }
    });

    geminiSharedInjection = opPromise.finally(() => {
        if (geminiSharedInjection === opPromise) {
            geminiSharedInjection = null;
        }
    });
    return geminiSharedInjection;
}

// --- ОБРАБОТЧИК СООБЩЕНИЙ (улучшенная версия из Claude) ---
const onRuntimeMessage = (message, sender, sendResponse) => {
    if (!message) return false;
    console.log('[content-gemini] Received:', message.type);
    
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
        if (window.__LLMScrollHardStop) {
          return false;
        }
        if (isUserInteracting()) {
          stopDriftFallback();
          return false;
        }
        keepAliveMutex.run(async () => {
          runAntiSleepPulse(message.intensity || 'soft');
        });
        return false;
    }
    
    if (message?.type === 'GET_ANSWER' || message.type === 'GET_FINAL_ANSWER') {
        // Prevent duplicate GET_ANSWER calls while request is in-flight
        const sessionKey = message?.meta?.sessionId ? String(message.meta.sessionId) : 'no_session';
        const fp = `${sessionKey}:${fingerprintPrompt(message.prompt)}`;
        if (geminiSharedInjection && fp === geminiSharedFingerprint) {
            console.warn('[content-gemini] Duplicate GET_ANSWER ignored - request already in-flight');
            sendResponse?.({ status: 'duplicate_ignored', fingerprint: fp });
            return true;
        }
        
        ensureSession(message?.meta?.sessionId);
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
                const errorMessage = error.message || 'Unknown error in Gemini content script';
                const responseType = message.type === 'GET_ANSWER' ? 'LLM_RESPONSE' : 'FINAL_LLM_RESPONSE';
                
                chrome.runtime.sendMessage({
                    type: responseType, llmName: MODEL, answer: `Error: ${errorMessage}`,
                    error: { type: error.type || 'generic_error', message: errorMessage },
                    meta: message.meta || null
                });
                sendResponse?.({ status: 'error', message: errorMessage });
            });
        return true; // Важно для асинхронной обработки
    }
    
    return false;
};
chrome.runtime.onMessage.addListener(onRuntimeMessage);
cleanupScope.register?.(() => {
    try {
        chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch (_) {}
});


// --- БАЗОВЫЙ HEARTBEAT ОТКЛЮЧЕН: используем только event-driven anti-sleep ---
function startBasicHeartbeat() { return; }

console.log('[content-gemini] Initialization complete');
