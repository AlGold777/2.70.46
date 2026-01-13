// content-qwen.js — AllCopy v6 "Adaptive Resilient Hybrid" (Qwen Edition)
// Архитектурная основа: content-grok (дубликат-guard, IIFE, self-healing, cleaner, 429)
// Адаптация: Qwen-специфичные селекторы и логика извлечения ответов
// Селекторы инъекции: из проверенного content-qwen.js

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
  if (window.qwenContentScriptLoaded) {
    console.warn('[content-qwen] Script already loaded, skipping duplicate initialization');
    throw new Error('Duplicate script load prevented');
  }
  window.qwenContentScriptLoaded = {
    timestamp: Date.now(),
    version: resolveExtensionVersion(),
    source: 'content-qwen'
  };
  console.log('[content-qwen] First load, initializing AllCopy v6…');

  const MODEL = 'Qwen';
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
  const getPragPlatform = () => prag?.adapter?.name || 'qwen';
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
    console.warn('[content-qwen] Cleanup triggered:', reason);
    try {
      getForceStopRegistry().run(reason);
    } catch (_) {}
    try {
      cleanupScope.cleanup?.(reason);
    } catch (err) {
      console.warn('[content-qwen] Cleanup scope failed', err);
    }
    try {
      window.qwenContentScriptLoaded = null;
    } catch (_) {}
    return reason;
  };
  window.__cleanup_qwen = stopContentScript;
  cleanupScope.addEventListener?.(window, 'pagehide', () => stopContentScript('pagehide'));
  cleanupScope.addEventListener?.(window, 'beforeunload', () => stopContentScript('beforeunload'));
  const NETWORK_BUFFER_LIMIT = 6;
  const networkAnswerBuffer = [];
  const QWEN_API_PATTERNS = [
    /\/api\/v2\/chat\/completions/i,
    /\/api\/v2\/chats\/[^/]+(?:\/messages)?$/i,
    /\/api\/v1\/chat\/completions/i
  ];
  const PROMPT_FINGERPRINT_SLICE = 800;
  const RESPONSE_NOISE_PATTERNS = [
    /^интерпретатор кода.*выполнен(?:\s*[>›»])?$/i,
    /^интерпретатор кода.*заверш(?:[а-я]*)(?:\s*[>›»])?$/i,
    /^интерпретатор кода\s+запущен(?:\s*[>›»✓]*)?$/i,
    /^code\s*interpreter\s*started(?:\s*[>›»✓]*)?$/i,
    /^code\s*interpreter.*(finished|completed|ready|successfully)(?:\s*[>›»])?$/i,
    /^(?:the )?tool\s*(?:run|execution).*(?:finished|complete|completed)(?:\s*[>›»])?$/i,
    /^analysis (?:complete|finished|done)(?:\s*[>›»])?$/i,
    /^interpreter run.*(?:\s*[>›»])?$/i,
    /^代码解释器.*完成(?:\s*[>›»])?$/i,
    /^копировать$/i,
    /^спроси$/i,
    /^объяснить$/i,
    /^перевести(?:\(undefined\))?$/i,
    /^copy$/i,
    /^ask$/i,
    /^explain$/i,
    /^translate(?:\(undefined\))?$/i,
    /^копировать\s+спроси\s+объяснить\s+перевести(?:\(undefined\))?$/i,
    /^copy\s+ask\s+explain\s+translate(?:\(undefined\))?$/i,
    /^undefined$/i,
    /^\(undefined\)$/i,
    /^мышление$/i,
    /^поиск$/i,
    /^мышление\s+поиск$/i,
    /^thinking$/i,
    /^search$/i
  ];

  let lastResponseCache = '';
  const getHumanoid = () => (typeof window !== 'undefined' ? window.Humanoid : null);
  const isSpeedMode = () => !!window.__PRAGMATIST_SPEED_MODE;

  async function qwenHumanRead(duration = 520) {
    const humanoid = getHumanoid();
    if (humanoid?.readPage) {
      try {
        await humanoid.readPage(duration);
      } catch (err) {
        console.warn('[content-qwen] Humanoid.readPage failed', err);
      }
    }
  }

  async function qwenHumanClick(element) {
    const humanoid = getHumanoid();
    if (!element) return;
    if (humanoid?.click) {
      try {
        await humanoid.click(element);
        return;
      } catch (err) {
        console.warn('[content-qwen] Humanoid.click failed', err);
      }
    }
    element.click();
  }

  async function fallbackQwenType(input, text) {
    try {
      input.focus({ preventScroll: true });
    } catch (_) {
      input.focus?.();
    }
    await sleep(100);
    let inserted = false;
    try {
      document.execCommand('selectAll', false, null);
      inserted = document.execCommand('insertText', false, text);
    } catch (_) {
      inserted = false;
    }
    if (!inserted) {
      emitValueChange(input, text);
    } else {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await sleep(200);
  }

  async function qwenHumanType(input, text, options = {}) {
    const humanoid = getHumanoid();
    if (humanoid?.typeText) {
      try {
        await humanoid.typeText(input, text, options);
        return;
      } catch (err) {
        console.warn('[content-qwen] Humanoid.typeText failed', err);
      }
    }
    await fallbackQwenType(input, text);
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
      console.warn('[content-qwen] Failed to emit diagnostic event', err);
    }
  }

  window.setupHumanoidFetchMonitor?.(MODEL, ({ status, retryAfter, url }) => {
    if (status !== 429) return;
    if (url && !QWEN_API_PATTERNS.some((pattern) => pattern.test(url))) return;
    const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 || 60000 : 60000;
    console.error('[content-qwen] HTTP 429 detected for', url || 'unknown');
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
  const MIN_QWEN_ANSWER_LEN = 12;
  const SHORT_QWEN_FALLBACK_TIMEOUT_MS = 12000;

  async function tryQwenPipeline(promptText = '', lifecycle = {}) {
    const { heartbeat, stop } = lifecycle || {};
    if (!window.UnifiedAnswerPipeline) return null;
    heartbeat?.({
      stage: 'start',
      expectedLength: pipelineExpectedLength(promptText),
      pipeline: 'UnifiedAnswerPipeline'
    });
    try {
      const pipeline = new window.UnifiedAnswerPipeline('qwen', Object.assign({
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
      console.warn('[content-qwen] UnifiedAnswerPipeline failed, using legacy reply watcher', err);
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

  function quickHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h << 5) - h + s.charCodeAt(i);
      h |= 0;
    }
    return (h >>> 0).toString(36);
  }

  function safeJsonParse(str) {
    if (typeof str !== 'string') return null;
    try { return JSON.parse(str); } catch (_) { return null; }
  }

  function computePromptFingerprint(text) {
    if (!text) return null;
    const normalized = text.toString().trim();
    if (!normalized) return null;
    const slice = normalized.length > PROMPT_FINGERPRINT_SLICE
      ? normalized.slice(-PROMPT_FINGERPRINT_SLICE)
      : normalized;
    return quickHash(slice);
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

  function coerceText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      const parts = value.map(coerceText).filter(Boolean);
      return parts.join('\n').trim();
    }
    if (typeof value === 'object') {
      if (typeof value.text === 'string') return value.text.trim();
      if (typeof value.value === 'string') return value.value.trim();
      if (typeof value.message === 'string') return value.message.trim();
      if (typeof value.content === 'string') return value.content.trim();
      if (Array.isArray(value.content)) return coerceText(value.content);
      if (typeof value.data === 'string') return value.data.trim();
      if (Array.isArray(value.data)) return coerceText(value.data);
      if (value.segments) return coerceText(value.segments);
      if (value.parts) return coerceText(value.parts);
      if (value.children) return coerceText(value.children);
    }
    return '';
  }

  function stripNoiseLines(text) {
    if (!text) return '';
    const lines = text.split(/\n+/).map((line) => line.trim());
    const filtered = lines.filter((line) => {
      if (!line) return false;
      const shouldDrop = line.length <= 160 && RESPONSE_NOISE_PATTERNS.some((pattern) => pattern.test(line));
      return !shouldDrop;
    });
    return filtered.join('\n').trim();
  }

  function normalizeAnswerText(text) {
    if (!text) return '';
    return stripNoiseLines(text).trim();
  }

  function extractTextFromMessagePayload(msg) {
    if (!msg) return '';
    if (typeof msg === 'string') return msg.trim();
    if (Array.isArray(msg)) return coerceText(msg);
    if (typeof msg === 'object') {
      const keys = ['content', 'text', 'message', 'value', 'output', 'response', 'data'];
      for (const key of keys) {
        const maybe = coerceText(msg[key]);
        if (maybe) return maybe;
      }
      if (msg.segments) {
        const merged = coerceText(msg.segments);
        if (merged) return merged;
      }
    }
    return '';
  }

  function pluckAssistantText(messages) {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (!message) continue;
      const role = (message.role || message.sender || message.type || message.author || message.speaker || '').toString().toLowerCase();
      if (role.includes('assistant') || role.includes('bot') || role.includes('ai')) {
        const text = extractTextFromMessagePayload(message);
        const normalized = normalizeAnswerText(text);
        if (normalized) return normalized;
      }
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const fallback = normalizeAnswerText(extractTextFromMessagePayload(messages[i]));
      if (fallback) return fallback;
    }
    return '';
  }

  function extractAnswerFromPayload(payload) {
    if (!payload) return '';
    if (typeof payload === 'string') return normalizeAnswerText(payload);
    if (Array.isArray(payload)) return normalizeAnswerText(pluckAssistantText(payload));

    const directKeys = [
      'output_text', 'outputText', 'answer', 'response', 'result',
      'completion', 'reply', 'text', 'message', 'content', 'generated_text'
    ];

    for (const key of directKeys) {
      if (key in payload) {
        const direct = coerceText(payload[key]);
        const normalizedDirect = normalizeAnswerText(direct);
        if (normalizedDirect) return normalizedDirect;
      }
    }

    if (payload.data) {
      const fromData = extractAnswerFromPayload(payload.data);
      if (fromData) return fromData;
    }

    if (payload.messages) {
      const fromMessages = pluckAssistantText(payload.messages);
      if (fromMessages) return normalizeAnswerText(fromMessages);
    }

    if (payload.choices) {
      const choices = Array.isArray(payload.choices) ? payload.choices : [payload.choices];
      let collected = '';
      choices.forEach((choice) => {
        if (!choice) return;
        const segments = [];
        const main = extractAnswerFromPayload(choice.message || choice.output || choice.content || choice);
        if (main) segments.push(main);
        const deltaText = coerceText(choice.delta?.content);
        if (deltaText) segments.push(deltaText);
        const choiceText = segments.filter(Boolean).join('\n').trim();
        if (choiceText) {
          if (collected) collected += '\n';
          collected += choiceText;
        }
      });
      const normalizedCollected = normalizeAnswerText(collected);
      if (normalizedCollected) return normalizedCollected;
    }

    if (payload.data?.choices) {
      const fromChoices = extractAnswerFromPayload({ choices: payload.data.choices });
      if (fromChoices) return fromChoices;
    }

    const visited = new WeakSet();
    const fallbackStrings = [];
    const queue = [payload];
    while (queue.length) {
      const current = queue.shift();
      if (current == null) continue;
      if (typeof current === 'string') {
        const trimmed = current.trim();
        if (trimmed) fallbackStrings.push(trimmed);
        continue;
      }
      if (typeof current !== 'object') continue;
      if (visited.has(current)) continue;
      visited.add(current);

      if (Array.isArray(current)) {
        for (let i = current.length - 1; i >= 0; i--) queue.push(current[i]);
        continue;
      }

      const role = (current.role || current.sender || current.type || current.author || current.speaker || '').toString().toLowerCase();
      if (role && (role.includes('assistant') || role.includes('bot') || role.includes('ai'))) {
        const candidate = extractTextFromMessagePayload(current);
        if (candidate) return candidate;
      }

      Object.values(current).forEach((value) => queue.push(value));
    }

    if (fallbackStrings.length) {
      const best = fallbackStrings.sort((a, b) => b.length - a.length)[0];
      return normalizeAnswerText(best);
    }
    return '';
  }

  function extractPromptFromRequestPayload(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const directKeys = ['prompt', 'query', 'question', 'text', 'input', 'message', 'content', 'ask'];
    for (const key of directKeys) {
      if (!(key in payload)) continue;
      const text = coerceText(payload[key]);
      if (text) return text;
    }

    if (Array.isArray(payload.messages) && payload.messages.length) {
      for (let i = payload.messages.length - 1; i >= 0; i--) {
        const message = payload.messages[i];
        if (!message) continue;
        const role = (message.role || message.sender || message.type || '').toString().toLowerCase();
        if (!role || role.includes('user')) {
          const text = extractTextFromMessagePayload(message);
          if (text) return text;
        }
      }
    }

    if (Array.isArray(payload.inputs) && payload.inputs.length) {
      const text = coerceText(payload.inputs);
      if (text) return text;
    }

    if (Array.isArray(payload.input) && payload.input.length) {
      const text = coerceText(payload.input);
      if (text) return text;
    }

    if (payload.data) {
      const nested = extractPromptFromRequestPayload(payload.data);
      if (nested) return nested;
    }
    return '';
  }

  function collectRequestMetadata(options = {}) {
    const meta = { started: Date.now(), promptFingerprint: null, promptSnippet: null };
    if (!options) return meta;

    const body = options?.body;
    let bodyString = '';

    if (typeof body === 'string') {
      bodyString = body;
    } else if (body instanceof URLSearchParams) {
      bodyString = body.toString();
    }

    if (bodyString && bodyString.length <= 500000) {
      const parsed = safeJsonParse(bodyString);
      if (parsed) {
        const promptText = extractPromptFromRequestPayload(parsed);
        if (promptText) {
          meta.promptFingerprint = computePromptFingerprint(promptText);
          meta.promptSnippet = promptText.slice(0, 160);
        }
      }
    }

    return meta;
  }

  async function handleQwenApiResponse(response, meta = {}) {
    if (!response) return;
    try {
      const contentType = response.headers?.get('content-type') || '';
      let extracted = '';
      if (contentType.includes('application/json')) {
        const payload = await response.json().catch(() => null);
        if (payload) extracted = extractAnswerFromPayload(payload);
      } else if (contentType.includes('text/event-stream')) {
        const raw = await response.text().catch(() => '');
        extracted = extractTextFromSse(raw);
      } else {
        const raw = await response.text().catch(() => '');
        if (raw) {
          const parsed = safeJsonParse(raw);
          extracted = parsed ? extractAnswerFromPayload(parsed) : raw.trim();
        }
      }
      if (extracted) {
        recordNetworkAnswer(extracted, meta);
      }
    } catch (err) {
      console.warn('[content-qwen] Failed to capture Qwen API response', err);
    }
  }

  function extractTextFromSse(raw) {
    if (!raw) return '';
    const lines = raw.split('\n');
    let aggregated = '';
    let bestCandidate = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      const parsed = safeJsonParse(data);
      if (parsed) {
        const extracted = extractAnswerFromPayload(parsed);
        if (extracted && extracted.length >= bestCandidate.length) {
          bestCandidate = extracted;
        }
        const choices = parsed.choices || parsed.data?.choices;
        const choiceArray = Array.isArray(choices) ? choices : choices ? [choices] : [];
        choiceArray.forEach((choice) => {
          const deltaText = coerceText(choice?.delta?.content);
          if (deltaText) aggregated += deltaText;
        });
      } else {
        aggregated += data;
      }
    }

    const candidate = bestCandidate || aggregated;
    return normalizeAnswerText(candidate);
  }

  function recordNetworkAnswer(text, meta = {}) {
    if (!text) return;
    const normalized = normalizeAnswerText(text);
    if (!normalized) return;

    if (meta.promptSnippet) {
      const snippet = meta.promptSnippet.trim();
      if (snippet && normalized.length <= snippet.length + 5 && normalized.startsWith(snippet)) {
        return;
      }
    }

    if (meta.promptFingerprint) {
      const answerFingerprint = computePromptFingerprint(normalized);
      if (answerFingerprint && answerFingerprint === meta.promptFingerprint && normalized.length <= 30) {
        return;
      }
    }

    const lastEntry = networkAnswerBuffer[networkAnswerBuffer.length - 1];
    if (lastEntry && lastEntry.text === normalized) {
      lastEntry.timestamp = Date.now();
      if (!lastEntry.promptFingerprint) {
        lastEntry.promptFingerprint = meta?.promptFingerprint || null;
      }
      return;
    }

    networkAnswerBuffer.push({
      text: normalized,
      timestamp: Date.now(),
      promptFingerprint: meta?.promptFingerprint || null
    });

    if (networkAnswerBuffer.length > NETWORK_BUFFER_LIMIT) {
      networkAnswerBuffer.splice(0, networkAnswerBuffer.length - NETWORK_BUFFER_LIMIT);
    }
    console.log(`[content-qwen] Captured response via network (${normalized.length} chars)`);
  }

  function findNetworkAnswer(notBefore, expectedFingerprint) {
    const now = Date.now();
    for (let i = networkAnswerBuffer.length - 1; i >= 0; i--) {
      const entry = networkAnswerBuffer[i];
      if (entry.timestamp < notBefore) {
        if (now - entry.timestamp > 5 * 60 * 1000) {
          networkAnswerBuffer.splice(i, 1);
        }
        continue;
      }
      if (expectedFingerprint && entry.promptFingerprint && entry.promptFingerprint !== expectedFingerprint) {
        continue;
      }
      networkAnswerBuffer.splice(i, 1);
      return entry.text;
    }

    const staleThreshold = now - 5 * 60 * 1000;
    for (let i = networkAnswerBuffer.length - 1; i >= 0; i--) {
      if (networkAnswerBuffer[i].timestamp < staleThreshold) {
        networkAnswerBuffer.splice(i, 1);
      }
    }
    return null;
  }

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
  const qwenScrollCoordinator = window.ScrollCoordinator
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
      () => (typeof qwenScrollCoordinator !== 'undefined' ? qwenScrollCoordinator : null),
      () => (typeof leChatScrollCoordinator !== 'undefined' ? leChatScrollCoordinator : null),
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
    constructor() {
      this.rules = this._initRules();
      this.stats = { elementsRemoved: 0, charactersRemoved: 0, rulesApplied: 0 };
    }
    _initRules() {
      return {
        uiPhrases: [
          /\b(Send|Menu|Settings|New chat|Clear|Like|Reply|Copy|Share|Follow|Subscribe)\b/gi,
          /\b(Upload|Download|Save|Delete|Edit|Search|Filter|Sort)\b/gi,
          /\b(Qwen|Alibaba|Chat|AI Assistant)\b/gi
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
          console.warn('[ContentCleaner] DOMParser failed in Qwen cleaner, falling back to text extraction', err);
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

  // -------------------- ПЕРЕНОСНЫЕ ФУНКЦИИ ИЗ РАБОЧЕЙ ВЕРСИИ --------------------
  
  const sanitizeValue = (value) => String(value ?? '').replace(/\u200b/g, '');

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

  function emitValueChange(input, text, inputType = 'insertFromPaste') {
    const normalized = sanitizeValue(text);
    if (!normalized && !input) return;
    try {
      input.focus({ preventScroll: true });
    } catch (_) {
      input?.focus?.();
    }
    try {
      const beforeEvt = new InputEvent('beforeinput', {
        data: normalized,
        inputType: 'insertReplacementText',
        bubbles: true,
        cancelable: true
      });
      input.dispatchEvent(beforeEvt);
    } catch (_) {}
    if ('value' in input) {
      applyNativeValue(input, normalized);
      try {
        input.selectionStart = input.selectionEnd = input.value.length;
      } catch (_) {}
    } else {
      input.textContent = normalized;
    }
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: normalized, inputType }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return normalized;
  }

  function resolveWritableInput(base) {
    if (!base) return null;
    const isEditable = (
      base.tagName === 'TEXTAREA' ||
      base.tagName === 'INPUT' ||
      base.isContentEditable ||
      base.getAttribute?.('contenteditable') === 'true' ||
      base.getAttribute?.('role') === 'textbox'
    );
    if (isEditable) return base;

    const selectors = 'textarea, input[type="text"], div[contenteditable="true"], [role="textbox"], textarea.ant-input, textarea.ant-input-lg';
    const nested = base.querySelector?.(selectors);
    if (nested) return nested;

    if (base.shadowRoot) {
      const shadowCandidate = base.shadowRoot.querySelector(selectors);
      if (shadowCandidate) return shadowCandidate;
    }
    return base;
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

  // Композер (ввод текста) - проверенные селекторы Qwen
  function getComposer() {
    const candidates = [
      'textarea[placeholder*="Ask me anything"]',
      'textarea[placeholder*="ask"]',
      'textarea',
      'div[contenteditable="true"]',
      'div[role="textbox"]'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (isElementInteractable(el)) return resolveWritableInput(el);
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
      if (isElementInteractable(node)) return resolveWritableInput(node);
      node = node.parentElement;
      steps++;
    }
    return null;
  }

  function getActiveComposerCandidate() {
    const active = document.activeElement;
    if (!active) return null;
    if (isElementInteractable(active)) return resolveWritableInput(active);
    if (active.shadowRoot) {
      const nested = active.shadowRoot.querySelector('textarea, div[contenteditable="true"], [role="textbox"]');
      if (nested) return resolveWritableInput(nested);
    }
    return null;
  }

  function discoverComposer() {
    const strategies = [
      { label: 'activeElement', resolver: getActiveComposerCandidate },
      { label: 'selection', resolver: getComposerFromSelection },
      { label: 'defaultSelector', resolver: getComposer }
    ];
    for (const strategy of strategies) {
      const node = strategy.resolver();
      if (node && isElementInteractable(node)) {
        emitDiagnostic({
          type: 'SELECTOR',
          label: `Composer via ${strategy.label}`,
          details: describeNode(node),
          level: 'info'
        });
        return node;
      }
    }
    emitDiagnostic({
      type: 'SELECTOR',
      label: 'Composer discovery failed',
      details: `active=${describeNode(document.activeElement)} path=${traceNodePath(document.activeElement)}`,
      level: 'error'
    });
    return null;
  }

  function readComposerValue(input) {
    if (!input) return '';
    const raw = (input.value ?? input.innerText ?? input.textContent ?? '').replace(/\u200b/g, '');
    return raw.trim();
  }

  async function waitForComposerValue(input, { retries = 6, delay = 220 } = {}) {
    for (let i = 0; i < retries; i++) {
      const current = readComposerValue(input);
      if (current.length > 0) return current;
      await sleep(delay);
    }
    return readComposerValue(input);
  }

  function normalizeForComparison(text = '') {
    return String(text)
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function forceComposerValue(input, prompt) {
    if (!input) return '';
    const normalized = String(prompt ?? '').replace(/\u200b/g, '');
    const isEditable = input.isContentEditable || input.getAttribute?.('contenteditable') === 'true';
    try {
      input.focus({ preventScroll: true });
    } catch (_) {
      input.focus?.();
    }
    if (isEditable) {
      const range = document.createRange();
      range.selectNodeContents(input);
      range.deleteContents();
      range.insertNode(document.createTextNode(normalized));
      const selection = window.getSelection?.();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } else if ('value' in input) {
      applyNativeValue(input, normalized);
      try {
        input.selectionStart = input.selectionEnd = input.value.length;
      } catch (_) {}
    } else {
      input.textContent = normalized;
    }
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: normalized, inputType: 'insertFromPaste' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return readComposerValue(input);
  }

  // Ввод промпта - рабочая версия
  async function typePrompt(input, prompt) {
    const forcedValue = forceComposerValue(input, prompt);
    await sleep(120);
    const forcedHead = normalizeForComparison(prompt).slice(0, 120);
    if (forcedHead && normalizeForComparison(forcedValue).includes(forcedHead)) {
      return;
    }
    await qwenHumanType(input, prompt, { wpm: 130 });
    await sleep(250);
    if (!readComposerValue(input)) {
      console.warn('[content-qwen] Primary type failed, falling back to execCommand');
      await fallbackQwenType(input, prompt);
      await sleep(200);
    }
    let currentValue = readComposerValue(input);
    if (!currentValue) {
      currentValue = forceComposerValue(input, prompt);
    } else {
      if ('value' in input) {
        applyNativeValue(input, prompt);
      } else {
        input.textContent = prompt;
      }
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(prompt || ''), inputType: 'insertFromPaste' }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      currentValue = readComposerValue(input);
    }
    const normalizedHead = normalizeForComparison(prompt).slice(0, 120);
    if (normalizedHead && !normalizeForComparison(currentValue).includes(normalizedHead)) {
      console.warn('[content-qwen] Composer text mismatch, forcing value');
      emitDiagnostic({
        type: 'INPUT',
        label: 'Composer mismatch',
        details: `value="${currentValue.slice(0, 80)}" node=${describeNode(input)} path=${traceNodePath(input)}`,
        level: 'warning'
      });
      forceComposerValue(input, prompt);
    }
  }

  async function resolveSendButton(referenceInput) {
    if (window.SelectorFinder?.findOrDetectSelector) {
      try {
        const result = await window.SelectorFinder.findOrDetectSelector({
          modelName: MODEL,
          elementType: 'sendButton',
          timeout: 12000,
          referenceElement: referenceInput || null
        });
        if (result?.element && isElementInteractable(result.element)) {
          return result.element;
        }
      } catch (err) {
        console.warn('[content-qwen] SelectorFinder send button resolution failed', err);
      }
    }

    const scope = referenceInput?.closest?.('form') || referenceInput?.parentElement || document;
    const selectorList = [
      'button.ant-btn-primary:not([disabled])',
      'button:has(svg.icon-send):not([disabled])',
      'button[type="submit"]:not([disabled])',
      'button[aria-label*="Send" i]:not([disabled])',
      'button[aria-label*="发送" i]:not([disabled])',
      'form button[type="submit"]:not([disabled])'
    ];
    for (const sel of selectorList) {
      try {
        const btn = scope.querySelector(sel);
        if (btn && isElementInteractable(btn)) return btn;
      } catch (_) {}
    }
    return null;
  }

  // Отправка промпта - проверенные селекторы Qwen
  async function sendComposer(input) {
    const dispatchEnter = (mods = {}) => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, ctrlKey: !!mods.ctrlKey }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, ctrlKey: !!mods.ctrlKey }));
    };

    const confirmQwenSend = async (sendBtn, timeout = 2000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const typing = document.querySelector('[aria-busy="true"], .loading, .spinner, [data-streaming="true"]');
        if (typing) return true;
        if (sendBtn && (sendBtn.disabled || sendBtn.getAttribute?.('aria-disabled') === 'true')) return true;
        const current = readComposerValue(input);
        if (!current.length) return true;
        await sleep(120);
      }
      return false;
    };

    let sendBtn = null;

    await sleep(2000);

    // Strategy 1: Ctrl+Enter
    dispatchEnter({ ctrlKey: true });
    let confirmed = await confirmQwenSend(null);
    if (!confirmed) {
      sendBtn = await resolveSendButton(input);
      if (sendBtn && !sendBtn.disabled) {
        await qwenHumanClick(sendBtn);
        console.log('[content-qwen] Send button clicked');
        confirmed = await confirmQwenSend(sendBtn);
      }
    }
    if (!confirmed) {
      dispatchEnter();
      await confirmQwenSend(sendBtn);
    }
  }

  // Извлечение контейнеров сообщений - адаптированная логика
  function getMessageContainers() {
    const selectors = [
      '.message',
      '[class*="message"]',
      '[data-message-type]',
      '[data-role*="message"]',
      '[data-testid*="message"]',
      'article',
      '.chat-message',
      '[role="article"]',
      'section[class*="message"]',
      'li[class*="message"]',
      'div[class*="chat-item"]',
      'div[class*="conversation-turn"]'
    ];
    const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
    const seen = new Set();
    const result = [];
    nodes.forEach((node) => {
      if (!node) return;
      const container = node.closest('[data-message-type], [data-role*="message"], article, li, section, [class*="message"]') || node;
      if (seen.has(container)) return;
      if (((container.innerText || '').trim().length > 0)) {
        seen.add(container);
        result.push(container);
      }
    });
    return result;
  }

  function getAssistantMessages() {
    const selectors = [
      '[data-message-type="assistant"]',
      '[data-role*="assistant"]',
      '[data-author*="assistant"]',
      '[data-speaker="ai"]',
      '[data-speaker*="assistant"]',
      '[data-testid*="assistant"]',
      '[data-testid*="bot"]',
      '[data-type="assistant"]',
      'article[data-role*="assistant"]',
      'section[data-role*="assistant"]',
      '.message div[class*="assistant"]',
      'div[class*="assistant-message"]',
      'div[class*="assistantMessage"]',
      'div[class*="bot-message"]',
      'div[class*="botMessage"]',
      '[class*="ai-message"]',
      '[class*="aiMessage"]',
      '[class*="response"]',
      '.prose',
      'div[class*="markdown"]',
      'div[class*="answer-content"]'
    ];
    const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
    const seen = new Set();
    const result = [];
    nodes.forEach((node) => {
      if (!node) return;
      const container = node.closest(
        '[data-message-type="assistant"], [data-role*="assistant"], [data-type="assistant"], article, li, section, [class*="message"]'
      ) || node;
      if (seen.has(container)) return;
      if (((container.innerText || '').trim().length > 0)) {
        seen.add(container);
        result.push(container);
      }
    });
    return result;
  }

  function extractMessageText(element) {
    if (!element) return '';
    
    // Пробуем найти prose контейнер (как в Grok)
    const proseNode = element.querySelector('.prose, [class*="prose"]');
    if (proseNode) {
      return (proseNode.innerText || proseNode.textContent || '').trim();
    }
    
    // Пробуем найти текстовые контейнеры
    const textContainers = element.querySelectorAll('div[lang], div[dir="auto"], p, span, li, pre, code, blockquote');
    let buf = '';
    textContainers.forEach((n) => {
      const t = (n.innerText || '').trim();
      if (t && t.length > 10) {
        if (buf) buf += '\n';
        buf += t;
      }
    });
    
    if (!buf) buf = (element.innerText || element.textContent || '').trim();
    return normalizeAnswerText(buf);
  }

  // Ожидание ответа - гибридная логика (Grok + Qwen)
  async function waitForQwenReply(prompt, timeout = 150000, options = {}) {
    const start = Date.now();
    const notBefore = start - 2000;
    const expectedFingerprint = computePromptFingerprint(prompt || '');
    const baselineCount = Number.isFinite(options.baselineCount)
      ? options.baselineCount
      : getAssistantMessages().length;
    const baselineText = normalizeAnswerText(options.baselineText || '');
    const initialAssistantCount = baselineCount;

    const resolveNetwork = () => findNetworkAnswer(notBefore, expectedFingerprint);

    const observeAssistantMessages = () => {
      const messages = getAssistantMessages();
      if (messages.length <= initialAssistantCount) return null;
      const last = messages[messages.length - 1];
      const txt = extractMessageText(last);
      if (baselineText && normalizeAnswerText(txt) === baselineText) return null;
      return txt && txt.length > 10 ? txt : null;
    };

    const observeFallbackMessages = () => {
      const containers = getMessageContainers();
      if (!containers.length) return null;
      const last = containers[containers.length - 1];
      const txt = extractMessageText(last);
      if (baselineText && normalizeAnswerText(txt) === baselineText) return null;
      if (!txt || txt.length < 10) return null;
      const prefix = (prompt || '').slice(0, Math.min(40, prompt.length)).trim();
      return prefix && txt.startsWith(prefix) ? null : txt;
    };

    const immediateNetwork = resolveNetwork();
    if (immediateNetwork) {
      console.log('[content-qwen] Response captured via network (pre-loop)');
      return immediateNetwork;
    }

    return new Promise((resolve, reject) => {
      let lastSeen = '';
      let stableTicks = 0;
      let fallbackMode = false;
      let settled = false;
      let stopObserve = null;
      let observer = null;

      const cleanup = (value, isTimeout = false) => {
        if (settled) return;
        settled = true;
        if (stopObserve) {
          try { stopObserve(); } catch (_) {}
        }
        if (observer) observer.disconnect();
        clearInterval(intervalId);
        clearTimeout(timerId);
        if (value) {
          resolve(value);
        } else {
          const finalNetwork = resolveNetwork();
          if (finalNetwork) {
            console.warn('[content-qwen] Timeout reached, returning network response.');
            resolve(finalNetwork);
          } else if (isTimeout && lastSeen) {
            console.warn('[content-qwen] Timeout reached, returning last DOM response.');
            resolve(lastSeen);
          } else {
            reject(new Error('Timeout: No response received from Qwen'));
          }
        }
      };

      const evaluate = () => {
        const networkCandidate = resolveNetwork();
        if (networkCandidate) {
          console.log('[content-qwen] Response captured via network (observer loop)');
          cleanup(networkCandidate);
          return;
        }

        if (!fallbackMode && Date.now() - start > 10000) {
          fallbackMode = true;
        }

        let candidate = observeAssistantMessages();
        if (!candidate && fallbackMode) {
          candidate = observeFallbackMessages();
        }
        if (!candidate) return;
        if (candidate === lastSeen) {
          stableTicks += 1;
          if (stableTicks >= 2) {
            console.log('[content-qwen] Response stabilized.');
            cleanup(candidate);
          }
        } else {
          lastSeen = candidate;
          stableTicks = 0;
        }
      };

      if (window.ContentUtils?.observeMutations) {
        stopObserve = window.ContentUtils.observeMutations(
          document.body,
          { childList: true, subtree: true, characterData: true },
          () => evaluate()
        );
      } else {
        observer = cleanupScope.trackObserver(new MutationObserver(() => evaluate()));
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      }
      const intervalId = cleanupScope.trackInterval(setInterval(() => evaluate(), 700));
      const timerId = cleanupScope.trackTimeout(setTimeout(() => cleanup(null, true), timeout));
      evaluate();
    });
  }

  async function refineQwenShortAnswer(cleaned, prompt, baselineCount, baselineText) {
    const trimmed = String(cleaned || '').trim();
    if (trimmed.length >= MIN_QWEN_ANSWER_LEN) {
      return { text: trimmed, fromFallback: false };
    }
    try {
      const fallback = await waitForQwenReply(prompt, SHORT_QWEN_FALLBACK_TIMEOUT_MS, {
        baselineCount,
        baselineText
      });
      if (fallback && fallback.length > trimmed.length) {
        return { text: fallback, fromFallback: true };
      }
    } catch (err) {
      console.warn('[content-qwen] Short answer fallback failed', err);
    }
    return { text: trimmed, fromFallback: false };
  }

  // -------------------- Отправка результата в бэкграунд --------------------
  function sendResult(resp, ok = true, context = { isEvaluator: false }, error = null) {
    const { text, html } = normalizeResponsePayload(resp, lastResponseHtml);
    if (ok && !context.isEvaluator) {
      const stats = contentCleaner.getStats();
      chrome.runtime.sendMessage({
        type: 'CONTENT_CLEANING_STATS',
        llmName: MODEL,
        stats,
        timestamp: Date.now()
      });
    }
    
    const message = {
      type: context.isEvaluator ? 'EVALUATOR_RESPONSE' : 'LLM_RESPONSE',
      answer: ok ? text : `Ошибка: ${text}`
    };
    if (context?.meta && typeof context.meta === 'object') {
      message.meta = context.meta;
    }

    if (!context.isEvaluator) {
      message.llmName = MODEL;
      if (ok && html) {
        message.answerHtml = html;
      }
      if (!ok) {
        message.error = {
          type: error?.type || 'generic_error',
          message: text
        };
      }
    }

    chrome.runtime.sendMessage(message);
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
      console.warn('[content-qwen] Failed to parse data URL', err);
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
          console.warn('[content-qwen] Failed to hydrate attachment', item?.name, err);
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

  const ensureMainWorldBridge = async () => {
    if (window.ContentUtils?.ensureMainWorldBridge) {
      try {
        return await window.ContentUtils.ensureMainWorldBridge();
      } catch (_) {
        return false;
      }
    }
    return false;
  };

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
            'div[contenteditable="true"]',
            'textarea',
            '[role="textbox"]',
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
        console.warn('[content-qwen] drop dispatch failed', err);
        return false;
      }
    };

    const dropTargets = [
      target,
      target?.parentElement,
      document.querySelector('main'),
      document.querySelector('form'),
      document.body,
      document.documentElement
    ].filter(Boolean);
    for (const el of dropTargets) {
      if (await dispatchDropSequence(el)) return true;
    }

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
      console.warn('[content-qwen] File input not found, skipping attachments');
      return false;
    }

    const dt = makeDataTransfer();
    try { fileInput.files = dt.files; } catch (err) { console.warn('[content-qwen] set files failed', err); }
    try {
      fileInput.dispatchEvent(new Event('input', { bubbles: true }));
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (err) {
      console.warn('[content-qwen] input/change dispatch failed', err);
    }
    try { fileInput.focus?.({ preventScroll: true }); } catch (_) { try { fileInput.focus?.(); } catch (_) {} }
    await sleep(1800);
    return true;
  }

  // -------------------- Публичная операция: inject → wait → extract → clean → send --------------------
  async function injectAndGetResponse(prompt, context = { isEvaluator: false }) {
    const dispatchMeta = context?.meta && typeof context.meta === 'object' ? context.meta : null;
    return runLifecycle('qwen:inject', buildLifecycleContext(prompt, { evaluator: context.isEvaluator }), async (activity) => {
      const opId = metricsCollector.startOperation('injectAndGetResponse');
      const startTime = Date.now();
      try {
        await sleep(1000);
          activity.heartbeat(0.15, { phase: 'composer-search' });

          // Находим поле ввода (проверенные селекторы Qwen)
          let composer = discoverComposer();
          if (!composer) {
            composer = await findAndCacheElement('qwen_composer', [
              'textarea[placeholder*="Ask me anything"]',
              'textarea[placeholder*="ask"]',
              'textarea',
              'div[contenteditable="true"]',
              'div[role="textbox"]'
            ]).catch(err => { 
              throw { type: 'selector_not_found', message: 'Qwen input field not found' }; 
            });
            composer = resolveWritableInput(composer);
            if (composer) {
              emitDiagnostic({
                type: 'SELECTOR',
                label: 'Composer via cache/fallback',
                details: describeNode(composer),
                level: 'info'
              });
            }
          }
          if (!composer) {
            throw { type: 'selector_not_found', message: 'Qwen input field not writable' };
          }
          activity.heartbeat(0.3, { phase: 'composer-ready' });

          try { await attachFilesToComposer(composer, context.attachments || []); } catch (err) { console.warn('[content-qwen] attach failed', err); }

          await typePrompt(composer, prompt);
          let validationText = await waitForComposerValue(composer, { retries: 7, delay: 250 });
          const normalizedPromptHead = normalizeForComparison(prompt).slice(0, 120);
          let normalizedValue = normalizeForComparison(validationText);
          if (!normalizedValue.length || (normalizedPromptHead && !normalizedValue.includes(normalizedPromptHead))) {
            validationText = forceComposerValue(composer, prompt);
            normalizedValue = normalizeForComparison(validationText);
          }
          if (!normalizedValue.length || (normalizedPromptHead && !normalizedValue.includes(normalizedPromptHead))) {
            throw { type: 'injection_failed', message: 'Input did not accept value (React guard).' };
          }
          activity.heartbeat(0.4, { phase: 'typing' });
          const assistantMessages = getAssistantMessages();
          const baselineAssistantCount = assistantMessages.length;
          const baselineAssistantText = assistantMessages.length
            ? extractMessageText(assistantMessages[assistantMessages.length - 1])
            : '';

          await sendComposer(composer);
          activity.heartbeat(0.5, { phase: 'send-dispatched' });
          try { chrome.runtime.sendMessage({ type: 'PROMPT_SUBMITTED', llmName: MODEL, ts: Date.now(), meta: dispatchMeta }); } catch (_) {}
          activity.heartbeat(0.6, { phase: 'waiting-response' });

          const responsePayload = await withSmartScroll(async () => {
            let pipelineAnswer = null;
            await tryQwenPipeline(prompt, {
              heartbeat: (meta = {}) => activity.heartbeat(0.8, Object.assign({ phase: 'pipeline' }, meta)),
            stop: async ({ answer, answerHtml }) => {
                let cleaned = contentCleaner.clean(answer, { maxLength: 50000 });
                let html = String(answerHtml || '').trim();
                if (html) lastResponseHtml = html;
                const refined = await refineQwenShortAnswer(
                  cleaned,
                  prompt,
                  baselineAssistantCount,
                  baselineAssistantText
                );
                cleaned = refined.text;
                if (refined.fromFallback) {
                  html = '';
                }
                if (!String(cleaned || '').trim()) {
                  throw new Error('Empty answer extracted');
                }
                pipelineAnswer = { text: cleaned, html };
                metricsCollector.recordTiming('total_response_time', Date.now() - startTime);
                metricsCollector.endOperation(opId, true, { 
                  responseLength: cleaned.length,
                  duration: Date.now() - startTime,
                  source: 'pipeline'
                });
                sendResult({ text: cleaned, html }, true, context);
                activity.stop({ status: 'success', answerLength: cleaned.length, source: 'pipeline' });
                return pipelineAnswer;
              }
            });
            if (pipelineAnswer) {
              return pipelineAnswer;
            }

            lastResponseHtml = '';
            const rawText = await waitForQwenReply(prompt, 150000, {
              baselineCount: baselineAssistantCount,
              baselineText: baselineAssistantText
            });

            const cleaned = contentCleaner.clean(rawText, { maxLength: 50000 });
            
            metricsCollector.recordTiming('total_response_time', Date.now() - startTime);
            metricsCollector.endOperation(opId, true, { 
              responseLength: cleaned.length,
              duration: Date.now() - startTime
            });
            sendResult({ text: cleaned, html: lastResponseHtml }, true, context);
            activity.heartbeat(0.9, { phase: 'response-processed' });
            activity.stop({ status: 'success', answerLength: cleaned.length });
            return { text: cleaned, html: lastResponseHtml };
          }, { keepAliveInterval: 2000, operationTimeout: 300000, debug: false });
          return responsePayload;
      } catch (e) {
        if (e?.code === 'background-force-stop') {
          activity.error(e, false);
          throw e;
        }
        console.error('[content-qwen] injectAndGetResponse error:', e);
        metricsCollector.recordError(e, 'injectAndGetResponse', opId);
        metricsCollector.endOperation(opId, false, { error: e?.message });
        const errorMessage = e?.message || String(e);
        sendResult(errorMessage, false, context, e);
        activity.error(e, true);
        throw e;
      }
    });
  }

  let currentRequestContext = { isEvaluator: false };

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
        keepAliveMutex.run(async () => {
          runAntiSleepPulse(msg.intensity || 'soft');
        });
        return false;
      }

      if (msg?.type === 'GET_ANSWER' || msg?.type === 'GET_FINAL_ANSWER') {
        currentRequestContext = { isEvaluator: Boolean(msg.isEvaluator), attachments: msg.attachments || [], meta: msg.meta || null };
        injectAndGetResponse(msg.prompt, currentRequestContext)
          .then(() => {
            if (msg.isFireAndForget) {
              console.log('[content-qwen] Fire-and-forget request processed. Not sending response back.');
              sendResponse?.({ status: 'success_fire_and_forget' });
              return;
            }
            sendResponse?.({ status: 'success' });
          })
          .catch((err) => {
            if (err?.code === 'background-force-stop') {
              sendResponse?.({ status: 'force_stopped' });
              return;
            }
            const errorMessage = err?.message || String(err) || 'Unknown error in content-qwen';
            sendResponse?.({ status: 'error', message: errorMessage });
          });
        return true;
      }

      if (msg.action === 'injectPrompt' || msg.action === 'sendPrompt' || msg.action === 'REQUEST_LLM_RESPONSE') {
        const prompt = msg.prompt || '';
        injectAndGetResponse(prompt);
      } else if (msg.action === 'getResponses') {
        const source = msg?.meta?.source || 'manual';
        const pingId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        emitDiagnostic({ type: 'PING', label: 'Повторное извлечение ответа', details: `source: ${source}`, level: 'info', meta: { pingId } });
        sendResponse?.({ status: 'manual_refresh_started', pingId });

        (async () => {
          try {
            await withSmartScroll(async () => {
              const rawText = await waitForQwenReply('', 120000);
              const cleaned = contentCleaner.clean(rawText);
              if (cleaned && cleaned !== lastResponseCache) {
                lastResponseCache = cleaned;
                lastResponseHtml = '';
                sendResult({ text: cleaned, html: lastResponseHtml }, true);
                emitDiagnostic({ type: 'PING', label: 'Ответ обновлен после ping', level: 'success', meta: { pingId } });
                chrome.runtime.sendMessage({ type: 'MANUAL_PING_RESULT', llmName: MODEL, status: 'success', pingId });
              } else {
                emitDiagnostic({ type: 'PING', label: 'Ответ не изменился после ping', level: 'info', meta: { pingId } });
                chrome.runtime.sendMessage({ type: 'MANUAL_PING_RESULT', llmName: MODEL, status: 'unchanged', pingId });
              }
            }, { keepAliveInterval: 2000, operationTimeout: 120000, debug: false });
          } catch (err) {
            if (err?.code === 'background-force-stop') {
              chrome.runtime.sendMessage({ type: 'MANUAL_PING_RESULT', llmName: MODEL, status: 'aborted', pingId });
              return;
            }
            console.error('[content-qwen] Manual getResponses failed', err);
            emitDiagnostic({ type: 'PING', label: 'Повторное извлечение не удалось', details: err?.message || 'unknown error', level: 'error', meta: { pingId } });
            chrome.runtime.sendMessage({ type: 'MANUAL_PING_RESULT', llmName: MODEL, status: 'failed', error: err?.message || 'unknown error', pingId });
          }
        })();
        return true;
      }
    } catch (e) {
      console.error('[content-qwen] onMessage error:', e);
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
  window.__qwenAllCopyV6 = {
    injectAndGetResponse,
    contentCleaner
  };

  console.log('[content-qwen] AllCopy v6 ready.');
})();
// ============================== IIFE END ==============================
