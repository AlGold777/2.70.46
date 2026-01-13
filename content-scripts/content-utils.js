// Shared utilities for content scripts (sleep, selectors cache, visibility checks, smart scroll)
(function initContentUtils() {
  if (window.ContentUtils) return;

  const sleep = (ms) => {
    const baseMs = Number(ms) || 0;
    const speedMode = !!window.__PRAGMATIST_SPEED_MODE;
    const factor = speedMode ? 0.35 : 1;
    const minMs = speedMode ? 25 : 0;
    const finalMs = Math.max(minMs, baseMs * factor);
    return new Promise((resolve) => setTimeout(resolve, finalMs));
  };

  const isElementInteractable = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect?.();
    const style = window.getComputedStyle?.(el);
    return !!rect && !!style && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };

  const getCoordinator = () =>
    window.chatgptScrollCoordinator ||
    window.leChatScrollCoordinator ||
    window.perplexityScrollCoordinator ||
    window.geminiScrollCoordinator ||
    window.qwenScrollCoordinator ||
    window.deepseekScrollCoordinator ||
    window.grokScrollCoordinator ||
    window.scrollCoordinator;

  async function withSmartScroll(asyncOperation, options = {}) {
    await ensureScrollToolkit();
    const coordinator = options.coordinator || getCoordinator();
    if (coordinator?.run) {
      return coordinator.run(asyncOperation, options);
    }
    return asyncOperation();
  }

  const loadedScripts = new Map();
  function loadScriptOnce(path) {
    if (loadedScripts.has(path)) return loadedScripts.get(path);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL(path);
      script.onload = () => resolve(true);
      script.onerror = (err) => reject(err);
      (document.head || document.documentElement || document.body).appendChild(script);
    }).catch((err) => {
      console.warn('[ContentUtils] Failed to load script', path, err);
      return false;
    });
    loadedScripts.set(path, promise);
    return promise;
  }

  async function ensureMainWorldBridge() {
    if (window.__extMainBridgeInjected) return true;
    const loaded = await loadScriptOnce('content-scripts/content-bridge.js');
    if (loaded) window.__extMainBridgeInjected = true;
    return loaded;
  }

  async function ensureScrollToolkit() {
    if (window.__UniversalScrollToolkit) return true;
    await loadScriptOnce('scroll-toolkit.js');
    return !!window.__UniversalScrollToolkit;
  }

  async function ensureHumanoid() {
    if (window.LLMExtension?.Humanoid) return true;
    await ensureScrollToolkit();
    await loadScriptOnce('humanoid.js');
    return !!(window.LLMExtension?.Humanoid);
  }

  // Shared MutationObserver registry to reduce duplicate observers per target
  const mutationRegistry = new Map(); // target -> { observer, callbacks, options }
  function observeMutations(target, options, handler) {
    if (!target || typeof handler !== 'function') return () => {};
    const key = target;
    let entry = mutationRegistry.get(key);
    if (!entry) {
      entry = { callbacks: new Set(), observer: null, options };
      entry.observer = new MutationObserver((muts) => {
        entry.callbacks.forEach((cb) => {
          try { cb(muts); } catch (err) { console.warn('[ContentUtils] observeMutations handler failed', err); }
        });
      });
      try {
        entry.observer.observe(target, options || { childList: true, subtree: true, characterData: true });
      } catch (err) {
        console.warn('[ContentUtils] observeMutations failed to observe', err);
        return () => {};
      }
      mutationRegistry.set(key, entry);
    }
    entry.callbacks.add(handler);
    return () => {
      const current = mutationRegistry.get(key);
      if (!current) return;
      current.callbacks.delete(handler);
      if (!current.callbacks.size) {
        current.observer.disconnect();
        mutationRegistry.delete(key);
      }
    };
  }

  async function findAndCacheElement(selectorKey, selectorArray, timeout = 30000, scope = document, extras = {}) {
    // Support calling with options object as third arg
    if (typeof timeout === 'object') {
      extras = timeout;
      timeout = extras.timeout || 30000;
      scope = extras.scope || document;
    }
    const model = extras.model || window.MODEL || 'generic';
    const metricsCollector = extras.metricsCollector;
    const cacheVersion = '2025-12-11';
    const storageKey = `selector_cache_${model}_${selectorKey}_${cacheVersion}`;
    const startedAt = performance.now();
    const cachedSelector = (() => {
      try {
        const allKeys = Object.keys(window.localStorage || {}).filter((k) => k.startsWith(`selector_cache_${model}_${selectorKey}_`));
        const stale = allKeys.filter((k) => k !== storageKey);
        stale.forEach((k) => {
          try { window.localStorage.removeItem(k); } catch (_) {}
        });
        return window.localStorage?.getItem(storageKey);
      } catch (_) {
        return null;
      }
    })();
    if (cachedSelector) {
      const node = safeQuery(cachedSelector, scope);
      if (node) {
        metricsCollector?.finishOperation?.(`find_${selectorKey}`, { status: 'cache_hit', selector: cachedSelector });
        return node;
      }
    }

    const end = performance.now() + timeout;
    while (performance.now() < end) {
      for (const selector of selectorArray || []) {
        const node = safeQuery(selector, scope);
        if (node && isElementInteractable(node)) {
          try { window.localStorage?.setItem(storageKey, selector); } catch (_) {}
          metricsCollector?.finishOperation?.(`find_${selectorKey}`, { status: 'success', selector, durationMs: performance.now() - startedAt });
          return node;
        }
      }
      await sleep(100);
    }
    metricsCollector?.finishOperation?.(`find_${selectorKey}`, { status: 'timeout', durationMs: performance.now() - startedAt });
    return null;
  }

  function safeQuery(selector, scope = document) {
    try {
      return scope.querySelector(selector);
    } catch (_) {
      return null;
    }
  }

  const INLINE_STYLE_PROPERTIES = [
    'color',
    'background-color',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'text-decoration',
    'text-transform',
    'line-height',
    'letter-spacing',
    'text-align',
    'white-space',
    'margin',
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
    'padding',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'border',
    'border-top',
    'border-right',
    'border-bottom',
    'border-left',
    'border-radius',
    'list-style-type',
    'list-style-position'
  ];

  const buildInlineStyle = (element) => {
    if (!element || element.nodeType !== 1) return '';
    const computed = window.getComputedStyle?.(element);
    if (!computed) return '';
    return INLINE_STYLE_PROPERTIES.map((prop) => {
      const value = computed.getPropertyValue(prop);
      return value ? `${prop}:${value.trim()};` : '';
    }).join('');
  };

  const applyInlineStyles = (source, target) => {
    const style = buildInlineStyle(source);
    if (style) {
      target.setAttribute('style', style);
    }
  };

  const cloneElementWithInlineStyles = (element) => {
    if (!element || element.nodeType !== 1) return null;
    const clone = element.cloneNode(true);
    const sourceWalker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT, null);
    const cloneWalker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT, null);
    let sourceNode = element;
    let cloneNode = clone;
    while (sourceNode && cloneNode) {
      applyInlineStyles(sourceNode, cloneNode);
      sourceNode = sourceWalker.nextNode();
      cloneNode = cloneWalker.nextNode();
    }
    return clone;
  };

  const stripHiddenElements = (root) => {
    if (!root || root.nodeType !== 1) return;
    root.querySelectorAll('[style*="display: none"], [style*="visibility: hidden"]').forEach((node) => node.remove());
  };

  const RESPONSE_CLEANUP_SELECTORS = [
    'script',
    'style',
    'noscript',
    'svg',
    'canvas',
    'button',
    '[role="button"]',
    'header',
    'footer',
    'nav',
    'aside',
    'form'
  ].join(', ');

  const buildInlineHtml = (element, options = {}) => {
    if (!element || element.nodeType !== 1) return '';
    const includeRoot = options.includeRoot !== false;
    const clone = cloneElementWithInlineStyles(element) || element.cloneNode(true);
    try { stripHiddenElements(clone); } catch (_) {}
    try {
      clone.querySelectorAll(RESPONSE_CLEANUP_SELECTORS).forEach((node) => node.remove());
    } catch (_) {}
    return includeRoot ? (clone.outerHTML || '') : (clone.innerHTML || '');
  };

  window.ContentUtils = {
    sleep,
    isElementInteractable,
    withSmartScroll,
    findAndCacheElement,
    ensureMainWorldBridge,
    ensureScrollToolkit: ensureScrollToolkit,
    ensureHumanoid,
    observeMutations,
    cloneElementWithInlineStyles,
    buildInlineHtml
  };
})();
