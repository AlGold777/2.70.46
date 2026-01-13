// content-lechat.js – AllCopy v6 "Adaptive Resilient Hybrid"
// Структурная основа: как в content-grok (дубликат-guard, IIFE, self-healing, cleaner, 429).
// Адаптация: селекторы и специфика UI LeChat (chat.mistral.ai/chat).

// ============================== IIFE START ==============================
//-- 2.1. Улучшенная защита от дублирования с версионированием --//
(function () {
  const SCRIPT_VERSION = 'v6.1.1'; // Bumped version for fix
  const SCRIPT_NAME = 'content-lechat';
  
  // Проверка на дубликат
  if (window.leChatContentScriptLoaded) {
    console.warn(`[${SCRIPT_NAME}] Already loaded (v${window.__SCRIPT_VERSION}), aborting`);
    throw new Error('Duplicate script load prevented');
  }
  
  // Установка флагов
  window.leChatContentScriptLoaded = true;
  window.__SCRIPT_VERSION = SCRIPT_VERSION;
  window.__SCRIPT_NAME = SCRIPT_NAME;
  
  console.log(`[${SCRIPT_NAME}] Version ${SCRIPT_VERSION} initializing...`);

  const MODEL = 'Le Chat';

  // -------------------- HTTP 429 Interceptor with Retry --------------------
  if (!window.originalFetchInterceptor_lechat) {
    window.originalFetchInterceptor_lechat = true;
    const originalFetch = window.fetch;
    const retryQueue = new Map();
    window.fetch = async (...args) => {
      const [url] = args;
      const urlKey = typeof url === 'string' ? url : url?.url || 'unknown';
      
      let response = await originalFetch(...args);
      
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000;
        const attempts = retryQueue.get(urlKey) || 0;
        const maxRetries = 3;
        
        if (attempts < maxRetries) {
          
          // --- FIX 1: Handle Request cloning for retries (L31 Issue) ---
          const retryArgs = [...args];
          if (args[0] instanceof Request) {
             // Clone the Request instance to reset its body stream state, 
             // avoiding the 'body used already' error on POST/PUT requests.
            retryArgs[0] = args[0].clone();
          }

          console.warn(`[HTTP 429] Retry ${attempts + 1}/${maxRetries} after ${waitTime}ms for ${urlKey}`);
          retryQueue.set(urlKey, attempts + 1);
          await sleep(waitTime);
          
          response = await originalFetch(...retryArgs); // Use cloned request args
          retryQueue.delete(urlKey);

        } else {
          console.error(`[HTTP 429] Max retries exceeded for ${urlKey}`);
          chrome.runtime.sendMessage({
            type: 'LLM_RESPONSE',
            llmName: MODEL,
            answer: 'Error: Rate limit detected. Please wait.',
            error: { 
              type: 'rate_limit', 
              message: `HTTP 429 detected. Max retries (${maxRetries}) exceeded.`,
              waitTime,
              attempts: maxRetries
            }
          });
          retryQueue.delete(urlKey);
        }
      }
      return response;
    };
  }

  // -------------------- Utils --------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isElementInteractable(el) {
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
  //-- 3.2. SmartScroll с учетом глобального флага --//
  async function withSmartScroll(asyncOperation, options = {}) {
    const {
      keepAliveInterval = 2000,
      operationTimeout = 300000,
      debug = false
    } = options;

    let intervalId = null, timeoutId = null;
    const log = (...a) => debug && console.log('[SmartScroll]', ...a);

    const tick = () => {
      if (!keepAliveActive) return; // Используем глобальный флаг
      if (document.hidden) {
        try {
          window.scrollBy(0, 0);
          document.body.offsetHeight;
          log('tick');
        } catch (_) {}
      }
    };

    const timeoutPromise = new Promise((_, rej) => {
      timeoutId = setTimeout(() => rej(new Error(`Timeout ${operationTimeout}ms`)), operationTimeout);
    });

    try {
      // --- FIX 3: Reset keepAliveActive to true before starting interval (L128/L527 Issue) ---
      keepAliveActive = true; 
      intervalId = setInterval(tick, keepAliveInterval);
      keepAliveTimer = intervalId; // Сохраняем для cleanup
      const result = await Promise.race([asyncOperation(), timeoutPromise]);
      return result;
    } finally {
      keepAliveActive = false; // Disable after operation finishes
      if (intervalId) clearInterval(intervalId);
      if (timeoutId) clearTimeout(timeoutId);
      log('stopped');
    }
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
        const div = document.createElement('div');
        div.innerHTML = content;
        div.querySelectorAll('script,style,svg,canvas,noscript,header,footer,nav,aside,button,[aria-hidden="true"]').forEach(el => {
          this.stats.elementsRemoved++; 
          this.stats.charactersRemoved += (el.textContent || '').length;
          el.remove();
        });
        text = div.textContent || div.innerText || '';
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
    startOperation(name) {
      const id = `${name}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      this.metrics.operations.push({ id, name, start: Date.now(), end: null, success: null });
      return id;
    }
    endOperation(id, success = true, metadata = {}) {
      const op = this.metrics.operations.find(o => o.id === id);
      if (op) {
        op.end = Date.now();
        op.duration = op.end - op.start;
        op.success = success;
        op.metadata = metadata;
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
    recordError(error, context = '') {
      this.metrics.errors.push({
        message: error?.message || String(error),
        context,
        timestamp: Date.now(),
        type: error?.type || 'unknown'
      });
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

  setInterval(() => metricsCollector.sendReport(), 300000);

  // -------------------- ПЕРЕНОСИМЫЕ ФУНКЦИИ ИЗ РАБОЧЕЙ ВЕРСИИ --------------------
  
  // Композер (ввод текста) - рабочая версия из content-lechat
  function getComposer() {
    const candidates = [
      'div[contenteditable="true"]',
      'textarea[placeholder*="message"]',
      'div[role="textbox"][contenteditable="true"]',
      'textarea'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (isElementInteractable(el)) return el;
    }
    return null;
  }

  // Ввод промпта - рабочая версия из content-lechat (прямое присваивание)
  async function typePrompt(input, prompt) {
    input.focus();
    await sleep(300);

    if (input.tagName === 'TEXTAREA') {
      input.value = prompt;
    } else {
      // contenteditable
      input.textContent = prompt;
    }
    
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(500);
    console.log('[content-lechat] ✅ Direct assignment successful');
  }

  // Отправка промпта - рабочая версия из content-lechat
  async function sendComposer(input) {
    const enterDown = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
    const enterUp = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
    input.dispatchEvent(enterDown);
    input.dispatchEvent(enterUp);
    await sleep(120);

    const sendBtn = document.querySelector(
      [
        'button[aria-label*="Send"]:not([disabled])',
        'button:has(svg[data-icon="arrow-up"])',
        'button[type="submit"]',
        'button[aria-label="Post"]',
        'button[aria-label*="Отправить"]',
        'button:has(svg)',
        'button:has([data-icon="send"])'
      ].join(',')
    );
    if (sendBtn && !sendBtn.disabled) sendBtn.click();
  }

  // Извлечение ответа - адаптация под LeChat с логикой Grok
  function getProseNodes() {
    return Array.from(document.querySelectorAll(
      'div.prose:not(:has(div[contenteditable])), .prose, div[data-testid="lechat-response"] .prose, article .prose, [data-testid="answer"] .prose, .result, .answer'
    )).filter((n) => ((n.innerText || '').trim().length > 0));
  }

  function extractResponseText(node) {
    if (!node) return '';
    const isHtml = node.innerHTML && node.innerHTML.trim();
    if (isHtml) {
      return node.innerHTML.trim();
    }
    return (node.innerText || node.textContent || '').trim();
  }

  // Ожидание ответа - логика Grok с селекторами LeChat
  async function waitForLeChatReply(prompt, timeout = 150000) {
    const start = Date.now();
    let lastSeen = '';
    let stableTicks = 0;

    let initialProseCount = getProseNodes().length;

    while (Date.now() - start < timeout) {
      const isGenerating = document.querySelector(
        'button > div > svg[data-icon="stop"], .animate-pulse, .typing-indicator, [data-testid="generation-in-progress"], [aria-busy="true"], .loading, .loader, .dots'
      );
      
      const prose = getProseNodes();
      if (prose.length > initialProseCount) {
        const last = prose[prose.length - 1];
        const txt = extractResponseText(last);
        if (txt) {
          if (!isGenerating && txt.length > 10) {
            if (txt === lastSeen) {
              stableTicks += 1;
              if (stableTicks >= 2) {
                console.log('[content-lechat] Response stabilized.');
                return txt;
              }
            } else {
              lastSeen = txt;
              stableTicks = 0;
            }
          } else {
            lastSeen = txt;
            stableTicks = 0;
          }
        }
      }
      await sleep(600);

      // Fallback: если нет prose, ищем в message containers
      if ((Date.now() - start) > 10000 && prose.length === initialProseCount) {
        const messages = Array.from(document.querySelectorAll('div[class*="message"], article, div[role="article"]'));
        if (messages.length > 0) {
          const lastMsg = messages[messages.length - 1];
          const txt = extractResponseText(lastMsg);
          if (txt && txt.length > 10) {
            const prefix = prompt.slice(0, Math.min(40, prompt.length)).trim();
            const looksLikeUserEcho = prefix && txt.startsWith(prefix);
            if (!looksLikeUserEcho) {
              if (txt === lastSeen) {
                stableTicks += 1;
                if (stableTicks >= 2) return txt;
              } else {
                lastSeen = txt;
                stableTicks = 0;
              }
            }
          }
        }
        await sleep(700);
      }
    }
    
    if (lastSeen) {
      console.warn('[content-lechat] Timeout reached, returning last captured text.');
      return lastSeen;
    }
    
    throw new Error('Тайм-аут Le Chat');
  }

  // -------------------- Отправка результата в бекграунд --------------------
  // NOTE: sendResult is removed/deprecated to avoid duplicate messages (Issue 2).
  // All messaging is now handled by the chrome.runtime.onMessage listener.

  // -------------------- Публичная операция: inject → wait → extract → clean → send --------------------
  async function injectAndGetResponse(prompt) {
    const opId = metricsCollector.startOperation('injectAndGetResponse');
    const startTime = Date.now();
    try {
      const cleaned = await withSmartScroll(async () => {
        await sleep(3000);

        let composer = getComposer();
        if (!composer) {
          composer = await findAndCacheElement('lechat_composer', [
            'div[contenteditable="true"]',
            'textarea[placeholder*="message"]',
            'div[role="textbox"][contenteditable="true"]',
            'textarea'
          ]).catch(err => { 
            throw { type: 'selector_not_found', message: 'Le Chat input field not found' }; 
          });
        }

        await typePrompt(composer, prompt);
        
        await sleep(100);
        const validationText = (composer.value ?? composer.textContent ?? '').trim();
        if (!validationText.length) {
          throw { type: 'injection_failed', message: 'Input did not accept value (React guard).' };
        }
        
        await sendComposer(composer);

        const rawText = await waitForLeChatReply(prompt, 150000);

        return contentCleaner.clean(rawText, { maxLength: 50000 });
      }, { keepAliveInterval: 2000, operationTimeout: 300000, debug: false });
      
      // --- FIX 2: Moved success messaging outside to the listener ---
      
      const stats = contentCleaner.getStats();
      // Send stats report separately
      chrome.runtime.sendMessage({
        type: 'CONTENT_CLEANING_STATS',
        llmName: MODEL,
        stats,
        timestamp: Date.now()
      });
      
      metricsCollector.recordTiming('total_response_time', Date.now() - startTime);
      metricsCollector.endOperation(opId, true, { 
        responseLength: cleaned.length,
        duration: Date.now() - startTime
      });
      
      // Return cleaned text for the caller (onMessage listener) to handle final LLM_RESPONSE
      return cleaned;
      
    } catch (e) {
      console.error('[content-lechat] injectAndGetResponse error:', e);
      metricsCollector.recordError(e, 'injectAndGetResponse');
      metricsCollector.endOperation(opId, false, { error: e?.message });
      // Throw error to be caught by the listener for centralized error reporting
      throw e;
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

  function cleanup() {
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
    window.leChatContentScriptLoaded = false;
    delete window.__leChatAllCopyV6;
    delete window.__SCRIPT_VERSION;
    delete window.__cleanup_lechat;
    
    console.log('[content-lechat] ✅ Cleanup complete');
  }
  
  // Экспортируем cleanup для внешнего вызова
  window.__cleanup_lechat = cleanup;
  
  // Проверка отключения расширения каждые 3 секунды
  setInterval(() => {
    if (!chrome.runtime?.id) {
      console.warn('[content-lechat] Extension disconnected, self-cleaning');
      cleanup();
    }
  }, 3000);
  // -------------------- Message bus --------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (!msg) return;
      
      if (msg?.type === 'HEALTH_CHECK_PING') {
        sendResponse({ type: 'HEALTH_CHECK_PONG', pingId: msg.pingId, llmName: MODEL });
        return true;
      }
      //-- НОВОЕ: Быстрая проверка здоровья скрипта --//
      if (msg?.type === 'HEALTH_PING') {
        sendResponse({ 
          status: 'alive', 
          llmName: MODEL,
          version: window.__SCRIPT_VERSION || 'unknown',
          timestamp: Date.now()
        });
        return true;
      }

      //-- НОВОЕ: Принудительная очистка перед переинъекцией --//
      if (msg?.type === 'FORCE_CLEANUP') {
        console.log('[content-lechat] Received FORCE_CLEANUP command');
        if (typeof cleanup === 'function') {
          cleanup();
        } else {
          // Если cleanup еще не добавлен, делаем базовую очистку
          window.leChatContentScriptLoaded = false;
          delete window.__leChatAllCopyV6;
        }
        sendResponse({ status: 'cleaned', llmName: MODEL });
        return true;
      }
      //-- 5. Улучшенный ANTI_SLEEP обработчик --//
      if (msg?.type === 'ANTI_SLEEP_PING') {
        try {
          window.scrollBy(0, 0);
          document.body.offsetHeight;
          chrome.runtime.sendMessage({ type: 'LLM_ACTIVITY_PONG' }).catch(() => {});
        } catch (_) {}
        return false;
      }

      if (msg?.type === 'GET_ANSWER' || msg?.type === 'GET_FINAL_ANSWER') {
        injectAndGetResponse(msg.prompt)
          .then((resp) => {
            // --- FIX 2: Centralized success response sending (L663 Issue) ---
            if (msg.isFireAndForget) {
              console.log('[content-lechat] Fire-and-forget request processed. Not sending response back.');
              sendResponse({ status: 'success_fire_and_forget' });
              return;
            }
            const responseType = msg.type === 'GET_ANSWER' ? 'LLM_RESPONSE' : 'FINAL_LLM_RESPONSE';

            // Stats message was moved into injectAndGetResponse on success
            
            chrome.runtime.sendMessage({ type: responseType, llmName: MODEL, answer: resp });
            sendResponse({ status: 'success' });
          })
          .catch((err) => {
            // --- FIX 2: Centralized error response sending ---
            const errorMessage = err?.message || String(err) || 'Unknown error in content-lechat';
            const responseType = msg.type === 'GET_ANSWER' ? 'LLM_RESPONSE' : 'FINAL_LLM_RESPONSE';
            
            // Note: If the error was a rate limit handled by the fetch interceptor, 
            // that interceptor already sent an LLM_RESPONSE error message (L69). 
            // We ensure we only send one error message here if the error originated 
            // from the injection/wait logic.

            if (err?.type !== 'rate_limit') {
               chrome.runtime.sendMessage({
                  type: responseType,
                  llmName: MODEL,
                  answer: `Error: ${errorMessage}`,
                  error: { type: err?.type || 'generic_error', message: errorMessage }
               });
            }
            sendResponse({ status: 'error', message: errorMessage });
          });
        return true;
      }

      if (msg.action === 'injectPrompt' || msg.action === 'sendPrompt' || msg.action === 'REQUEST_LLM_RESPONSE') {
        const prompt = msg.prompt || '';
        injectAndGetResponse(prompt); // This is fire-and-forget, response handled internally in success/error
      } else if (msg.action === 'getResponses') {
        withSmartScroll(async () => {
          const rawText = await waitForLeChatReply('', 120000);
          const cleaned = contentCleaner.clean(rawText);
          // If called via getResponses, we must send the response manually as there is no waiting listener hook
          chrome.runtime.sendMessage({
            type: 'LLM_RESPONSE',
            llmName: MODEL,
            answer: cleaned
          });
        }, { keepAliveInterval: 2000, operationTimeout: 120000, debug: false });
      }
    } catch (e) {
      console.error('[content-lechat] onMessage error:', e);
      // Fallback error reporting for structural errors within the listener itself
      chrome.runtime.sendMessage({
          type: 'LLM_RESPONSE',
          llmName: MODEL,
          answer: `Structural Error: ${e?.message || String(e)}`,
          error: { type: 'structural_listener_error', message: e?.message || String(e) }
      });
    }
  });

  // -------------------- Экспорт внутрь страницы (по необходимости) --------------------
  window.__leChatAllCopyV6 = {
    injectAndGetResponse,
    contentCleaner
  };

  console.log('[content-lechat] AllCopy v6 ready.');
})();
// ============================== IIFE END ==============================