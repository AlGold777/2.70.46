// content-grok.js – AllCopy v6 "Adaptive Resilient Hybrid"
// Структурная основа: как в content-claude (дубликат-guard, IIFE, self-healing, cleaner, 429).
// Плюс: Perplexity-style селекторная сеть, Gemini-style самообучающий fallback,
// Grok-style SmartScroll/KeepAlive и стабильная доставка результата.

// ============================== IIFE START ==============================
(function () {
  // -------------------- Duplicate guard --------------------
  const resolveExtensionVersion = () => {
    try {
      return chrome?.runtime?.getManifest?.()?.version || 'unknown';
    } catch (_) {
      return 'unknown';
    }
  };
  if (window.grokContentScriptLoaded) {
    console.warn('[content-grok] Script already loaded, skipping duplicate initialization');
    throw new Error('Duplicate script load prevented');
  }
  window.grokContentScriptLoaded = {
    timestamp: Date.now(),
    version: resolveExtensionVersion(),
    source: 'content-grok'
  };
  console.log('[content-grok] First load, initializing AllCopy v6…');

  // SCRIPT_LOADED diagnostic (helps correlate handler availability)
  const SCRIPT_VERSION = resolveExtensionVersion();
  const HANDLERS = ['CHECK_READINESS', 'GET_ANSWER', 'GET_FINAL_ANSWER', 'HEALTH_CHECK_PING', 'ANTI_SLEEP_PING', 'STOP_AND_CLEANUP', 'HUMANOID_FORCE_STOP', 'getResponses'];
  try {
    chrome.runtime.sendMessage({
      type: 'LLM_DIAGNOSTIC_EVENT',
      llmName: 'Grok',
      event: {
        ts: Date.now(),
        type: 'SCRIPT',
        label: 'SCRIPT_LOADED',
        details: `v${SCRIPT_VERSION} handlers=${HANDLERS.length}`,
        level: 'success',
        meta: {
          version: SCRIPT_VERSION,
          handlers: HANDLERS,
          url: window.location.href,
          timestamp: Date.now()
        }
      }
    });
  } catch (_) {}

  const MODEL = 'Grok';
  const GROK_FALLBACK_LAST_MESSAGE_SELECTORS = [
    '[data-testid="grok-response"]',
    '[data-testid="message"]',
    '[data-testid*="chat-message"]',
    '[data-message-author-role="assistant"]',
    '[data-role="assistant"]',
    'article[data-role="assistant"]',
    'div[class*="assistant" i]',
    '[role="article"]',
    'div.flex.flex-col:nth-of-type(2) > div.relative.group > div.message-bubble.relative:nth-of-type(1)',
    'div.message-bubble.relative.rounded-3xl.text-primary.min-h-7.prose',
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
  const MIN_GROK_ANSWER_LEN = 12;
  const SHORT_ANSWER_FALLBACK_TIMEOUT_MS = 12000;
  const GROK_RESPONSE_SELECTOR_TIMEOUT_MS = 12000;

  function grabLatestAssistantText() {
    try {
      const selectorsFromBundle = (window.AnswerPipelineSelectors?.PLATFORM_SELECTORS?.grok?.lastMessage
        ? [window.AnswerPipelineSelectors.PLATFORM_SELECTORS.grok.lastMessage]
        : []).flat().filter(Boolean);
      const candidates = selectorsFromBundle.length ? selectorsFromBundle : GROK_FALLBACK_LAST_MESSAGE_SELECTORS;
      const nodes = [];
      const seen = new Set();
      const pushUnique = (el) => {
        if (!el || el.nodeType !== 1) return;
        if (seen.has(el)) return;
        seen.add(el);
        nodes.push(el);
      };
      for (const sel of candidates) {
        try {
          document.querySelectorAll(sel).forEach(pushUnique);
        } catch (_) {}
      }
      if (!nodes.length) return { text: '', html: '', node: null };
      const normalizeText = (node) => String(node?.innerText || node?.textContent || '').trim();
      const sorted = nodes.slice().sort((a, b) => {
        if (a === b) return 0;
        try {
          const pos = a.compareDocumentPosition(b);
          if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
          if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        } catch (_) {}
        return 0;
      });
      for (let i = sorted.length - 1; i >= 0; i--) {
        const node = sorted[i];
        const text = normalizeText(node);
        const html = buildInlineHtml(node);
        if (text && !isServiceStatusText(text)) return { text, html, node };
      }
    } catch (err) {
      console.warn('[content-grok] grabLatestAssistantText failed', err);
    }
    return { text: '', html: '', node: null };
  }
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
  const getPragPlatform = () => prag?.adapter?.name || 'grok';
  const pipelineOverrides = prag
    ? { sessionId: getPragSessionId(), platform: getPragPlatform(), llmName: MODEL }
    : { llmName: MODEL };
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
        handlers.forEach((handler) => {
          try { handler(reason); } catch (_) {}
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
    console.warn('[content-grok] Cleanup triggered:', reason);
    try {
      getForceStopRegistry().run(reason);
    } catch (_) {}
    try {
      cleanupScope.cleanup?.(reason);
    } catch (err) {
      console.warn('[content-grok] Cleanup scope failed', err);
    }
    try {
      window.grokContentScriptLoaded = null;
    } catch (_) {}
    return reason;
  };
  window.__cleanup_grok = stopContentScript;
  cleanupScope.addEventListener?.(window, 'pagehide', () => stopContentScript('pagehide'));
  cleanupScope.addEventListener?.(window, 'beforeunload', () => stopContentScript('beforeunload'));
  const getHumanoid = () => (typeof window !== 'undefined' ? window.Humanoid : null);
  const isSpeedMode = () => !!window.__PRAGMATIST_SPEED_MODE;
  const selectorFinder = window.SelectorFinder;
  if (!selectorFinder) {
    console.error('[content-grok] SelectorFinder is required but not available. Verify injection order.');
    throw new Error('SelectorFinder unavailable for Grok content script');
  }

  window.setupHumanoidFetchMonitor?.(MODEL, ({ status, retryAfter, url }) => {
    if (status !== 429) return;
    const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 || 60000 : 60000;
    console.error('[content-grok] HTTP 429 detected for', url || 'unknown');
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
      if (locked) {
        await new Promise((resolve) => queue.push(resolve));
      }
      locked = true;
      try {
        return await fn();
      } finally {
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

  async function tryGrokPipeline(promptText = '', lifecycle = {}) {
    const { heartbeat, stop } = lifecycle || {};
    if (!window.UnifiedAnswerPipeline) return null;
    heartbeat?.({
      stage: 'start',
      expectedLength: pipelineExpectedLength(promptText),
      pipeline: 'UnifiedAnswerPipeline'
    });
    try {
      const pipeline = new window.UnifiedAnswerPipeline('grok', Object.assign({
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
      console.warn('[content-grok] UnifiedAnswerPipeline failed, using legacy watcher', err);
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
    cleanupScope.register?.(() => {
      if (cleanupTimer) {
        clearTimeout(cleanupTimer);
        cleanupTimer = null;
      }
    });
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
    keepAliveMutex.run(async () => {
      try {
        const Toolkit = window.__UniversalScrollToolkit;
        if (Toolkit) {
          const tk = new Toolkit({ idleThreshold: 800, driftStepMs: 40 });
          const ok = await tk.keepAliveTick?.((Math.random() > 0.5 ? 1 : -1) * delta);
          if (ok !== undefined) return;
        }
      } catch (_) {}
      startDriftFallback(intensity);
    });
  };
  //-- 1.2. Перемещаем fallback-функцию внутрь IIFE --//
  // -------------------- Fallback DOM queries for send button --------------------
  async function fallbackFindSendButton(composerEl, timeoutMs = 8000) {
    const fallbackSelectors = [
      'button[data-testid="grok-send-button"]',
      'div[data-testid="grok-editor"] button[data-testid="grok-send-button"]',
      'div[data-testid="grok-editor"] button[aria-label*="Send" i]',
      'div[data-testid="grok-editor"] button[type="submit"]',
      'div[data-testid="grok-text-input"] button[aria-label*="Send" i]',
      'div[data-testid="grok-text-input"] button[type="submit"]',
      'div[data-testid="tweetButtonInline"] button',
      'div[data-testid="tweetButtonInline"]',
      'button[data-testid="tweetButton"]',
      'button[aria-label*="send" i]',
      'button[aria-label*="submit" i]',
      'button[aria-label*="post" i]',
      'button[data-testid*="send"]',
      'div[role="button"][aria-label*="send" i]',
      'div[role="button"][data-testid*="send"]',
      'button[type="submit"]',
      'button:has(svg)'
    ];

    const containers = [];
    if (composerEl) containers.push(composerEl.closest('form'));
    if (composerEl) containers.push(composerEl.closest('[data-testid="grok-editor"]'));
    if (composerEl) containers.push(composerEl.closest('[data-testid="grok-text-input"]'));
    containers.push(document);

    const startTs = Date.now();
    while (Date.now() - startTs < timeoutMs) {
      for (const container of containers) {
        if (!container || typeof container.querySelector !== 'function') continue;
        for (const selector of fallbackSelectors) {
          const candidate = container.querySelector(selector);
          if (candidate && !candidate.disabled && isElementInteractable(candidate)) {
            console.log('[content-grok] Fallback send button selector matched:', selector);
            return candidate;
          }
        }
      }
      await sleep(200);
    }
    return null;
  }

  const sanitizeValue = (value) => String(value ?? '').replace(/\u200b/g, '');

  const normalizeEchoText = (text) => String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const STATUS_TEXT_PATTERNS = [
    /^поиск в сети$/,
    /^поиск в интернете$/,
    /^searching the web$/,
    /^searching web$/,
    /^searching$/,
    /^thinking$/,
    /^working on it$/,
    /^fetching results$/,
    /^looking up$/,
    /^gathering sources$/,
    /^retrieving$/,
    /^processing$/,
    /^loading$/,
    /^generating$/,
    /^analyzing$/
  ];

  function isServiceStatusText(text) {
    const normalized = normalizeEchoText(text);
    if (!normalized) return false;
    if (normalized.length > 80) return false;
    return STATUS_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  const readComposerValue = (input) => {
    if (!input) return '';
    const raw = (input.value ?? input.innerText ?? input.textContent ?? '').replace(/\u200b/g, '');
    return raw.trim();
  };

  function applyNativeValue(element, value) {
    if (!element) return;
    const tag = element.tagName;
    const proto = tag === 'INPUT'
      ? HTMLInputElement.prototype
      : tag === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function emitValueChange(element, text, inputType = 'insertFromPaste') {
    if (!element) return;
    const normalized = sanitizeValue(text);
    try {
      element.focus({ preventScroll: true });
    } catch (_) {
      element.focus?.();
    }
    try {
      const beforeEvt = new InputEvent('beforeinput', {
        data: normalized,
        inputType: 'insertReplacementText',
        bubbles: true,
        cancelable: true
      });
      element.dispatchEvent(beforeEvt);
    } catch (_) {}
    if ('value' in element) {
      applyNativeValue(element, normalized);
      try {
        element.selectionStart = element.selectionEnd = element.value.length;
      } catch (_) {}
    } else {
      element.textContent = normalized;
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: normalized, inputType }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return normalized;
  }

  async function waitForComposerStabilization(input, { retries = 5, delay = 200 } = {}) {
    for (let i = 0; i < retries; i++) {
      const text = readComposerValue(input);
      if (text.length > 0) return text;
      await sleep(delay);
    }
    return readComposerValue(input);
  }

  const normalizeForComparison = (text = '') => String(text)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  function buildBaselineSnapshot() {
    const snapshot = grabLatestAssistantText();
    return {
      node: snapshot?.node || null,
      text: snapshot?.text || '',
      html: snapshot?.html || '',
      normalizedText: normalizeForComparison(snapshot?.text || '')
    };
  }

  function isBaselineSnapshot(candidate, baseline) {
    if (!baseline || !candidate) return false;
    if (baseline.node && candidate.node && baseline.node === candidate.node) return true;
    if (baseline.normalizedText) {
      const currentNormalized = normalizeForComparison(candidate.text || '');
      if (currentNormalized && currentNormalized === baseline.normalizedText) return true;
    }
    return false;
  }

  function getFreshAssistantSnapshot(baseline) {
    const snapshot = grabLatestAssistantText();
    if (isBaselineSnapshot(snapshot, baseline)) {
      return { text: '', html: '', node: null, normalizedText: '' };
    }
    return snapshot;
  }

  async function refineShortAnswerIfNeeded(cleaned, html, prompt, baseline, shouldAbort) {
    const normalized = String(cleaned || '').trim();
    if (normalized.length >= MIN_GROK_ANSWER_LEN) {
      return { text: normalized, html };
    }
    try {
      const fallback = await waitForDomAnswer(
        prompt,
        SHORT_ANSWER_FALLBACK_TIMEOUT_MS,
        700,
        shouldAbort || (() => false),
        baseline
      );
      if (fallback?.text && fallback.text.length > normalized.length) {
        return fallback;
      }
    } catch (err) {
      console.warn('[content-grok] Short answer fallback failed', err);
    }
    return { text: normalized, html };
  }

  function describeNode(node) {
    if (!node || !node.tagName) return 'unknown-node';
    const id = node.id ? `#${node.id}` : '';
    const classes = node.classList?.length ? `.${Array.from(node.classList).join('.')}` : '';
    const role = node.getAttribute?.('role');
    const editable = node.isContentEditable || node.getAttribute?.('contenteditable');
    const info = [`<${node.tagName.toLowerCase()}${id}${classes}>`];
    if (role) info.push(`role=${role}`);
    if (editable) info.push('contenteditable');
    if (node.tabIndex >= 0) info.push(`tabIndex=${node.tabIndex}`);
    return info.join(' ');
  }

  function traceNodePath(node) {
    const segments = [];
    let current = node;
    let depth = 0;
    while (current && depth < 8) {
      if (current === document) {
        segments.push('document');
        break;
      }
      segments.push(describeNode(current));
      if (current.parentElement) {
        current = current.parentElement;
      } else if (current.getRootNode && current.getRootNode().host) {
        current = current.getRootNode().host;
      } else {
        break;
      }
      depth++;
    }
    return segments.join(' <- ');
  }

  async function forceComposerValue(input, prompt) {
    if (!input) return '';
    const normalized = String(prompt ?? '');
    emitValueChange(input, normalized);
    await sleep(150);
    return readComposerValue(input);
  }

  const isPromptEcho = (candidate, prompt) => {
    if (!candidate || !prompt) return false;
    const normCandidate = normalizeEchoText(candidate);
    const normPrompt = normalizeEchoText(prompt);
    if (!normCandidate || !normPrompt) return false;
    if (normCandidate === normPrompt) return true;
    if (normCandidate.includes(normPrompt) && normCandidate.length <= normPrompt.length + 120) return true;
    const promptHead = normPrompt.slice(0, Math.min(normPrompt.length, 180));
    if (promptHead.length >= 25 && normCandidate.startsWith(promptHead)) return true;
    const limit = Math.min(normPrompt.length, normCandidate.length);
    let overlap = 0;
    for (let i = 0; i < limit; i++) {
      if (normCandidate[i] !== normPrompt[i]) break;
      overlap++;
    }
    if (overlap >= Math.min(limit, normPrompt.length * 0.9)) return true;
    return false;
  };


  // -------------------- SmartScroll / KeepAlive (Гибкий) --------------------
  const grokScrollCoordinator = window.ScrollCoordinator
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
      () => (typeof grokScrollCoordinator !== 'undefined' ? grokScrollCoordinator : null),
      () => (typeof leChatScrollCoordinator !== 'undefined' ? leChatScrollCoordinator : null),
      () => (typeof qwenScrollCoordinator !== 'undefined' ? qwenScrollCoordinator : null),
      () => (typeof deepseekScrollCoordinator !== 'undefined' ? deepseekScrollCoordinator : null),
      () => (typeof claudeScrollCoordinator !== 'undefined' ? claudeScrollCoordinator : null)
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

  function watchResponseActivity(timeout = 5000) {
    return new Promise((resolve) => {
      const root = document.querySelector('main[role="main"]') || document.querySelector('div[role="main"]') || document.body;
      if (!root) {
        setTimeout(() => resolve(false), timeout);
        return;
      }
      let settled = false;
      let stopObserve = () => {};
      let timerId = null;
      const finish = (result, reason = '') => {
        if (settled) return;
        settled = true;
        try { stopObserve(); } catch (_) {}
        if (timerId) clearTimeout(timerId);
        if (reason) {
          console.log(`[content-grok] Response activity detected: ${reason}`);
        }
        resolve(result);
      };
      stopObserve = window.ContentUtils?.observeMutations
        ? window.ContentUtils.observeMutations(
          root,
          { childList: true, subtree: true, attributes: false },
          (mutations) => {
            for (const mutation of mutations) {
              if (mutation.addedNodes && mutation.addedNodes.length) {
                for (const node of mutation.addedNodes) {
                  if (node.nodeType === Node.ELEMENT_NODE) {
                    const elem = node;
                    if (elem.matches?.('[role="article"]') ||
                        elem.querySelector?.('[role="article"]') ||
                        elem.matches?.('[data-testid*="message"]') ||
                        elem.querySelector?.('[data-testid*="message"]') ||
                        elem.matches?.('[data-testid*="response"]') ||
                        elem.querySelector?.('[data-testid*="response"]') ||
                        elem.matches?.('[class*="streaming"]') ||
                        elem.querySelector?.('[class*="streaming"]') ||
                        (elem.textContent && elem.textContent.trim().length > 20)) {
                      finish(true, 'response_element_added');
                      return;
                    }
                  }
                }
              }
            }
          }
        )
        : (() => () => {})();
      timerId = setTimeout(() => finish(false, 'timeout'), timeout);
    });
  }

  async function waitForComposerClear(composerEl, timeout = 3500) {
    if (!composerEl) return false;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const text = (composerEl.value ?? composerEl.textContent ?? '').trim();
      if (!text.length) {
        return true;
      }
      await sleep(150);
    }
    return false;
  }

  function emitDiagnostic(event = {}) {
    try {
      chrome.runtime.sendMessage({
        type: 'LLM_DIAGNOSTIC_EVENT',
        llmName: MODEL,
        event: {
          ts: event.ts || Date.now(),
          type: event.type || 'INFO',
          label: event.label || '',
          details: event.details || '',
          level: event.level || 'info',
          meta: event.meta || {}
        }
      });
    } catch (err) {
      console.warn('[content-grok] Failed to emit diagnostic event', err);
    }
  }

  function ensureComposerFocus(composerEl) {
    if (!composerEl) return;
    try {
      composerEl.focus({ preventScroll: true });
    } catch (_) {
      composerEl.focus?.();
    }
    try {
      if (composerEl.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(composerEl);
        range.collapse(false);
        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
      } else if ('value' in composerEl && typeof composerEl.value === 'string') {
        const end = composerEl.value.length;
        composerEl.setSelectionRange?.(end, end);
      }
    } catch (_) {}
  }

  function resolveComposerDispatchTarget(composerEl) {
    const active = document.activeElement;
    if (active && (active === composerEl || composerEl?.contains?.(active))) return active;
    return composerEl;
  }

  function simulateCtrlEnter(composerEl) {
    if (!composerEl) return;
    ensureComposerFocus(composerEl);
    const target = resolveComposerDispatchTarget(composerEl);
    const events = [
      new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', bubbles: true }),
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, ctrlKey: true }),
      new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true, ctrlKey: true }),
      new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, ctrlKey: true }),
      new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft', bubbles: true })
    ];
    for (const evt of events) {
      target.dispatchEvent(evt);
    }
  }

  async function attemptSendViaButton(sendBtn, composerEl) {
    const humanoid = window.Humanoid;
    if (!humanoid) return false;
    const responseWatcher = watchResponseActivity(9000);
    emitDiagnostic({ type: 'SEND', label: 'Попытка через кнопку отправки', details: 'humanoid.click', level: 'info' });
    await humanoid.click(sendBtn);
    const composerTextBefore = (composerEl?.value ?? composerEl?.textContent ?? '').trim();
    if (composerTextBefore.length) {
      emitDiagnostic({ type: 'SEND', label: 'После клика текст остался, жмем Ctrl+Enter', level: 'info' });
      simulateCtrlEnter(composerEl);
    }
    const cleared = await waitForComposerClear(composerEl, 3500);
    const responseStarted = await responseWatcher;
    const success = cleared || responseStarted;
    emitDiagnostic({
      type: 'SEND',
      label: success ? 'Кнопка отправки подтвердила отправку' : 'Кнопка отправки не подтвердила отправку',
      details: '',
      level: success ? 'success' : 'warning'
    });
    return success;
  }

  async function attemptSendViaCtrlEnter(composerEl) {
    const responseWatcher = watchResponseActivity(8000);
    emitDiagnostic({ type: 'SEND', label: 'Попытка через Ctrl+Enter', level: 'info' });
    simulateCtrlEnter(composerEl);
    const cleared1 = await waitForComposerClear(composerEl, 1500);
    if (cleared1) {
      emitDiagnostic({ type: 'SEND', label: 'Ctrl+Enter подтвердил отправку (композер очищен)', level: 'success' });
      return true;
    }
    const responseStartedQuick = await Promise.race([
      responseWatcher.then(() => true).catch(() => false),
      sleep(2500).then(() => false)
    ]);
    if (responseStartedQuick) {
      emitDiagnostic({ type: 'SEND', label: 'Ctrl+Enter подтвердил отправку (ответ начался)', level: 'success' });
      return true;
    }
    emitDiagnostic({
      type: 'SEND',
      label: 'Ctrl+Enter не дал ответ',
      level: 'warning',
      details: 'No composer clear and no response detected'
    });
    return false;
  }

  // -------------------- ContentCleaner (мягкий, без агрессивной обрезки) --------------------
  class ContentCleaner {
    constructor() {
      this.rules = this._initRules();
      this.stats = { elementsRemoved: 0, charactersRemoved: 0, rulesApplied: 0 };
    }
    _initRules() {
      return {
        uiPhrases: [
          /\b(Send|Menu|Settings|New chat|Clear|Like|Reply|Copy|Share|Follow|Subscribe)\b/gi,
          /\b(Upload|Download|Save|Delete|Edit|Search|Filter|Sort)\b/gi,
          /\b(Grok|X\.com|Twitter|Gemini|Claude|Perplexity|GPT)\b/gi
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
          doc.querySelectorAll('script,style,svg,canvas,noscript,header,footer,nav,aside,[aria-hidden="true"]').forEach(el => {
            this.stats.elementsRemoved++;
            this.stats.charactersRemoved += (el.textContent || '').length;
            el.remove();
          });
          text = doc.body?.textContent || '';
        } catch (err) {
          console.warn('[ContentCleaner] DOMParser failed, falling back to text extraction', err);
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
  let lastResponseCache = '';
  let lastResponseHtml = '';

  function findLatestNonEchoResponse(prompt) {
    const selectors = [
      'article[data-role="assistant"]',
      'div[data-testid*="response"]',
      'div[class*="assistant"]',
      'div[class*="conversation-turn"]',
      'article',
      '.markdown'
    ];
    const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      const txt = (node.innerText || node.textContent || '').trim();
      if (!txt) continue;
      if (isServiceStatusText(txt)) continue;
      if (isPromptEcho(txt, prompt)) continue;
      try {
        return contentCleaner.clean(txt, { maxLength: 50000 });
      } catch (_) {
        return txt;
      }
    }
    return null;
  }

  async function waitForNonEchoResponse(prompt, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      let lastSeen = '';
      let settled = false;
      const cleanup = (value, isTimeout = false) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearInterval(intervalId);
        clearTimeout(timerId);
        if (value) {
          resolve(value);
        } else if (isTimeout && lastSeen) {
          resolve(lastSeen);
        } else {
          reject(new Error('Non-echo response timeout'));
        }
      };

      const evaluate = () => {
        const alt = findLatestNonEchoResponse(prompt);
        if (alt && !isServiceStatusText(alt) && !isPromptEcho(alt, prompt)) {
          if (alt === lastSeen) {
            cleanup(alt);
          } else {
            lastSeen = alt;
          }
        }
      };

      const stopObserve = window.ContentUtils?.observeMutations
        ? window.ContentUtils.observeMutations(document.body, { childList: true, subtree: true, characterData: true }, () => evaluate())
        : (() => () => {})();
      const intervalId = cleanupScope.trackInterval(setInterval(() => evaluate(), 400));
      const timerId = cleanupScope.trackTimeout(setTimeout(() => cleanup(null, true), timeoutMs));
      evaluate();
    });
  }

  async function waitForDomAnswer(prompt, timeoutMs = 45000, intervalMs = 900, shouldAbort = () => false, baseline = null) {
    const startedAt = Date.now();
    emitDiagnostic({
      type: 'DOM_FALLBACK',
      label: 'DOM_FALLBACK_START',
      details: `timeout=${timeoutMs}ms interval=${intervalMs}ms`,
      level: 'info',
      meta: { timeoutMs, intervalMs }
    });
    const deadline = Date.now() + timeoutMs;
    let lastStable = '';
    let attempts = 0;
    while (Date.now() < deadline) {
      if (shouldAbort()) return null;
      attempts += 1;
      const candidate = grabLatestAssistantText();
      if (candidate && (candidate.text || candidate.html)) {
        if (baseline && isBaselineSnapshot(candidate, baseline)) {
          await sleep(intervalMs);
          continue;
        }
        const cleaned = contentCleaner.clean(candidate.text || candidate.html || '', { maxLength: 50000 });
        if (cleaned && !isServiceStatusText(cleaned) && !isPromptEcho(cleaned, prompt)) {
          if (cleaned === lastStable) {
            emitDiagnostic({
              type: 'DOM_FALLBACK',
              label: 'DOM_FALLBACK_SUCCESS',
              details: `elapsed=${Date.now() - startedAt}ms length=${cleaned.length}`,
              level: 'success',
              meta: {
                timeoutMs,
                intervalMs,
                elapsedMs: Date.now() - startedAt,
                attempts,
                length: cleaned.length
              }
            });
            return { text: cleaned, html: candidate.html || '' };
          }
          lastStable = cleaned;
        }
      }
      await sleep(intervalMs);
    }
    emitDiagnostic({
      type: 'DOM_FALLBACK',
      label: 'DOM_FALLBACK_TIMEOUT',
      details: `elapsed=${Date.now() - startedAt}ms`,
      level: 'warning',
      meta: {
        timeoutMs,
        intervalMs,
        elapsedMs: Date.now() - startedAt,
        attempts
      }
    });
    return null;
  }

  // -------------------- Metrics Collection System --------------------
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
      const operation = { id, name, start: Date.now(), end: null, success: null, metadata: context || {} };
      const events = window.HumanoidEvents;
      if (events?.start) {
        try {
          operation.lifecycleTraceId = events.start(`metrics:${name}`, {
            mode: getLifecycleMode(),
            operation: name
          });
        } catch (_) {}
      }
      this.metrics.operations.push(operation);
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

  // -------------------- ПЕРЕНЕСЁННЫЕ ФУНКЦИИ ИЗ РАБОЧЕЙ ВЕРСИИ --------------------

  const now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  function isWritableComposerElement(node) {
    if (!node) return false;
    const tag = node.tagName || '';
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      const type = String(node.type || '').toLowerCase();
      return type === 'text' || type === 'search' || type === 'email' || type === 'url';
    }
    if (node.isContentEditable) return true;
    if (node.getAttribute?.('contenteditable') === 'true') return true;
    if (node.getAttribute?.('role') === 'textbox') return true;
    return false;
  }

  function resolveWritableInput(base) {
    if (!base) return null;
    if (isWritableComposerElement(base)) return base;
    const nestedSelectors = [
      '[role="textbox"][contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      '[data-lexical-editor] [contenteditable="true"]',
      '[data-testid*="composer"] [contenteditable="true"]',
      '[data-testid*="composer"] [role="textbox"]',
      'div[role="textbox"]',
      'textarea.tiptap-textarea',
      'textarea'
    ];
    for (const selector of nestedSelectors) {
      const scoped = base.querySelector?.(selector);
      if (scoped) return scoped;
    }
    for (const selector of nestedSelectors) {
      const globalMatch = document.querySelector(selector);
      if (globalMatch && base.contains?.(globalMatch)) {
        return globalMatch;
      }
    }
    return null;
  }

  function getComposerFromSelection() {
    const selection = window.getSelection?.();
    const anchor = selection?.anchorNode;
    if (!anchor) return null;
    let node = anchor.nodeType === 1 ? anchor : anchor.parentElement;
    let steps = 0;
    while (node && steps < 8) {
      if (isElementInteractable(node)) {
        const resolved = resolveWritableInput(node);
        if (resolved && isWritableComposerElement(resolved)) return resolved;
      }
      node = node.parentElement;
      steps += 1;
    }
    return null;
  }

  function getActiveComposerCandidate() {
    const active = document.activeElement;
    if (!active) return null;
    if (isElementInteractable(active)) {
      const resolved = resolveWritableInput(active);
      if (resolved && isWritableComposerElement(resolved)) return resolved;
    }
    if (active.shadowRoot) {
      const nested = active.shadowRoot.querySelector('textarea, div[contenteditable="true"], [role="textbox"], textarea.tiptap-textarea');
      const resolved = resolveWritableInput(nested);
      if (resolved && isWritableComposerElement(resolved)) return resolved;
    }
    return null;
  }

  function discoverComposer() {
    const attempts = [];
    const strategies = [
      { label: 'activeElement', resolver: getActiveComposerCandidate },
      { label: 'selection', resolver: getComposerFromSelection }
    ];
    for (const strategy of strategies) {
      const node = strategy.resolver();
      const attemptInfo = {
        strategy: strategy.label,
        found: !!node,
        interactable: node ? isElementInteractable(node) : false,
        tag: node?.tagName,
        type: node?.type,
        contentEditable: node?.contentEditable
      };
      attempts.push(attemptInfo);

      if (node && isElementInteractable(node) && isWritableComposerElement(node)) {
        emitDiagnostic({
          type: 'SELECTOR',
          label: `Composer via ${strategy.label}`,
          details: describeNode(node),
          level: 'info'
        });
        try {
          chrome.runtime.sendMessage({
            type: 'LLM_DIAGNOSTIC_EVENT',
            llmName: 'Grok',
            event: {
              ts: Date.now(),
              type: 'COMPOSER',
              label: 'COMPOSER_FOUND',
              details: `${strategy.label} → <${node.tagName}>`,
              level: 'success',
              meta: {
                strategy: strategy.label,
                tag: node.tagName,
                type: node?.type,
                contentEditable: node?.contentEditable,
                attempts: attempts
              }
            }
          });
        } catch (_) {}
        return resolveWritableInput(node);
      }
    }
    try {
      chrome.runtime.sendMessage({
        type: 'LLM_DIAGNOSTIC_EVENT',
        llmName: 'Grok',
        event: {
          ts: Date.now(),
          type: 'COMPOSER',
          label: 'COMPOSER_NOT_FOUND',
          details: `Tried ${attempts.length} strategies, all failed`,
          level: 'error',
          meta: {
            attempts: attempts,
            activeElement: document.activeElement?.tagName || 'none',
            url: window.location.href
          }
        }
      });
    } catch (_) {}
    return null;
  }

  async function findComposer(timeout = 30000) {
    const started = now();
    console.log('[content-grok] Finding composer via SelectorFinder...');
    try {
      const result = await selectorFinder.findOrDetectSelector({
        modelName: MODEL,
        elementType: 'composer',
        timeout
      });
      const resolved = result?.element ? resolveWritableInput(result.element) : null;
      if (resolved && isElementInteractable(resolved) && isWritableComposerElement(resolved)) {
        console.log(`[content-grok] Composer found via ${result.method} in ${Math.round(now() - started)}ms`);
        if (result.method === 'cache') {
          metricsCollector.recordSelectorEvent('cache_hit');
        } else {
          metricsCollector.recordSelectorEvent('hit');
        }
        return { element: resolved, method: result.method };
      }
      console.warn('[content-grok] SelectorFinder returned no composer element.');
    } catch (err) {
      console.warn('[content-grok] SelectorFinder composer lookup failed:', err);
    }
    metricsCollector.recordSelectorEvent('miss');
    return null;
  }

  // -------------------- Отправка результата в бекграунд --------------------
  function sendResult(resp, ok = true) {
    const { text, html } = normalizeResponsePayload(resp, lastResponseHtml);
    if (ok) {
      const stats = contentCleaner.getStats();
      chrome.runtime.sendMessage({
        type: 'CONTENT_CLEANING_STATS',
        llmName: MODEL,
        stats,
        timestamp: Date.now()
      });
    }
    chrome.runtime.sendMessage({
      type: 'LLM_RESPONSE',
      llmName: MODEL,
      answer: ok ? text : `Ошибка: ${text}`,
      answerHtml: ok ? html : ''
    });
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
      console.warn('[content-grok] Failed to parse data URL', err);
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
          console.warn('[content-grok] Failed to hydrate attachment', item?.name, err);
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

  async function attachFilesToComposer(target, attachments = []) {
    if (!attachments || !attachments.length) return false;
    const files = hydrateAttachments(attachments).slice(0, 5);
    if (!files.length) return false;

    const makeDataTransfer = () => {
      const dt = new DataTransfer();
      files.forEach((f) => {
        try { dt.items.add(f); } catch (_) {}
      });
      dt.effectAllowed = 'copy';
      return dt;
    };

    const dispatchDropSequence = async (el) => {
      if (!el) return false;
      const dt = makeDataTransfer();
      try {
        for (const type of ['dragenter', 'dragover', 'drop']) {
          const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
          el.dispatchEvent(ev);
          await sleep(40);
        }
        await sleep(1400);
        return true;
      } catch (err) {
        console.warn('[content-grok] drop dispatch failed', err);
        return false;
      }
    };

    if (await dispatchDropSequence(target)) return true;
    if (await dispatchDropSequence(target?.parentElement)) return true;

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

    let fileInput = await waitForElement(inputSelectors, 3000, 120);
    if (!fileInput) {
      fileInput = document.querySelector('input[type="file"]');
    }
    if (!fileInput) {
      console.warn('[content-grok] File input not found, skipping attachments');
      return false;
    }

    const dt = makeDataTransfer();
    try { fileInput.files = dt.files; } catch (err) { console.warn('[content-grok] set files failed', err); }
    try {
      fileInput.dispatchEvent(new Event('input', { bubbles: true }));
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (err) {
      console.warn('[content-grok] input/change dispatch failed', err);
    }
    try { fileInput.focus?.({ preventScroll: true }); } catch (_) { try { fileInput.focus?.(); } catch (_) {} }
    await sleep(1800);
    return true;
  }

  // -------------------- Публичная операция: inject → wait → extract → clean → send --------------------
  async function injectAndGetResponse(prompt, attachments = [], meta = null) {
    const dispatchMeta = meta && typeof meta === 'object' ? meta : null;
    return runLifecycle('grok:inject', buildLifecycleContext(prompt), async (activity) => {
      const opId = metricsCollector.startOperation('injectAndGetResponse');
      const startTime = Date.now();
      let responseDelivered = false;
      const deliverAnswer = (answerPayload, source = 'unknown') => {
        const payload = normalizeResponsePayload(answerPayload, lastResponseHtml);
        const text = payload.text;
        if (responseDelivered || !text) return false;
        responseDelivered = true;
        if (payload.html) lastResponseHtml = payload.html;
        if (text) lastResponseCache = text;
        sendResult(payload, true);
        activity.stop({ status: 'success', answerLength: text.length, source });
        return true;
      };
      try {
        await sleep(1000);
        activity.heartbeat(0.15, { phase: 'composer-search' });

        let composer = discoverComposer();
        if (composer && !isWritableComposerElement(composer)) {
          composer = null;
        }
        if (composer) {
          emitDiagnostic({
            type: 'SELECTOR',
            label: 'Поле ввода найдено (heuristics)',
            details: traceNodePath(composer),
            level: 'info'
          });
        } else {
          const composerMatch = await findComposer(30000);
          if (!composerMatch?.element) {
            throw { type: 'selector_not_found', message: 'Grok input field not found' };
          }
          composer = resolveWritableInput(composerMatch.element);
          if (!composer) {
            throw { type: 'selector_not_found', message: 'Writable composer not found' };
          }
        emitDiagnostic({
          type: 'SELECTOR',
          label: 'Поле ввода найдено',
          details: `Метод: ${composerMatch.method || 'unknown'}`,
          level: 'success'
        });
        }
        activity.heartbeat(0.3, { phase: 'composer-ready' });

        await attachFilesToComposer(composer, attachments);

        const humanoid = window.Humanoid;
        if (!humanoid) {
          throw { type: 'humanoid_missing', message: 'Humanoid interaction module not available' };
        }

        await humanoid.typeText(composer, prompt, { instant: true });
        let validationText = await waitForComposerStabilization(composer, { retries: 6, delay: 240 });
        const normalizedPromptHead = normalizeForComparison(prompt).slice(0, 120);
        let normalizedValue = normalizeForComparison(validationText);
        if (!normalizedValue.length || (normalizedPromptHead && !normalizedValue.includes(normalizedPromptHead))) {
          emitDiagnostic({ type: 'INPUT', label: 'Повторная попытка вставки (не совпало)', level: 'warning' });
          validationText = await forceComposerValue(composer, prompt);
          normalizedValue = normalizeForComparison(validationText);
        }
        if (!normalizedValue.length || (normalizedPromptHead && !normalizedValue.includes(normalizedPromptHead))) {
          throw { type: 'injection_failed', message: 'Input did not accept value (React guard).' };
        }

        const injectedAt = Date.now();
        emitDiagnostic({
          type: 'COMPOSER',
          label: 'Prompt injected',
          details: `length=${normalizedValue.length}`,
          level: 'info'
        });
        activity.heartbeat(0.4, { phase: 'typing' });
        const baselineSnapshot = buildBaselineSnapshot();
        const elapsedSinceInject = Date.now() - injectedAt;
        const sendDelay = Math.max(0, 2000 - elapsedSinceInject);
        if (sendDelay) {
          await sleep(sendDelay);
        }

        let sendMethod = 'ctrl_enter';
        let dispatchSuccess = await attemptSendViaCtrlEnter(composer);
        if (!dispatchSuccess) {
          let sendBtn = null;
          let sendBtnMethod = null;
          const started = now();
          console.log('[content-grok] Finding send button via SelectorFinder...');
          activity.heartbeat(0.5, { phase: 'send-button-search' });
          try {
            const result = await selectorFinder.findOrDetectSelector({
              modelName: MODEL,
              elementType: 'sendButton',
              timeout: 5000,
              referenceElement: composer
            });
            if (result?.element && !result.element.disabled) {
              console.log(`[content-grok] Send button found via ${result.method} in ${Math.round(now() - started)}ms`);
              sendBtn = result.element;
              sendBtnMethod = result.method || 'versioned';
            } else {
              console.warn('[content-grok] SelectorFinder returned no send button element.');
            }
          } catch (err) {
            console.warn('[content-grok] SelectorFinder send button lookup failed:', err);
          }

          if ((!sendBtn || sendBtn.disabled) && composer) {
            console.warn('[content-grok] SelectorFinder send button lookup failed, trying fallback DOM queries...');
            sendBtn = await fallbackFindSendButton(composer, 6000);
            if (sendBtn) {
              sendBtnMethod = 'fallback';
            }
          }

          if (!sendBtn || sendBtn.disabled) {
            emitDiagnostic({
              type: 'SELECTOR',
              label: 'Кнопка отправки не найдена',
              level: 'error'
            });
            throw { type: 'selector_not_found', message: 'Grok send button not found' };
          }
          emitDiagnostic({
            type: 'SELECTOR',
            label: 'Кнопка отправки найдена',
            details: `Метод: ${sendBtnMethod || 'unknown'}`,
            level: 'success'
          });

          if (sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true') {
            const enableStart = Date.now();
            while (Date.now() - enableStart < 8000) {
              if (!sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true') break;
              await sleep(150);
            }
          }

          console.warn('[content-grok] Ctrl+Enter did not trigger response, trying send button fallback...');
          dispatchSuccess = await attemptSendViaButton(sendBtn, composer);
          sendMethod = dispatchSuccess ? 'button' : sendMethod;
        }

        if (!dispatchSuccess) {
          emitDiagnostic({
            type: 'SEND',
            label: `Отправка не подтверждена (${sendMethod}) — продолжаем ожидание`,
            level: 'warning'
          });
        } else {
          console.log(`[content-grok] Prompt dispatched via ${sendMethod}`);
          emitDiagnostic({
            type: 'SEND',
            label: `Отправка подтверждена (${sendMethod})`,
            level: 'success'
          });
        }
        activity.heartbeat(0.6, { phase: 'send-dispatched' });
        const submissionMeta = Object.assign({}, dispatchMeta || {}, { confirmed: !!dispatchSuccess, method: sendMethod });
        try { chrome.runtime.sendMessage({ type: 'PROMPT_SUBMITTED', llmName: MODEL, ts: Date.now(), meta: submissionMeta }); } catch (_) {}

        activity.heartbeat(0.65, { phase: 'waiting-response' });
        const responsePayload = await withSmartScroll(async () => {
          let pipelineAnswer = null;
          const domFallbackPromise = waitForDomAnswer(
            prompt,
            45000,
            900,
            () => responseDelivered,
            baselineSnapshot
          );
          await tryGrokPipeline(prompt, {
            heartbeat: (meta = {}) => activity.heartbeat(0.8, Object.assign({ phase: 'pipeline' }, meta)),
            stop: async ({ answer, answerHtml, metadata }) => {
              emitDiagnostic({
                type: 'PIPELINE',
                label: 'UnifiedAnswerPipeline completed',
                details: `Duration: ${metadata?.duration ?? 0}ms`,
                level: 'success'
              });
              let cleaned = contentCleaner.clean(answer, { maxLength: 50000 });
              let html = String(answerHtml || '').trim();
              if (isServiceStatusText(cleaned)) {
                cleaned = '';
              }
              if (!String(cleaned || '').trim()) {
                const domFallback = getFreshAssistantSnapshot(baselineSnapshot);
                cleaned = contentCleaner.clean(domFallback.text || domFallback.html || '', { maxLength: 50000 });
                if (!html && domFallback.html) html = domFallback.html;
              }
              if (isServiceStatusText(cleaned)) {
                cleaned = '';
              }
              const refined = await refineShortAnswerIfNeeded(
                cleaned,
                html,
                prompt,
                baselineSnapshot,
                () => responseDelivered
              );
              cleaned = refined.text;
              if (refined.html) html = refined.html;
              if (!String(cleaned || '').trim()) {
                throw new Error('Empty answer extracted');
              }
              if (html) lastResponseHtml = html;
              pipelineAnswer = { text: cleaned, html };
              metricsCollector.recordTiming('total_response_time', Date.now() - startTime);
              metricsCollector.endOperation(opId, true, {
                responseLength: cleaned.length,
                duration: Date.now() - startTime,
                source: 'pipeline'
              });
              deliverAnswer({ text: cleaned, html }, 'pipeline');
              return pipelineAnswer;
            }
          });
          if (pipelineAnswer) {
            return pipelineAnswer;
          }

          const domFallbackAnswer = await domFallbackPromise;
          if (domFallbackAnswer && !responseDelivered) {
            const fallbackPayload = normalizeResponsePayload(domFallbackAnswer, lastResponseHtml);
            let cleaned = contentCleaner.clean(fallbackPayload.text || fallbackPayload.html || '', { maxLength: 50000 });
            if (isServiceStatusText(cleaned)) {
              cleaned = '';
            }
            if (isPromptEcho(cleaned, prompt)) {
              const alt = await waitForNonEchoResponse(prompt, 15000);
              if (alt && !isPromptEcho(alt, prompt)) {
                cleaned = alt;
              }
            }
            if (fallbackPayload.html) lastResponseHtml = fallbackPayload.html;
            if (deliverAnswer({ text: cleaned, html: fallbackPayload.html }, 'dom-fallback')) {
              metricsCollector.recordTiming('total_response_time', Date.now() - startTime);
              metricsCollector.endOperation(opId, true, {
                responseLength: cleaned.length,
                duration: Date.now() - startTime,
                source: 'dom-fallback'
              });
              activity.heartbeat(0.9, { phase: 'response-processed' });
              return { text: cleaned, html: fallbackPayload.html };
            }
          }

          const responseSnapshot = getFreshAssistantSnapshot(baselineSnapshot);
          let cleaned = contentCleaner.clean(responseSnapshot.text || responseSnapshot.html || '', { maxLength: 50000 });
          if (isServiceStatusText(cleaned)) {
            cleaned = '';
          }
          if (!String(cleaned || '').trim()) {
            const domFallback = await domFallbackPromise;
            const fallbackPayload = normalizeResponsePayload(domFallback, lastResponseHtml);
            cleaned = contentCleaner.clean(fallbackPayload.text || fallbackPayload.html || '', { maxLength: 50000 });
            if (fallbackPayload.html) lastResponseHtml = fallbackPayload.html;
          }
          if (isServiceStatusText(cleaned)) {
            cleaned = '';
          }
          if (!String(cleaned || '').trim()) {
            throw new Error('Empty answer extracted');
          }
          if (isPromptEcho(cleaned, prompt)) {
            console.warn('[content-grok] Detected prompt echo. Waiting for alternative response...');
            const alt = await waitForNonEchoResponse(prompt, 15000);
            if (alt && !isPromptEcho(alt, prompt)) {
              cleaned = alt;
            } else {
              throw { type: 'echo_detected', message: 'Grok returned prompt back instead of response' };
            }
          }
          
          if (deliverAnswer({ text: cleaned, html: lastResponseHtml }, 'dom-snapshot')) {
            metricsCollector.recordTiming('total_response_time', Date.now() - startTime);
            metricsCollector.endOperation(opId, true, { 
              responseLength: cleaned.length,
              duration: Date.now() - startTime
            });
            activity.heartbeat(0.9, { phase: 'response-processed' });
          }
          return { text: cleaned, html: lastResponseHtml };
        }, { keepAliveInterval: 2000, operationTimeout: 300000, debug: false });
        const normalized = normalizeResponsePayload(responsePayload, lastResponseHtml);
        if (!String(normalized.text || '').trim()) {
          const fallback = await waitForDomAnswer(
            prompt,
            SHORT_ANSWER_FALLBACK_TIMEOUT_MS,
            700,
            () => responseDelivered,
            baselineSnapshot
          );
          if (fallback?.text) {
            return fallback;
          }
          throw new Error('Empty answer extracted');
        }
        return responsePayload;
      } catch (e) {
        if (e?.code === 'background-force-stop') {
          activity.error(e, false);
          throw e;
        }
        console.error('[content-grok] injectAndGetResponse error:', e);
        metricsCollector.recordError(e, 'injectAndGetResponse', opId);
        metricsCollector.endOperation(opId, false, { error: e?.message });
        emitDiagnostic({
          type: 'ERROR',
          label: 'Ошибка обработки запроса',
          details: e?.message || 'unknown',
          level: 'error'
        });
        sendResult(e?.message || String(e), false);
        activity.error(e, true);
        throw e;
      }
    });
  }

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

      if (msg?.type === 'ANTI_SLEEP_PING') {
        if (window.__LLMScrollHardStop) return false;
        if (isUserInteracting()) {
          stopDriftFallback();
          return false;
        }
        runAntiSleepPulse(msg.intensity || 'soft');
        stopDriftFallback();
        return false;
      }

      if (msg?.type === 'CHECK_READINESS') {
        try {
          const composer = discoverComposer();
          try {
            chrome.runtime.sendMessage({
              type: 'LLM_DIAGNOSTIC_EVENT',
              llmName: 'Grok',
              event: {
                ts: Date.now(),
                type: 'READINESS',
                label: 'CHECK_READINESS_COMPOSER',
                details: composer
                  ? `Found: <${composer.tagName}> disabled=${composer.disabled} interactable=${isElementInteractable(composer)}`
                  : 'null',
                level: composer ? 'info' : 'warning',
                meta: {
                  found: !!composer,
                  tag: composer?.tagName,
                  disabled: composer?.disabled,
                  interactable: composer ? isElementInteractable(composer) : false
                }
              }
            });
          } catch (_) {}

          if (!composer) {
            sendResponse({ ready: false, reason: 'composer_not_found' });
            return true;
          }

          if (composer.tagName === 'TEXTAREA' && composer.disabled) {
            sendResponse({ ready: false, reason: 'composer_disabled' });
            return true;
          }

          const modal = document.querySelector('[role="dialog"], .modal, [class*="captcha" i]');
          if (modal && modal.offsetParent !== null) {
            sendResponse({ ready: false, reason: 'modal_visible' });
            return true;
          }

          sendResponse({ ready: true, reason: 'ok' });
          return true;
        } catch (err) {
          console.error('[content-grok] CHECK_READINESS error:', err);
          sendResponse({ ready: false, reason: 'error' });
          return true;
        }
      }

      if (msg?.type === 'GET_ANSWER' || msg?.type === 'GET_FINAL_ANSWER') {
        injectAndGetResponse(msg.prompt, msg.attachments, msg.meta || null)
          .then((resp) => {
            if (msg.isFireAndForget) {
              console.log('[content-grok] Fire-and-forget request processed. Not sending response back.');
              sendResponse?.({ status: 'success_fire_and_forget' });
              return;
            }
            const responseType = msg.type === 'GET_ANSWER' ? 'LLM_RESPONSE' : 'FINAL_LLM_RESPONSE';

            const stats = contentCleaner.getStats();
            chrome.runtime.sendMessage({ 
              type: 'CONTENT_CLEANING_STATS', 
              llmName: MODEL, 
              stats: stats, 
              timestamp: Date.now() 
            });

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
            const errorMessage = err?.message || String(err) || 'Unknown error in content-grok';
            const responseType = msg.type === 'GET_ANSWER' ? 'LLM_RESPONSE' : 'FINAL_LLM_RESPONSE';
            chrome.runtime.sendMessage({
              type: responseType,
              llmName: MODEL,
              answer: `Error: ${errorMessage}`,
              error: { type: err?.type || 'generic_error', message: errorMessage },
              meta: msg.meta || null
            });
            sendResponse?.({ status: 'error', message: errorMessage });
          });
        return true;
      }

      if (msg.action === 'injectPrompt' || msg.action === 'sendPrompt' || msg.action === 'REQUEST_LLM_RESPONSE') {
        const prompt = msg.prompt || '';
        injectAndGetResponse(prompt);
      } else if (msg.action === 'getResponses') {
        const source = msg?.meta?.source || 'manual';
        emitDiagnostic({
          type: 'PING',
          label: 'Повторное извлечение ответа',
          details: `source: ${source}`,
          level: 'info'
        });

        let manualPingId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        sendResponse?.({ status: 'manual_refresh_started', pingId: manualPingId });

        (async () => {
          try {
            await withSmartScroll(async () => {
              emitDiagnostic({ type: 'PING', label: 'Ждем появления ответа', level: 'info', meta: { pingId: manualPingId } });
              const responseMatch = await waitForDomAnswer('', 45000, 900, () => false, buildBaselineSnapshot());
              const payload = normalizeResponsePayload(responseMatch, lastResponseHtml);
              const cleaned = contentCleaner.clean(payload.text || payload.html || '');

              if (cleaned && cleaned !== lastResponseCache) {
                lastResponseCache = cleaned;
                sendResult(cleaned, true);
                emitDiagnostic({ type: 'PING', label: 'Ответ обновлен после ping', level: 'success', meta: { pingId: manualPingId } });
              } else {
                emitDiagnostic({ type: 'PING', label: 'Ответ не изменился после ping', level: 'info', meta: { pingId: manualPingId } });
                chrome.runtime.sendMessage({ type: 'MANUAL_PING_RESULT', llmName: MODEL, status: 'unchanged', pingId: manualPingId });
              }
            }, { keepAliveInterval: 2000, operationTimeout: 120000, debug: false });
            chrome.runtime.sendMessage({ type: 'MANUAL_PING_RESULT', llmName: MODEL, status: 'success', pingId: manualPingId });
          } catch (err) {
            if (err?.code === 'background-force-stop') {
              chrome.runtime.sendMessage({ type: 'MANUAL_PING_RESULT', llmName: MODEL, status: 'aborted', pingId: manualPingId });
              return;
            }
            emitDiagnostic({ type: 'PING', label: 'Повторное извлечение не удалось', details: err?.message || 'unknown error', level: 'error', meta: { pingId: manualPingId } });
            chrome.runtime.sendMessage({ type: 'MANUAL_PING_RESULT', llmName: MODEL, status: 'failed', error: err?.message || 'unknown error', pingId: manualPingId });
          }
        })();
        return true;
      }
    } catch (e) {
      console.error('[content-grok] onMessage error:', e);
      sendResult(e?.message || String(e), false);
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
  window.__grokAllCopyV6 = {
    injectAndGetResponse,
    contentCleaner
  };

  console.log('[content-grok] AllCopy v6 ready.');
})();
// ============================== IIFE END ==============================
