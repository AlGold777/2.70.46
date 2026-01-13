// content-lechat.js – AllCopy v6 "Adaptive Resilient Hybrid"
// Структурная основа: как в content-grok (дубликат-guard, IIFE, self-healing, cleaner, 429).
// Адаптация: селекторы и специфика UI LeChat (chat.mistral.ai/chat).

// ============================== IIFE START ==============================
//-- 2.1. Улучшенная защита от дублирования с версионированием --//
(function () {
  const SCRIPT_VERSION = 'v6.1.2'; // Bumped version for LeChat selector fix
  const SCRIPT_NAME = 'content-lechat';
  const resolveExtensionVersion = () => {
    try {
      return chrome?.runtime?.getManifest?.()?.version || 'unknown';
    } catch (_) {
      return 'unknown';
    }
  };
  
  // Проверка на дубликат
  if (window.leChatContentScriptLoaded) {
    console.warn(`[${SCRIPT_NAME}] Already loaded (v${window.__SCRIPT_VERSION}), aborting`);
    throw new Error('Duplicate script load prevented');
  }
  
  // Установка флагов
  window.leChatContentScriptLoaded = {
    timestamp: Date.now(),
    version: SCRIPT_VERSION,
    manifestVersion: resolveExtensionVersion(),
    source: SCRIPT_NAME
  };
  window.__SCRIPT_VERSION = SCRIPT_VERSION;
  window.__SCRIPT_NAME = SCRIPT_NAME;
  
  console.log(`[${SCRIPT_NAME}] Version ${SCRIPT_VERSION} initializing...`);

  const MODEL = 'Le Chat';
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
  const getPragPlatform = () => prag?.adapter?.name || 'lechat';
  const pipelineOverrides = prag
    ? { sessionId: getPragSessionId(), platform: getPragPlatform(), llmName: MODEL }
    : { llmName: MODEL };
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
    console.warn('[content-lechat] Cleanup triggered:', reason);
    try {
      getForceStopRegistry().run(reason);
    } catch (_) {}
    try {
      cleanupScope.cleanup?.(reason);
    } catch (err) {
      console.warn('[content-lechat] Cleanup scope failed', err);
    }
    try {
      performLeChatCleanup();
    } catch (err) {
      console.warn('[content-lechat] Local cleanup failed', err);
    }
    try {
      window.leChatContentScriptLoaded = null;
    } catch (_) {}
    delete window.__leChatAllCopyV6;
    return reason;
  };
  const getHumanoid = () => (typeof window !== 'undefined' ? window.Humanoid : null);

  async function lechatHumanRead(duration = 480) {
    const humanoid = getHumanoid();
    if (humanoid?.readPage) {
      try {
        await humanoid.readPage(duration);
      } catch (err) {
        console.warn('[content-lechat] Humanoid.readPage failed', err);
      }
    }
  }

  async function lechatHumanClick(element) {
    const humanoid = getHumanoid();
    if (!element) return;
    if (humanoid?.click) {
      try {
        await humanoid.click(element);
        return;
      } catch (err) {
        console.warn('[content-lechat] Humanoid.click failed', err);
      }
    }
    element.click();
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
      p.innerHTML = '&#8203;'; // Zero-width space
      element.appendChild(p);
      return;
    }
    lines.forEach((line) => {
      const paragraph = doc.createElement('p');
      paragraph.textContent = line || '\u200B';
      element.appendChild(paragraph);
    });
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function fallbackLechatType(input, prompt) {
    try {
      input.focus({ preventScroll: true });
    } catch (_) {
      input.focus?.();
    }
    await sleep(80);
    const isEditable = input.isContentEditable || input.getAttribute?.('contenteditable') === 'true';
    if (isEditable) {
      setContentEditableParagraphs(input, prompt);
    } else {
      input.value = prompt;
    }
    try {
      input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: prompt, composed: true }));
    } catch (_) {}
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: prompt, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(220);
  }

  window.setupHumanoidFetchMonitor?.(MODEL, ({ status, retryAfter, url }) => {
    if (status !== 429) return;
    const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 || 60000 : 60000;
    console.error('[content-lechat] HTTP 429 detected for', url || 'unknown');
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

  // -------------------- Utils --------------------
  const sleep = (ms) => (window.ContentUtils?.sleep ? window.ContentUtils.sleep(ms) : new Promise((r) => setTimeout(r, ms)));
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

  const pipelineExpectedLength = (text = '') => {
    const len = (text || '').length;
    if (len > 4000) return 'veryLong';
    if (len > 2000) return 'long';
    if (len > 800) return 'medium';
    return 'short';
  };

  window.setupHumanoidFetchMonitor?.(MODEL, ({ status, retryAfter, url }) => {
    if (status !== 429) return;
    const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 || 60000 : 60000;
    console.error('[content-lechat] HTTP 429 detected for', url || 'unknown');
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

  const runLifecycle = (source, context, executor) => {
    if (typeof window.withHumanoidActivity === 'function') {
      return window.withHumanoidActivity(source, context, executor);
    }
    return executor({ traceId: null, heartbeat: () => {}, stop: () => {}, error: () => {} });
  };


  async function tryLeChatPipeline(promptText = '', lifecycle = {}) {
    const { heartbeat, stop } = lifecycle || {};
    if (!window.UnifiedAnswerPipeline) return null;
    heartbeat?.({
      stage: 'start',
      expectedLength: pipelineExpectedLength(promptText),
      pipeline: 'UnifiedAnswerPipeline'
    });
    try {
      const pipeline = new window.UnifiedAnswerPipeline('lechat', Object.assign({
        expectedLength: pipelineExpectedLength(promptText)
      }, pipelineOverrides));
      const result = await pipeline.execute();
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
      console.warn('[content-lechat] UnifiedAnswerPipeline failed, falling back to legacy watcher', err);
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

  function isElementInteractable(el) {
  if (window.ContentUtils?.isElementInteractable) return window.ContentUtils.isElementInteractable(el);
    if (!el) return false;
    if (el.offsetParent === null) return false;
    if (el.getAttribute && el.getAttribute('disabled') !== null) return false;
    const style = el.style || {};
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect?.();
    if (!rect) return true;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return rect.bottom >= 0 && rect.right >= 0 && rect.top <= vh && rect.left <= vw;
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

  async function findAndCacheElement(selectorKey, selectorArray, timeout = 30000, scope = document) {
  if (window.ContentUtils?.findAndCacheElement) {
    const found = await window.ContentUtils.findAndCacheElement(selectorKey, selectorArray, { timeout, scope, model: (typeof MODEL !== 'undefined' ? MODEL : 'generic'), metricsCollector });
    if (found) return found;
  }

    const opId = metricsCollector.startOperation(`findElement_${selectorKey}`);
    const storageKey = `selector_cache_${MODEL}_${selectorKey}`;
    try {
      const existing = await chrome.storage.local.get(storageKey);
      const cached = existing[storageKey];
      if (cached) {
        const el = scope.querySelector(cached);
        if (isElementInteractable(el)) {
          console.log(`[Self-Healing] Using cached selector for "${selectorKey}": ${cached}`);
          metricsCollector.recordSelectorEvent('cache_hit');
          metricsCollector.endOperation(opId, true, { cached: true, selector: cached });
          return el;
        }
      }
    } catch (_) {}
    const start = Date.now();
    let attempt = 0;
    const baseDelay = 200;
    const maxDelay = 5000;
    while (Date.now() - start < timeout) {
      for (const sel of selectorArray) {
        try {
          const el = scope.querySelector(sel);
          if (isElementInteractable(el)) {
            try { await chrome.storage.local.set({ [storageKey]: sel }); } catch (_) {}
            console.log(`[Self-Healing] Found & cached selector for "${selectorKey}": ${sel} (attempt ${attempt + 1})`);
            metricsCollector.recordSelectorEvent('hit');
            metricsCollector.endOperation(opId, true, { selector: sel, attempts: attempt + 1 });
            return el;
          }
        } catch (e) {
          console.warn(`[Self-Healing] Bad selector "${sel}"`, e);
        }
      }
      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      await sleep(delay);
      attempt++;
    }
    metricsCollector.recordSelectorEvent('miss');
    metricsCollector.endOperation(opId, false, { attempts: attempt });
    throw new Error(`Element not found for "${selectorKey}" after ${attempt} attempts`);
  }

  // -------------------- SmartScroll / KeepAlive (Гибкий) --------------------
  const leChatScrollCoordinator = window.ScrollCoordinator
    ? new window.ScrollCoordinator({
        source: `${MODEL.toLowerCase()}-smart-scroll`,
        getLifecycleMode,
        registerForceStopHandler,
        startDrift: () => startDriftFallback('soft'),
        stopDrift: () => stopDriftFallback(),
        logPrefix: `[${MODEL}] SmartScroll`
      })
    : null;

  const resolveScrollCoordinator = () => {
    const candidates = [
      () => (typeof leChatScrollCoordinator !== 'undefined' ? leChatScrollCoordinator : null),
      () => (typeof qwenScrollCoordinator !== 'undefined' ? qwenScrollCoordinator : null),
      () => (typeof deepseekScrollCoordinator !== 'undefined' ? deepseekScrollCoordinator : null),
      () => (typeof claudeScrollCoordinator !== 'undefined' ? claudeScrollCoordinator : null),
      () => (typeof grokScrollCoordinator !== 'undefined' ? grokScrollCoordinator : null)
    ];
    for (const pick of candidates) {
      const coord = pick();
      if (coord) return coord;
    }
    return null;
  };

  async function withSmartScroll(asyncOperation, options = {}) {
    const coordinator = resolveScrollCoordinator();
    if (window.ContentUtils?.withSmartScroll) {
      return window.ContentUtils.withSmartScroll(asyncOperation, { coordinator, ...options });
    }
    if (coordinator?.run) {
      return coordinator.run(asyncOperation, options);
    }
    return asyncOperation();
  }

  // -------------------- ContentCleaner (мягкий, без агрессивной обрезки) --------------------
  class ContentCleaner {
    // ... (ContentCleaner implementation remains unchanged) ...
    constructor() {
      this.rules = this._initRules();
      this.stats = { elementsRemoved: 0, charactersRemoved: 0, rulesApplied: 0 };
    }
    _initRules() {
      return {
        uiPhrases: [
          /\b(Send|Menu|Settings|New chat|Clear|Like|Reply|Copy|Share|Follow|Subscribe|Regenerate)\b/gi,
          /\b(Upload|Download|Save|Delete|Edit|Search|Filter|Sort)\b/gi,
          /\b(Le Chat|Mistral|chat\.mistral\.ai)\b/gi
        ],
        timePatterns: [
          /\b\d{1,2}:\d{2}\s*(AM|PM)?\b/gi,
          /\b\d+\s*(hours?|minutes?|seconds?)\s*ago\b/gi,
          /\b(Just now|Yesterday|Today|Tomorrow)\b/gi
        ],
        formatting: [/\xa0/g, /&nbsp;/g, /&[a-z]+;/gi],
        urls: [/\bhttps?:\/\/[^\s<>"]+\b/gi, /\bwww\.[^\s<>"]+\b/gi],
        stripTags: [/<!--[\s\S]*?-->/g]
      };
    }
    clean(content, options = {}) {
      this.stats = { elementsRemoved: 0, charactersRemoved: 0, rulesApplied: 0 };

      const isHtml = /<\/?[a-z][\s\S]*>/i.test(content);
      let text = content;

      if (isHtml) {
        try {
          const parser = new DOMParser();
          const doc = parser.parseFromString(content, 'text/html');
          doc.querySelectorAll('script,style,svg,canvas,noscript,header,footer,nav,aside,button,[aria-hidden="true"]').forEach(el => {
            this.stats.elementsRemoved++;
            this.stats.charactersRemoved += (el.textContent || '').length;
            el.remove();
          });
          text = doc.body?.textContent || '';
        } catch (err) {
          console.warn('[ContentCleaner] DOMParser failed in LeChat cleaner, falling back to text extraction', err);
          const div = document.createElement('div');
          div.textContent = content;
          text = div.textContent || '';
        }
      }

      const patterns = [
        ...this.rules.uiPhrases,
        ...this.rules.timePatterns,
        ...this.rules.urls,
        ...this.rules.formatting,
        ...this.rules.stripTags
      ];

      let out = text;
      for (const p of patterns) {
        const before = out.length;
        out = out.replace(p, ' ');
        const diff = before - out.length;
        if (diff > 0) {
          this.stats.rulesApplied++;
          this.stats.charactersRemoved += diff;
        }
      }

      out = out.replace(/\n\s*\n\s*\n/g, '\n\n').replace(/[ \t]+/g, ' ').trim();

      const maxLength = options.maxLength || null;
      if (maxLength && out.length > maxLength) {
        const truncated = out.slice(0, maxLength);
        const cutAt = Math.max(truncated.lastIndexOf('. '), truncated.lastIndexOf('\n\n'));
        out = (cutAt > maxLength * 0.7 ? truncated.slice(0, cutAt + 1) : truncated) + '\n\n[Content truncated]';
      }
      return out;
    }
    getStats() { return { ...this.stats }; }
  }
  const contentCleaner = new ContentCleaner();

  // -------------------- Metrics Collection System --------------------
  // ... (MetricsCollector implementation remains unchanged) ...
  class MetricsCollector {
    constructor() {
      this.metrics = {
        operations: [],
        selectors: { hits: 0, misses: 0, cacheHits: 0 },
        timings: {},
        errors: []
      };
      this.startTime = Date.now();
    }
    startOperation(name, context = {}) {
      const id = `${name}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const op = {
        id,
        name,
        start: Date.now(),
        end: null,
        success: null,
        metadata: context || {},
        lifecycleTraceId: null
      };
      const events = window.HumanoidEvents;
      if (events?.start) {
        try {
          op.lifecycleTraceId = events.start(`metrics:${name}`, {
            mode: getLifecycleMode(),
            operation: name
          });
        } catch (_) {}
      }
      this.metrics.operations.push(op);
      return id;
    }
    endOperation(id, success = true, metadata = {}) {
      const op = this.metrics.operations.find(o => o.id === id);
      if (op) {
        op.end = Date.now();
        op.duration = op.end - op.start;
        op.success = success;
        op.metadata = metadata;
        if (op.lifecycleTraceId && window.HumanoidEvents?.stop) {
          try {
            window.HumanoidEvents.stop(op.lifecycleTraceId, {
              status: success ? 'success' : 'failed',
              metadata
            });
          } catch (_) {}
          op.lifecycleTraceId = null;
        }
      }
    }
    recordSelectorEvent(type) {
      if (type === 'hit') this.metrics.selectors.hits++;
      else if (type === 'miss') this.metrics.selectors.misses++;
      else if (type === 'cache_hit') this.metrics.selectors.cacheHits++;
    }
    recordTiming(key, duration) {
      if (!this.metrics.timings[key]) this.metrics.timings[key] = [];
      this.metrics.timings[key].push(duration);
    }
    recordError(error, context = '', operationId = null) {
      this.metrics.errors.push({
        message: error?.message || String(error),
        context,
        timestamp: Date.now(),
        type: error?.type || 'unknown'
      });
      if (operationId) {
        const op = this.metrics.operations.find(o => o.id === operationId);
        if (op?.lifecycleTraceId && window.HumanoidEvents?.error) {
          try {
            window.HumanoidEvents.error(op.lifecycleTraceId, error, true);
          } catch (_) {}
        }
      }
    }
    getReport() {
      const now = Date.now();
      const successOps = this.metrics.operations.filter(o => o.success === true);
      const failedOps = this.metrics.operations.filter(o => o.success === false);
      const avgTimings = {};
      for (const [key, values] of Object.entries(this.metrics.timings)) {
        avgTimings[key] = values.reduce((a, b) => a + b, 0) / values.length;
      }
      return {
        uptime: now - this.startTime,
        operations: {
          total: this.metrics.operations.length,
          successful: successOps.length,
          failed: failedOps.length,
          successRate: this.metrics.operations.length > 0 
            ? (successOps.length / this.metrics.operations.length * 100).toFixed(2) + '%'
            : 'N/A'
        },
        selectors: this.metrics.selectors,
        timings: avgTimings,
        errors: this.metrics.errors.slice(-10),
        timestamp: now
      };
    }
    sendReport() {
      chrome.runtime.sendMessage({
        type: 'METRICS_REPORT',
        llmName: MODEL,
        metrics: this.getReport()
      });
    }
  }
  const metricsCollector = new MetricsCollector();

  cleanupScope.trackInterval(setInterval(() => metricsCollector.sendReport(), 300000));

  // -------------------- ПЕРЕНОСИМЫЕ ФУНКЦИИ ИЗ РАБОЧЕЙ ВЕРСИИ --------------------
  
  // Композер (ввод текста) - рабочая версия из content-lechat
  function getComposer() {
    const candidates = [
      'textarea[placeholder*="message"]',
      'textarea[aria-label*="message"]',
      'textarea[data-testid*="composer"]',
      'div[data-testid*="composer"] textarea',
      'div[data-testid*="composer"] [contenteditable="true"]',
      'div.ProseMirror',
      'div[class*="ProseMirror"]',
      'div[contenteditable="true"][data-placeholder]',
      'div[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"]',
      'textarea'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (isElementInteractable(el)) return el;
    }
    return null;
  }

  async function resolveComposerViaSelectorFinder() {
    if (!window.SelectorFinder?.findOrDetectSelector) return null;
    try {
      const result = await window.SelectorFinder.findOrDetectSelector({
        modelName: MODEL,
        elementType: 'composer',
        timeout: 25000
      });
      if (result?.element) {
        console.log('[content-lechat] Composer via SelectorFinder', result.selector || result.method || result.layer || 'auto');
        return result.element;
      }
    } catch (err) {
      console.warn('[content-lechat] SelectorFinder composer resolution failed', err);
    }
    return null;
  }

  async function resolveComposer() {
    const direct = getComposer();
    if (direct) return direct;

    const managed = await resolveComposerViaSelectorFinder();
    if (managed) return managed;

    try {
      return await findAndCacheElement('lechat_composer', [
        'textarea[placeholder*="message"]',
        'textarea[aria-label*="message"]',
        'textarea[aria-label*="prompt"]',
        'textarea[data-testid*="composer"]',
        'div[data-testid*="composer"] textarea',
        'div[data-testid*="composer"] [contenteditable="true"]',
        'div[role="textbox"][contenteditable="true"]',
        'div[contenteditable="true"]',
        'textarea'
      ]);
    } catch (err) {
      console.warn('[content-lechat] Fallback composer search failed', err);
      return null;
    }
  }

  // Ввод промпта - рабочая версия из content-lechat (прямое присваивание)
  async function typePrompt(input, prompt) {
    const humanoid = getHumanoid();
    const isContentEditable = input.isContentEditable || input.getAttribute?.('contenteditable') === 'true';

    const checkTextInserted = async (retries = 3) => {
      for (let i = 0; i < retries; i++) {
        await sleep(200);
        const val = (input.value || input.textContent || '').trim();
        if (val.includes(prompt.slice(0, Math.min(20, prompt.length)))) {
          return true;
        }
      }
      return false;
    };

    // Strategy 1: Main-world bridge (most reliable)
    try {
      await ensureMainWorldBridge();
      window.dispatchEvent(new CustomEvent('EXT_SET_TEXT', {
        detail: {
          text: prompt,
          selectors: ['textarea', '[contenteditable="true"]', '[role="textbox"]']
        }
      }));
      if (await checkTextInserted()) {
        console.log('[content-lechat] Main-world bridge typing successful.');
        return;
      }
    } catch (err) {
      console.warn('[content-lechat] main-world text setter failed', err);
    }

    // Check if text was already inserted before trying Strategy 2
    const currentVal = (input.value || input.textContent || '').trim();
    if (currentVal.includes(prompt.slice(0, Math.min(20, prompt.length)))) {
      console.log('[content-lechat] Text already present, skipping remaining strategies.');
      return;
    }

    // Strategy 2: Native value for textarea/input
    if (!isContentEditable && 'value' in input) {
      setNativeValue(input, prompt);
      if (await checkTextInserted()) {
        console.log('[content-lechat] Native value typing successful.');
        return;
      }
    }

    // Check again before Strategy 3
    const currentVal2 = (input.value || input.textContent || '').trim();
    if (currentVal2.includes(prompt.slice(0, Math.min(20, prompt.length)))) {
      console.log('[content-lechat] Text already present, skipping humanoid typing.');
      return;
    }

    // Strategy 3: Humanoid typing (fallback)
    if (humanoid?.typeText) {
      try {
        await humanoid.typeText(input, prompt, { instant: true });
        return;
      } catch (err) {
        console.warn('[content-lechat] Humanoid typing failed, final attempt.', err);
      }
    }
  }

  async function resolveSendButton(referenceInput) {
    if (window.SelectorFinder?.findOrDetectSelector) {
      try {
        const result = await window.SelectorFinder.findOrDetectSelector({
          modelName: MODEL,
          elementType: 'sendButton',
          timeout: 20000,
          referenceElement: referenceInput || null
        });
        if (result?.element && isElementInteractable(result.element)) {
          return result.element;
        }
      } catch (err) {
        console.warn('[content-lechat] SelectorFinder send button resolution failed', err);
      }
    }

    const sendBtn = document.querySelector(
      [
        'button[aria-label*="send" i]',
        'button[aria-label*="send message" i]',
        'button[aria-label*="submit" i]',
        'button[aria-label*="post" i]',
        'button:has(svg[data-icon="arrow-up"])',
        'button:has(svg[data-icon="send"])',
        'button[type="submit"]',
        'button[aria-label="Post"]',
        'button[aria-label*="Отправить"]',
        'button[data-testid*="send"]',
        'button:has(svg)',
        'button:has([data-icon="send"])',
        'div[role="button"][aria-label*="send" i]',
        'div[role="button"][data-testid*="send"]'
      ].join(',')
    );
    return isElementInteractable(sendBtn) ? sendBtn : null;
  }

  // Отправка промпта - рабочая версия из content-lechat
  async function sendComposer(composer, prompt) {
    const confirmLeChatSend = async (sendButtonCandidate, timeout = 3000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const typing = document.querySelector('[class*="animate-pulse"], [class*="streaming"], [data-testid="generation"]');
        if (typing) return true;
        if (sendButtonCandidate?.disabled || sendButtonCandidate?.getAttribute?.('aria-disabled') === 'true') return true;
        const composerText = (composer.value || composer.textContent || '').trim();
        if (!composerText.length) return true;
        await sleep(150);
      }
      return false;
    };

    const dispatchEnter = (mods = {}) => {
      const init = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        ctrlKey: !!mods.ctrlKey,
        metaKey: !!mods.metaKey,
        shiftKey: !!mods.shiftKey,
        altKey: !!mods.altKey
      };
      try { composer.dispatchEvent(new KeyboardEvent('keydown', init)); } catch (_) {}
      try { composer.dispatchEvent(new KeyboardEvent('keypress', init)); } catch (_) {}
      try { composer.dispatchEvent(new KeyboardEvent('keyup', init)); } catch (_) {}
    };

    await sleep(2000);

    // Strategy 1: Ctrl+Enter (some editors bind this as "send")
    try {
      dispatchEnter({ ctrlKey: true });
      if (await confirmLeChatSend(null, 3500)) {
        console.log('[content-lechat] Ctrl+Enter send confirmed.');
        return;
      }
    } catch (e) {
      console.warn('[content-lechat] Ctrl+Enter send failed', e);
    }

    // Strategy 2: Button click (usually the most deterministic)
    try {
      const sendButton = await resolveSendButton(composer);
      if (sendButton && !sendButton.disabled && sendButton.getAttribute?.('aria-disabled') !== 'true') {
        await lechatHumanClick(sendButton);
        if (await confirmLeChatSend(sendButton, 3500)) {
          console.log('[content-lechat] Button click send confirmed.');
          return;
        }
      }
    } catch (e) {
      console.warn('[content-lechat] Button click send failed', e);
    }

    // Check if already sent before trying Enter
    if (await confirmLeChatSend(null, 500)) {
      console.log('[content-lechat] Message already sent, skipping Enter.');
      return;
    }

    // Strategy 3: Enter key
    try {
      dispatchEnter();
      if (await confirmLeChatSend(null, 3500)) {
        console.log('[content-lechat] Enter key send confirmed.');
        return;
      }
    } catch (e) {
      console.warn('[content-lechat] Enter key send failed', e);
    }

    // Final check
    if (!(await confirmLeChatSend(null, 1000))) {
      console.error('[content-lechat] All send methods failed to confirm.');
      throw new Error('Failed to confirm prompt submission.');
    }
  }

  // Извлечение ответа - адаптация под LeChat с логикой Grok
  function getProseNodes() {
    return Array.from(document.querySelectorAll(
      'div.prose:not(:has(div[contenteditable])), .prose, div[data-testid="lechat-response"] .prose, article .prose, [data-testid="answer"] .prose, [data-testid="message-content"], div[class*="message-content"], .result, .answer, [role="article"] .prose'
    )).filter((n) => {
      const text = (n.innerText || '').trim();
      // Filter out empty nodes and composer/input nodes
      return text.length > 0 && !n.isContentEditable && !n.closest('[contenteditable="true"]');
    });
  }

  function extractResponseText(node) {
    if (!node) return { text: '', html: '' };
    const html = buildInlineHtml(node);
    const text = (node.innerText || node.textContent || '').trim();
    return { text, html };
  }

  // Ожидание ответа - логика Grok с селекторами LeChat
  async function waitForLeChatReply(prompt, timeout = 150000) {
    const captureProseSnapshot = () => {
      const prose = getProseNodes();
      if (!prose.length) return null;

      const last = prose[prose.length - 1];
      const payload = extractResponseText(last);
      const txt = payload.text || payload.html || '';
      if (!txt || txt.length < 20) return null;

      // Check multiple selectors for generating state
      const stopButton = document.querySelector('button[aria-label*="Stop"]');
      const animatePulse = document.querySelector('.animate-pulse');
      const typingIndicator = document.querySelector('.typing-indicator, [data-testid="generation-in-progress"]');
      const ariaBusy = document.querySelector('[aria-busy="true"]');
      const loader = document.querySelector('.loading, .loader, .dots');
      const animatedSvg = document.querySelector('button:has(svg[class*="animate"])');

      const isGenerating = Boolean(stopButton || animatePulse || typingIndicator || ariaBusy || loader || animatedSvg);

      return { text: txt, html: payload.html || '', isGenerating };
    };

    const captureFallbackSnapshot = () => {
      const messages = Array.from(document.querySelectorAll('div[class*="message"], article, div[role="article"]'));
      if (!messages.length) return null;
      const lastMsg = messages[messages.length - 1];
      const payload = extractResponseText(lastMsg);
      const txt = payload.text || payload.html || '';
      if (!txt || txt.length < 20) return null;
      const prefix = prompt.slice(0, Math.min(40, prompt.length)).trim();
      if (prefix && txt.startsWith(prefix)) return null;
      const isGenerating = Boolean(document.querySelector('[aria-busy="true"], .typing-indicator, .animate-pulse'));
      return { text: txt, html: payload.html || '', isGenerating };
    };

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let lastSeen = '';
      let lastSeenHtml = '';
      let stableTicks = 0;
      let fallbackMode = false;
      let settled = false;

      const cleanup = (value, isTimeout = false) => {
        if (settled) return;
        settled = true;
        if (domObserver) {
          domObserver.disconnect();
          domObserver = null;
        }
        clearInterval(intervalId);
        clearTimeout(timerId);
        if (value) {
          console.log('[content-lechat] Response captured, length:', value.length);
          resolve({ text: value, html: lastSeenHtml });
        } else if (isTimeout && lastSeen) {
          console.warn('[content-lechat] Timeout reached, returning last captured text, length:', lastSeen.length);
          resolve({ text: lastSeen, html: lastSeenHtml });
        } else if (isTimeout && !lastSeen) {
          console.error('[content-lechat] Timeout with no response captured');
          reject(new Error('Timeout: No response from Le Chat'));
        } else {
          console.error('[content-lechat] Unexpected cleanup state');
          reject(new Error('Failed to capture Le Chat response'));
        }
      };

      const evaluate = () => {
        let snapshot = captureProseSnapshot();
        if (!snapshot && fallbackMode) {
          snapshot = captureFallbackSnapshot();
        }
        if (!snapshot) return;

        const { text, html, isGenerating } = snapshot;
        if (html) lastSeenHtml = html;

        if (!isGenerating && text === lastSeen) {
          stableTicks += 1;
          if (stableTicks >= 3) {
            console.log('[content-lechat] ✅ Response stabilized, length:', text.length);
            cleanup(text);
          }
        } else {
          lastSeen = text;
          stableTicks = 0;
        }
      };

      const stopObserve = window.ContentUtils?.observeMutations
        ? window.ContentUtils.observeMutations(document.body, { childList: true, subtree: true, characterData: true }, () => evaluate())
        : (() => () => {})();
      const intervalId = cleanupScope.trackInterval(setInterval(() => {
        if (!fallbackMode && getProseNodes().length === 0 && Date.now() - startTime > 10000) {
          fallbackMode = true;
        }
        evaluate();
      }, 600));
      const timerId = cleanupScope.trackTimeout(setTimeout(() => cleanup(null, true), timeout));
      evaluate();
    });
  }

  // -------------------- Отправка результата в бекграунд --------------------
  // NOTE: sendResult is removed/deprecated to avoid duplicate messages (Issue 2).
  // All messaging is now handled by the chrome.runtime.onMessage listener.

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
      console.warn('[content-lechat] Failed to parse data URL', err);
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
        console.warn('[content-lechat] Failed to hydrate attachment', item?.name, err);
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
  function ensureMainWorldBridge() {
    if (window.__extMainBridgeInjected) return;
    const script = document.createElement('script');
    script.textContent = `(function(){\nif (window.__ExtMainBridge) return; window.__ExtMainBridge = true;\nconst dataUrlToFile = (item) => {\n  try {\n    const match = (item?.base64 || '').match(/^data:([^;]+);base64,(.*)$/);\n    const base64Part = match ? match[2] : item?.base64 || '';\n    const binary = atob(base64Part);\n    const len = binary.length;\n    const bytes = new Uint8Array(len);\n    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);\n    return new File([bytes], item.name || 'file', { type: item.type || 'application/octet-stream' });\n  } catch (err) { console.warn('[MainBridge] dataUrlToFile failed', err); return null; }\n};\nconst toFiles = (arr) => (arr || []).map(dataUrlToFile).filter(Boolean);\nconst findFirst = (sels = []) => { for (const sel of sels) { const el = document.querySelector(sel); if (el) return el; } return null; };\nconst setNativeValue = (el, value) => { try {\n  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;\n  const desc = Object.getOwnPropertyDescriptor(proto, 'value');\n  const setter = desc && desc.set;\n  const ownSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;\n  (ownSetter || setter)?.call(el, value);\n  el.dispatchEvent(new Event('input', { bubbles: true }));\n  el.dispatchEvent(new Event('change', { bubbles: true }));\n} catch (e) { try { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } catch(_) {} } };\nconst dispatchDrop = (el, dt) => {\n  if (!el) return false;\n  const rect = el.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };\n  const coords = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };\n  for (const t of ['dragenter','dragover','drop']) {\n    const ev = new DragEvent(t, Object.assign({ bubbles:true, cancelable:true, dataTransfer: dt }, coords));\n    ev.preventDefault?.();\n    el.dispatchEvent(ev);\n  }\n  return true;\n};\nwindow.addEventListener('EXT_ATTACH', (ev) => {\n  try {\n    const d = ev.detail || {};\n    const files = toFiles(d.attachments);\n    if (!files.length) return;\n    const dt = new DataTransfer(); files.forEach(f => dt.items.add(f)); dt.effectAllowed = 'copy';\n    const dropSelectors = d.dropSelectors || [];\n    for (const sel of dropSelectors) {\n      const el = document.querySelector(sel);\n      if (dispatchDrop(el, dt)) return;\n    }\n    const attachBtn = findFirst(d.attachSelectors || []);\n    if (attachBtn) { try { attachBtn.click(); } catch(_) {} }\n    const fileInput = findFirst(d.inputSelectors || []) || document.querySelector('input[type=\"file\"]');\n    if (fileInput) {\n      try { fileInput.files = dt.files; } catch (_) {}\n      try { fileInput.dispatchEvent(new Event('input', { bubbles:true })); fileInput.dispatchEvent(new Event('change', { bubbles:true })); return; } catch(_) {}\n    }\n    const pasteTargets = dropSelectors.map(sel => document.querySelector(sel)).filter(Boolean);\n    for (const el of pasteTargets) {\n      try {\n        const evPaste = new ClipboardEvent('paste', { bubbles:true, cancelable:true });\n        if (!evPaste.clipboardData) { Object.defineProperty(evPaste, 'clipboardData', { value: dt }); }\n        el.dispatchEvent(evPaste);\n        el.dispatchEvent(evPaste);\n        return;\n      } catch (_) {}\n    }\n  } catch (err) { console.warn('[MainBridge] EXT_ATTACH error', err); }\n});\nwindow.addEventListener('EXT_SET_TEXT', (ev) => {\n  try {\n    const d = ev.detail || {};\n    const text = d.text || '';\n    const sel = findFirst(d.selectors || []);\n    if (!sel) return;\n    if ('value' in sel) { setNativeValue(sel, text); }\n    else { sel.textContent = text; sel.dispatchEvent(new Event('input', { bubbles:true })); sel.dispatchEvent(new Event('change', { bubbles:true })); }\n  } catch (err) { console.warn('[MainBridge] EXT_SET_TEXT error', err); }\n});\n})();`;
    document.documentElement.appendChild(script);
    script.remove();
    window.__extMainBridgeInjected = true;
  }

  async function attachFilesToComposer(target, attachments = []) {
    if (!attachments || !attachments.length) return false;
    const files = hydrateAttachments(attachments).slice(0, 5);
    if (!files.length) return false;

    // FIX: Removed EXT_ATTACH dispatch to prevent duplicate attachments.
    // Rely on isolated-world drop/paste/input fallbacks (same approach as GPT).

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
        console.warn('[content-lechat] paste dispatch failed', err);
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
        console.warn('[content-lechat] drop dispatch failed', err);
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
    console.warn('[content-lechat] File input not found, skipping attachments');
    return false;
  }

    const dt = makeDataTransfer();
    try { fileInput.files = dt.files; } catch (err) { console.warn('[content-lechat] set files failed', err); }
    try {
      fileInput.dispatchEvent(new Event('input', { bubbles: true }));
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (err) {
      console.warn('[content-lechat] input/change dispatch failed', err);
    }
    try { fileInput.focus?.({ preventScroll: true }); } catch (_) { try { fileInput.focus?.(); } catch (_) {} }
    await sleep(1800);
    return true;
  }

  // -------------------- Публичная операция: inject → wait → extract → clean → send --------------------
  let isProcessingRequest = false;
  async function injectAndGetResponse(prompt, attachments = [], meta = null) {
    const dispatchMeta = meta && typeof meta === 'object' ? meta : null;
    // Prevent concurrent executions
    if (isProcessingRequest) {
      console.warn('[content-lechat] Request already in progress, ignoring duplicate call');
      throw { type: 'concurrent_request', message: 'Another request is already being processed' };
    }
    isProcessingRequest = true;

    try {
      return await runLifecycle('lechat:inject', buildLifecycleContext(prompt), async (activity) => {
      const opId = metricsCollector.startOperation('injectAndGetResponse');
      const startTime = Date.now();
      let pipelineCompleted = false;
      let pipelineStats = null;
      try {
        // v2.54.4 (2025-12-19 20:15): REMOVED 1200ms sleep - unnecessary delay causing focus loss
        // Old: await sleep(1200);
        await sleep(200);  // Minimal delay for DOM stability
        activity.heartbeat(0.15, { phase: 'composer-search' });

        const composer = await resolveComposer();
        if (!composer) {
          throw { type: 'selector_not_found', message: 'Le Chat input field not found' };
        }
        activity.heartbeat(0.3, { phase: 'composer-ready' });

        try { await attachFilesToComposer(composer, attachments); } catch (err) { console.warn('[content-lechat] attach failed', err); }

        await typePrompt(composer, prompt);
        
        await sleep(100);
        const validationText = (composer.value ?? composer.textContent ?? '').trim();
        if (!validationText.length) {
          throw { type: 'injection_failed', message: 'Input did not accept value (React guard).' };
        }
        activity.heartbeat(0.45, { phase: 'typing' });
        
        await sendComposer(composer);
        activity.heartbeat(0.6, { phase: 'send-dispatched' });
        try { chrome.runtime.sendMessage({ type: 'PROMPT_SUBMITTED', llmName: MODEL, ts: Date.now(), meta: dispatchMeta }); } catch (_) {}

        activity.heartbeat(0.7, { phase: 'waiting-response' });
        const cleaned = await withSmartScroll(async () => {
          let pipelineAnswer = null;
          await tryLeChatPipeline(prompt, {
            heartbeat: (meta = {}) => activity.heartbeat(0.8, Object.assign({ phase: 'pipeline' }, meta)),
            stop: async ({ answer, answerHtml }) => {
              console.log('[content-lechat] UnifiedAnswerPipeline captured response');
              const cleaned = contentCleaner.clean(answer, { maxLength: 50000 });
              const html = String(answerHtml || '').trim();
              if (html) lastResponseHtml = html;
              pipelineAnswer = { text: cleaned, html };
              pipelineCompleted = true;
              pipelineStats = { responseLength: cleaned.length, source: 'pipeline' };
              return pipelineAnswer;
            }
          });
          if (pipelineAnswer) {
            return pipelineAnswer;
          }
          const rawText = await waitForLeChatReply(prompt, 150000);
          const rawPayload = normalizeResponsePayload(rawText, lastResponseHtml);
          if (rawPayload.html) lastResponseHtml = rawPayload.html;

          // Validate response - be lenient, only reject truly empty responses
          if (!rawPayload.text || rawPayload.text.trim().length === 0) {
            console.error('[content-lechat] ❌ Response is completely empty');
            throw { type: 'empty_response', message: 'Response is empty' };
          }

          console.log('[content-lechat] ✅ Raw response captured, length:', rawPayload.text.length);
          const cleaned = contentCleaner.clean(rawPayload.text, { maxLength: 50000 });
          console.log('[content-lechat] ✅ Response cleaned, length:', cleaned.length);
          return { text: cleaned, html: lastResponseHtml };
        }, { keepAliveInterval: 2000, operationTimeout: 300000, debug: false });
        
        const stats = contentCleaner.getStats();
        chrome.runtime.sendMessage({
          type: 'CONTENT_CLEANING_STATS',
          llmName: MODEL,
          stats,
          timestamp: Date.now()
        });
        
        const duration = Date.now() - startTime;
        const stopMeta = pipelineCompleted
          ? Object.assign({ duration }, pipelineStats || { responseLength: cleaned.length, source: 'pipeline' })
          : { responseLength: cleaned.length, duration };
        metricsCollector.recordTiming('total_response_time', duration);
        metricsCollector.endOperation(opId, true, stopMeta);
        activity.heartbeat(0.95, { phase: 'response-processed' });
        activity.stop({ status: 'success', answerLength: cleaned.length, source: pipelineCompleted ? 'pipeline' : 'legacy' });
        return cleaned;
        
      } catch (e) {
        if (e?.code === 'background-force-stop') {
          activity.error(e, false);
          throw e;
        }

        console.error('[content-lechat] Error:', e?.message || String(e));
        metricsCollector.recordError(e, 'injectAndGetResponse', opId);
        metricsCollector.endOperation(opId, false, { error: e?.message });

        // Only call activity.error for FATAL errors (selector/injection issues)
        // For other errors (timeout, empty response), just stop - let handleLLMResponse set status
        const isFatal = ['selector_not_found', 'injection_failed'].includes(e?.type);

        if (isFatal) {
          activity.error(e, true);
        } else {
          activity.stop({ status: 'error' });
        }

        throw e;
      }
    });
    } finally {
      isProcessingRequest = false;
    }
  }
  //-- 3.1. Централизованная функция очистки --//
  let keepAliveActive = true; 
  let healthCheckTimer = null;
  let keepAliveTimer = null;
  let domObserver = null;
  const addedListeners = [];
  const ROOT_ID = 'lechat-allcopy-v6-root';

  function addTrackedListener(target, event, handler) {
    target.addEventListener(event, handler);
    addedListeners.push({ target, event, handler });
  }

  function performLeChatCleanup() {
    console.log('[content-lechat] Cleanup initiated...');
    
    // Останавливаем все флаги активности
    keepAliveActive = false;
    
    // Удаляем DOM-элементы
    const rootElement = document.getElementById(ROOT_ID);
    if (rootElement) {
      rootElement.remove();
      console.log('[content-lechat] DOM elements removed');
    }
    
    // Останавливаем таймеры
    if (healthCheckTimer) {
      clearInterval(healthCheckTimer);
      healthCheckTimer = null;
      console.log('[content-lechat] Health check timer cleared');
    }
    
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      console.log('[content-lechat] Keep-alive timer cleared');
    }
    
    // Отключаем MutationObserver
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
      console.log('[content-lechat] DOM observer disconnected');
    }
    
    // Удаляем все event listeners
    addedListeners.forEach(({target, event, handler}) => {
      try {
        target.removeEventListener(event, handler);
      } catch (e) {
        console.warn('[content-lechat] Failed to remove listener:', e);
      }
    });
    addedListeners.length = 0;
    console.log('[content-lechat] Event listeners removed');
    
    // Сбрасываем глобальные флаги
    window.leChatContentScriptLoaded = null;
    delete window.__leChatAllCopyV6;
    delete window.__SCRIPT_VERSION;
    delete window.__cleanup_lechat;
    
    console.log('[content-lechat] ✅ Cleanup complete');
  }
  
  // Экспортируем cleanup для внешнего вызова
  window.__cleanup_lechat = () => stopContentScript('manual-trigger');
  
  // Проверка отключения расширения каждые 3 секунды
  healthCheckTimer = cleanupScope.trackInterval(setInterval(() => {
    if (!chrome.runtime?.id) {
      console.warn('[content-lechat] Extension disconnected, self-cleaning');
      stopContentScript('runtime-disconnected');
    }
  }, 3000));
  // -------------------- Message bus --------------------
  const onRuntimeMessage = (msg, _sender, sendResponse) => {
    try {
      if (!msg) return false;
      
      if (msg?.type === 'STOP_AND_CLEANUP') {
        handleForceStopMessage(msg.payload?.traceId);
        stopContentScript('manual-toggle');
        if (typeof sendResponse === 'function') {
          sendResponse({ status: 'cleaned', llmName: MODEL });
        }
        return false;
      }

      if (msg?.type === 'HUMANOID_FORCE_STOP') {
        handleForceStopMessage(msg.payload?.traceId);
        if (typeof sendResponse === 'function') {
          sendResponse({ status: 'force_stop_ack' });
        }
        return false;
      }

      if (msg?.type === 'HEALTH_CHECK_PING') {
        sendResponse({ type: 'HEALTH_CHECK_PONG', pingId: msg.pingId, llmName: MODEL });
        return true;
      }
      if (msg?.type === 'HEALTH_PING') {
        sendResponse({ 
          status: 'alive', 
          llmName: MODEL,
          version: window.__SCRIPT_VERSION || 'unknown',
          timestamp: Date.now()
        });
        return true;
      }

      if (msg?.type === 'FORCE_CLEANUP') {
        console.log('[content-lechat] Received FORCE_CLEANUP command');
        stopContentScript('force-cleanup');
        sendResponse?.({ status: 'cleaned', llmName: MODEL });
        return true;
      }

      if (msg?.type === 'ANTI_SLEEP_PING') {
        try {
          if (window.__LLMScrollHardStop) return false;
          if (isUserInteracting()) {
            stopDriftFallback();
            return false;
          }
          keepAliveMutex.run(async () => {
            runAntiSleepPulse(msg.intensity || 'soft');
          });
          chrome.runtime.sendMessage({ type: 'LLM_ACTIVITY_PONG' }).catch(() => {});
        } catch (_) {}
        return false;
      }

      if (msg?.type === 'GET_ANSWER' || msg?.type === 'GET_FINAL_ANSWER') {
        injectAndGetResponse(msg.prompt, msg.attachments || [], msg.meta || null)
          .then((resp) => {
            if (msg.isFireAndForget) {
              console.log('[content-lechat] Fire-and-forget request processed. Not sending response back.');
              sendResponse?.({ status: 'success_fire_and_forget' });
              return;
            }
            const responseType = msg.type === 'GET_ANSWER' ? 'LLM_RESPONSE' : 'FINAL_LLM_RESPONSE';
            const payload = normalizeResponsePayload(resp, lastResponseHtml);
            chrome.runtime.sendMessage({
              type: responseType,
              llmName: MODEL,
              answer: payload.text,
              answerHtml: payload.html,
              meta: msg.meta || null
            });
            sendResponse?.({ status: 'success' });
          })
          .catch((err) => {
            if (err?.code === 'background-force-stop') {
              sendResponse?.({ status: 'force_stopped' });
              return;
            }
            const errorMessage = err?.message || String(err) || 'Unknown error in content-lechat';
            console.error('[content-lechat] Error in injectAndGetResponse:', errorMessage, err);
            const responseType = msg.type === 'GET_ANSWER' ? 'LLM_RESPONSE' : 'FINAL_LLM_RESPONSE';
            if (err?.type !== 'rate_limit') {
               chrome.runtime.sendMessage({
                  type: responseType,
                  llmName: MODEL,
                  answer: `Error: ${errorMessage}`,
                  error: { type: err?.type || 'generic_error', message: errorMessage },
                  meta: msg.meta || null
               });
            }
            sendResponse?.({ status: 'error', message: errorMessage });
          });
        return true;
      }

      if (msg.action === 'injectPrompt' || msg.action === 'sendPrompt' || msg.action === 'REQUEST_LLM_RESPONSE') {
        const prompt = msg.prompt || '';
        injectAndGetResponse(prompt)
          .then(() => sendResponse?.({ status: 'success' }))
          .catch((err) => sendResponse?.({ status: 'error', message: err?.message || 'Unknown error' }));
        return true;
      } else if (msg.action === 'getResponses') {
        const runManualRefresh = async () => {
          await withSmartScroll(async () => {
            const rawText = await waitForLeChatReply('', 120000);
            const payload = normalizeResponsePayload(rawText, lastResponseHtml);
            const cleaned = contentCleaner.clean(payload.text || payload.html || '');
            if (payload.html) lastResponseHtml = payload.html;
            chrome.runtime.sendMessage({
              type: 'LLM_RESPONSE',
              llmName: MODEL,
              answer: cleaned,
              answerHtml: payload.html || ''
            });
          }, { keepAliveInterval: 2000, operationTimeout: 120000, debug: false });
        };
        runManualRefresh()
          .then(() => sendResponse && sendResponse({ status: 'manual_refresh_dispatched' }))
          .catch((err) => {
            if (err?.code === 'background-force-stop') {
              sendResponse && sendResponse({ status: 'force_stopped' });
              return;
            }
            console.error('[content-lechat] Manual getResponses failed', err);
            sendResponse && sendResponse({ status: 'manual_refresh_failed', error: err?.message || 'unknown_error' });
          });
        return true;
      }
    } catch (e) {
      console.error('[content-lechat] onMessage error:', e);
      chrome.runtime.sendMessage({
          type: 'LLM_RESPONSE',
          llmName: MODEL,
          answer: `Structural Error: ${e?.message || String(e)}`,
          error: { type: 'structural_listener_error', message: e?.message || String(e) }
      });
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  cleanupScope.register?.(() => {
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch (_) {}
  });

  // -------------------- Экспорт внутрь страницы (по необходимости) --------------------
  window.__leChatAllCopyV6 = {
    injectAndGetResponse,
    contentCleaner
  };

  console.log('[content-lechat] AllCopy v6 ready.');

  // v2.54.4 (2025-12-19 20:15): Early ready signal for faster dispatch
  // LeChat had 1200ms delay + focus loss issue - early ready signal eliminates wait time
  (async () => {
    const checkReady = async () => {
      if (document.readyState !== 'loading') {
        // LeChat uses textarea in main chat interface
        const textarea = document.querySelector('textarea[placeholder*="Ask"]')
                      || document.querySelector('form textarea')
                      || document.querySelector('textarea');
        const sendButton = document.querySelector('button[type="submit"]')
                        || document.querySelector('button[aria-label*="send" i]');

        if (textarea && sendButton) {
          try {
            chrome.runtime.sendMessage({
              type: 'SCRIPT_READY_EARLY',
              llmName: MODEL
            });
            console.log('[content-lechat] ⚡ Early ready signal sent');
            return true;
          } catch (err) {
            console.warn('[content-lechat] Failed to send early ready signal:', err);
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
})();
// ============================== IIFE END ==============================
