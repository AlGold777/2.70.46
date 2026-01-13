// selector-manager.js
(function () {
  const globalObject = typeof window !== 'undefined' ? window : self;
  if (globalObject.SelectorFinder) {
    console.warn('[SelectorFinder] Duplicate load prevented');
    return;
  }

  const CACHE_PREFIX = 'selector_cache';
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const BASE_BACKOFF_MS = 200;
  const MAX_BACKOFF_MS = 5000;
  const DEFAULT_TIMEOUT_MS = 30000;
  const DEFAULT_ELEMENT_TYPES = ['composer', 'sendButton', 'response'];
  const MAX_FINGERPRINT_DEPTH = 3;
  const MAX_SELECTOR_ATTEMPTS = 25;

  const discoveryQueues = new Map();
  const discoveryState = new Map();
  const stats = {
    requests: 0,
    successes: 0,
    failures: 0,
    cacheHits: 0,
    cacheMisses: 0,
    autoDiscoveryRuns: 0,
    versionedHits: 0
  };

  let lastCleanupRun = 0;

  const cssEscape = (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    ? CSS.escape
    : ((value) => value.replace(/([ #;?%&,.+*~\':"!^$[\]()=>|\/@])/g, '\\$1'));

  const isLayoutlessEnvironment = (() => {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    return /\bjsdom\b/i.test(ua) || /\bnode\b/i.test(ua);
  })();

  let debugFlag = false;
  let debugStylesInjected = false;
  const debugHighlights = new Set();
  const MIN_AUTODISCOVERY_CONFIDENCE = 75;

  const isDebugEnabled = () => {
    if (typeof globalObject.LLM_DEBUG !== 'undefined') {
      return !!globalObject.LLM_DEBUG;
    }
    return debugFlag;
  };

  // v2.54.24 (2025-12-22 23:14 UTC): Verbose selector flags (Purpose: enable structured selector diagnostics).
  const readLocalFlag = (key) => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return null;
      return raw === 'true' || raw === '1';
    } catch (_) {
      return null;
    }
  };

  const resolveVerboseSelectors = () => {
    const flags = globalObject.LLMExtension?.flags || {};
    if (typeof flags.verboseSelectors === 'boolean') return flags.verboseSelectors;
    if (typeof flags.verboseLogging === 'boolean') return flags.verboseLogging;
    const localFlag = readLocalFlag('__verbose_selectors');
    return localFlag === null ? false : localFlag;
  };

  const injectDebugStyles = () => {
    if (debugStylesInjected || typeof document === 'undefined') return;
    try {
      const style = document.createElement('style');
      style.id = 'selector-finder-debug-style';
      style.textContent = `
        .selector-finder__debug-highlight {
          outline: 2px solid #ff3366 !important;
          outline-offset: 2px !important;
          transition: outline 0.2s ease-in-out;
        }
      `;
      document.head?.appendChild(style);
      debugStylesInjected = true;
    } catch (err) {
      console.warn('[SelectorFinder] Failed to inject debug styles', err);
    }
  };

  const debugTrace = (model, elementType, message, extra) => {
    if (!isDebugEnabled()) return;
    const payload = extra !== undefined ? extra : '';
    console.debug(`[SelectorFinder][debug] ${model}/${elementType}: ${message}`, payload);
  };

  const highlightElement = (element, label) => {
    if (!isDebugEnabled() || !element || !(element instanceof Element)) return;
    injectDebugStyles();
    try {
      element.classList.add('selector-finder__debug-highlight');
      if (label) {
        element.setAttribute('data-selector-finder-highlight', label);
      }
      debugHighlights.add(element);
    } catch (err) {
      console.warn('[SelectorFinder] Failed to highlight element', err);
    }
  };

  const clearDebugHighlights = () => {
    if (!debugHighlights.size) return;
    debugHighlights.forEach((el) => {
      try {
        el.classList.remove('selector-finder__debug-highlight');
        el.removeAttribute('data-selector-finder-highlight');
      } catch (_) { /* ignore */ }
    });
    debugHighlights.clear();
  };

  const primeDebugFlag = () => {
    try {
      if (chrome?.storage?.local?.get) {
        chrome.storage.local.get({ llm_debug: false }, (res) => {
          if (chrome.runtime?.lastError) return;
          debugFlag = !!res.llm_debug;
        });
        if (chrome?.storage?.onChanged?.addListener) {
          chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local' || !changes.llm_debug) return;
            debugFlag = !!changes.llm_debug.newValue;
          });
        }
      }
    } catch (err) {
      console.warn('[SelectorFinder] Debug flag prime failed', err);
    }
  };
  primeDebugFlag();

  const reportResolutionLayer = (modelName, elementType, layer) => {
    if (!layer) return;
    try {
      chrome.runtime?.sendMessage({
        type: 'METRIC_EVENT',
        event: 'selector_resolution',
        modelName,
        elementType,
        layer,
        timestamp: Date.now()
      });
    } catch (err) {
      console.warn('[SelectorFinder] Failed to report resolution layer', err);
    }
  };

  const autoDiscoveryStrategies = globalObject.SelectorManagerStrategies || {};

  /**
   * Normalizes selector configuration values into a flat array while preserving intent order.
   * @param {string[]|Object|null} value - Selector definition from config.
   * @returns {string[]} Flattened selector list.
   */
  const normalizeSelectorList = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return Array.from(value);
    if (typeof value === 'object') {
      const priorityBuckets = ['primary', 'secondary', 'tertiary', 'fallback', 'all'];
      const result = [];
      for (const key of priorityBuckets) {
        if (Array.isArray(value[key])) {
          result.push(...value[key]);
        }
      }
      for (const key of Object.keys(value)) {
        if (!priorityBuckets.includes(key) && Array.isArray(value[key])) {
          result.push(...value[key]);
        }
      }
      return result;
    }
    return [];
  };

  /**
   * Logs an informational message with SelectorFinder prefix.
   * @param {string} model - Model name.
   * @param {string} type - Element type.
   * @param {string} message - Message to log.
   * @example log('Grok', 'composer', 'Cache hit');
   */
  const log = (model, type, message) => {
    console.log(`[SelectorFinder] ${model}/${type}: ${message}`);
  };

  /**
   * Logs a warning message with SelectorFinder prefix.
   * @param {string} model - Model name.
   * @param {string} type - Element type.
   * @param {string} message - Message to log.
   * @example warn('Grok', 'composer', 'Cache miss');
   */
  const warn = (model, type, message) => {
    console.warn(`[SelectorFinder] ${model}/${type}: ${message}`);
  };

  /**
   * Logs an error message with SelectorFinder prefix.
   * @param {string} model - Model name.
   * @param {string} type - Element type.
   * @param {string} message - Message to log.
   * @example error('Grok', 'composer', 'Timeout exceeded');
   */
  const error = (model, type, message) => {
    console.error(`[SelectorFinder] ${model}/${type}: ${message}`);
  };

  /**
   * Deep query that traverses shadow roots (mode: open) recursively.
   * Fast path: native querySelector on the current root.
   * Slow path: TreeWalker + shadowRoot descent.
   */
  const queryDeep = (selector, root = document) => {
    if (!selector || !root) return null;
    try {
      const direct = root.querySelector(selector);
      if (direct) return direct;
    } catch (_) {
      // ignore invalid selector here; upstream will log
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node?.shadowRoot) {
        const found = queryDeep(selector, node.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  };

  /**
   * Deep queryAll variant for shadow DOM traversal.
   */
  const queryDeepAll = (selector, root = document, results = []) => {
    if (!selector || !root) return results;
    try {
      results.push(...root.querySelectorAll(selector));
    } catch (_) {
      // ignore invalid selector here; upstream will log
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node?.shadowRoot) {
        queryDeepAll(selector, node.shadowRoot, results);
      }
    }
    return results;
  };

  /**
   * Emits selector-related telemetry events to the background script.
   * @param {string} event - Metric identifier.
   * @param {Object} [payload={}] - Arbitrary payload data.
   * @example sendMetric('selector_cache_hit', { modelName: 'Grok' });
   */
  const sendMetric = (event, payload = {}) => {
    try {
      chrome.runtime?.sendMessage({
        type: 'SELECTOR_METRIC',
        event,
        payload,
        timestamp: Date.now()
      });
    } catch (err) {
      console.warn('[SelectorFinder] Failed to send metric', err);
    }
  };

  const sendSelectorDiagnostic = (modelName, entry = {}) => {
    if (!modelName) return;
    try {
      chrome.runtime?.sendMessage({
        type: 'LLM_DIAGNOSTIC_EVENT',
        llmName: modelName,
        event: entry
      });
    } catch (err) {
      console.warn('[SelectorFinder] Failed to send selector diagnostic', err);
    }
  };

  const createLayerMetrics = (layer, total = 0) => ({
    layer,
    total,
    tried: 0,
    invalid: 0,
    notFound: 0,
    notInteractable: 0,
    rejected: 0,
    validationError: 0,
    success: false,
    selector: null,
    matchCount: null,
    lastError: null,
    skipped: false,
    skipReason: null
  });

  const countSelectorMatches = (selector, scope = document) => {
    try {
      const nodes = queryDeepAll(selector, scope);
      return nodes.length;
    } catch (_) {
      return null;
    }
  };

  const describeElement = (element) => {
    if (!element || !(element instanceof Element)) return null;
    const tag = (element.tagName || '').toLowerCase();
    const id = element.id ? `#${element.id}` : '';
    const role = element.getAttribute?.('role');
    const testId = element.getAttribute?.('data-testid');
    const aria = element.getAttribute?.('aria-label');
    const classList = element.className
      ? String(element.className).split(/\s+/).filter(Boolean).slice(0, 3).join('.')
      : '';
    return {
      tag: `${tag}${id}${classList ? `.${classList}` : ''}`,
      role: role || null,
      testId: testId || null,
      aria: aria || null
    };
  };

  const buildDomSnapshot = () => {
    try {
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollY: window.scrollY
        },
        activeElement: describeElement(document.activeElement),
        body: {
          childCount: document.body?.children?.length || 0
        },
        main: {
          exists: !!document.querySelector('main')
        }
      };
    } catch (_) {
      return null;
    }
  };

  /**
   * Removes outdated selector cache entries older than the TTL.
   * @returns {Promise<void>} Resolves when cleanup finishes.
   * @example await cleanupExpiredCache();
   */
  const cleanupExpiredCache = async () => {
    const now = Date.now();
    if (now - lastCleanupRun < 15 * 60 * 1000) return;
    lastCleanupRun = now;
    try {
      const all = await chrome.storage.local.get(null);
      const expiredKeys = Object.entries(all)
        .filter(([key, value]) => key.startsWith(CACHE_PREFIX) && value?.timestamp && now - value.timestamp > CACHE_TTL_MS)
        .map(([key]) => key);
      if (expiredKeys.length) {
        await chrome.storage.local.remove(expiredKeys);
        console.log(`[SelectorFinder] Removed ${expiredKeys.length} expired selector cache entries`);
      }
    } catch (err) {
      console.warn('[SelectorFinder] Cache cleanup failed', err);
    }
  };

  /**
   * Builds the chrome.storage key for a selector cache entry.
   * @param {string} modelName - Friendly LLM model name.
   * @param {string} elementType - Selector type (composer, sendButton, response).
   * @returns {string} Namespaced storage key.
   * @example const key = getCacheKey('Grok', 'composer');
   */
  const getCacheKey = (modelName, elementType) => `${CACHE_PREFIX}_${modelName}_${elementType}`;

  /**
   * Reads a selector cache entry for the requested model and element type.
   * @param {string} modelName - LLM model name.
   * @param {string} elementType - Element type identifier.
   * @returns {Promise<{selector: string, timestamp: number, uiVersion?: string}|null>} Stored entry or null.
   * @example const cached = await readCache('Grok', 'composer');
   */
  const readCache = async (modelName, elementType) => {
    await cleanupExpiredCache();
    const key = getCacheKey(modelName, elementType);
    try {
      const result = await chrome.storage.local.get(key);
      const entry = result[key];
      if (!entry) {
        stats.cacheMisses += 1;
        return null;
      }
      if (entry.timestamp && Date.now() - entry.timestamp > CACHE_TTL_MS) {
        await chrome.storage.local.remove(key);
        stats.cacheMisses += 1;
        return null;
      }
      stats.cacheHits += 1;
      return entry;
    } catch (err) {
      console.warn('[SelectorFinder] Cache read failed', err);
      return null;
    }
  };

  /**
   * Persists selector metadata to chrome.storage.
   * @param {string} modelName - LLM model name.
   * @param {string} elementType - Element type identifier.
   * @param {string} selector - CSS selector string.
   * @param {Object} metadata - Additional details to store (uiVersion, method, etc).
   * @returns {Promise<boolean>} True on success, false otherwise.
   * @example await writeCache('Grok', 'composer', '#prompt', { uiVersion: 'grok-2024-q4' });
   */
  const writeCache = async (modelName, elementType, selector, metadata = {}) => {
    const key = getCacheKey(modelName, elementType);
    const payload = {
      selector,
      timestamp: Date.now(),
      ...metadata
    };
    try {
      await chrome.storage.local.set({ [key]: payload });
      return true;
    } catch (err) {
      console.warn('[SelectorFinder] Cache write failed', err);
      return false;
    }
  };

  /**
   * Clears cached selectors for a specific model namespace.
   * @param {string} modelName - LLM model name.
   * @returns {Promise<number>} Number of removed entries.
   * @example const removed = await clearCacheForModel('Grok');
   */
  const clearCacheForModel = async (modelName) => {
    try {
      const all = await chrome.storage.local.get(null);
      const keysToRemove = Object.keys(all).filter((key) => key.startsWith(`${CACHE_PREFIX}_${modelName}_`));
      if (keysToRemove.length) {
        await chrome.storage.local.remove(keysToRemove);
      }
      return keysToRemove.length;
    } catch (err) {
      console.warn('[SelectorFinder] Cache clear failed', err);
      return 0;
    }
  };

  const buildElementFingerprint = (element) => {
    if (!element || !(element instanceof Element)) return null;
    const fingerprint = [];
    let current = element;
    for (let depth = 0; current && depth < MAX_FINGERPRINT_DEPTH; depth += 1) {
      fingerprint.push({
        tag: current.tagName?.toLowerCase() || '',
        id: current.id || '',
        dataTestId: current.getAttribute?.('data-testid') || '',
        role: current.getAttribute?.('role') || '',
        ariaLabel: current.getAttribute?.('aria-label') || '',
        classes: Array.from(current.classList || []).slice(0, 3)
      });
      current = current.parentElement;
    }
    return fingerprint;
  };

  const fingerprintMatchesElement = (fingerprint, element) => {
    if (!fingerprint || !fingerprint.length) return true;
    let current = element;
    for (const expected of fingerprint) {
      if (!current) return false;
      if (expected.tag && current.tagName?.toLowerCase() !== expected.tag) return false;
      if (expected.id && current.id !== expected.id) return false;
      if (expected.dataTestId && current.getAttribute?.('data-testid') !== expected.dataTestId) return false;
      if (expected.role && current.getAttribute?.('role') !== expected.role) return false;
      if (expected.ariaLabel && current.getAttribute?.('aria-label') !== expected.ariaLabel) return false;
      if (expected.classes?.length) {
        const hasAll = expected.classes.every((cls) => current.classList?.contains?.(cls));
        if (!hasAll) return false;
      }
      current = current.parentElement;
    }
    return true;
  };

  /**
   * Validates whether an element is currently interactable within the viewport.
   * @param {Element|null} element - Candidate DOM node.
   * @returns {boolean} True when the element is visible and enabled.
   * @example const ready = isElementInteractable(document.querySelector('textarea'));
   */
  const isElementInteractable = (element) => {
    if (!element) return false;
    if (element.getAttribute && element.getAttribute('disabled') !== null) return false;
    const computed = window.getComputedStyle ? window.getComputedStyle(element) : element.style;
    if (!computed) return false;
    const isFixedLike = computed.position === 'fixed' || computed.position === 'sticky';
    if (element.offsetParent === null && !isLayoutlessEnvironment && !isFixedLike) return false;
    if (computed.display === 'none' || computed.visibility === 'hidden') return false;
    if (isLayoutlessEnvironment) return true;
    const rect = element.getBoundingClientRect?.();
    if (!rect) return true;
    if (rect.width <= 0 || rect.height <= 0) return false;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    return rect.bottom >= 0 && rect.right >= 0 && rect.top <= viewportHeight && rect.left <= viewportWidth;
  };

  /**
   * Generates a reusable CSS selector for a discovered element.
   * Prefers ids, data attributes, then class names, falling back to a structural path.
   * @param {Element|null} element - Target DOM node.
   * @returns {string|null} Selector string or null if none could be produced.
   * @example const selector = getSelectorFromElement(document.querySelector('textarea'));
   */
  const getSelectorFromElement = (element) => {
    if (!element || !element.tagName) return null;
    if (element.id) return `#${cssEscape(element.id)}`;
    const attrCandidates = ['data-testid', 'data-qa', 'data-id', 'name', 'placeholder', 'aria-label', 'role'];
    for (const attr of attrCandidates) {
      const value = element.getAttribute?.(attr);
      if (value && value.length <= 80) {
        return `${element.tagName.toLowerCase()}[${attr}="${cssEscape(value)}"]`;
      }
    }
    const classList = Array.from(element.classList || []).filter((cls) => cls && !/^\d+$/.test(cls));
    if (classList.length) {
      return `${element.tagName.toLowerCase()}.${classList.map((cls) => cssEscape(cls)).join('.')}`;
    }
    let path = element.tagName.toLowerCase();
    let parent = element.parentElement;
    while (parent) {
      const siblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(element) + 1;
        path = `${parent.tagName.toLowerCase()} > ${element.tagName.toLowerCase()}:nth-of-type(${index})`;
      } else {
        path = `${parent.tagName.toLowerCase()} > ${path}`;
      }
      if (parent.id) {
        path = `#${cssEscape(parent.id)} > ${path}`;
        break;
      }
      parent = parent.parentElement;
    }
    return path;
  };

  /**
   * Returns the element when it is interactable, otherwise null.
   * @param {Element|null} element - Candidate node.
   * @returns {Element|null} Interactable element or null.
   * @example const el = ensureValidElement(document.querySelector('button'));
   */
  const ensureValidElement = (element) => (isElementInteractable(element) ? element : null);

  const SEARCH_KEYWORDS = ['search', 'find', 'поиск', 'найти', 'buscar'];

  const elementHasSearchAffinity = (element) => {
    if (!element) return false;
    const attributeMatches = (value) => {
      if (!value) return false;
      const normalized = String(value).toLowerCase();
      return SEARCH_KEYWORDS.some((keyword) => normalized.includes(keyword));
    };
    const attributesToCheck = ['aria-label', 'placeholder', 'data-testid', 'id', 'name'];
    for (const attr of attributesToCheck) {
      if (attributeMatches(element.getAttribute?.(attr))) return true;
    }
    if (attributeMatches(element.className)) return true;
    let current = element;
    let depth = 0;
    while (current && depth < 3) {
      if (attributeMatches(current.getAttribute?.('data-testid'))) return true;
      if (attributeMatches(current.id)) return true;
      if (attributeMatches(current.className)) return true;
      current = current.parentElement;
      depth += 1;
    }
    return false;
  };

  const validateElementForType = (elementType, element, context = {}) => {
    if (!element) return false;
    const tag = element.tagName?.toUpperCase?.() || '';
    const role = element.getAttribute?.('role')?.toLowerCase?.() || '';
    if (!ensureValidElement(element)) return false;
    const { constraints } = context;
    if (constraints?.exclude?.length) {
      const isExcluded = constraints.exclude.some((selector) => {
        if (!selector) return false;
        try {
          return element.matches?.(selector) || element.closest?.(selector);
        } catch (err) {
          console.warn('[SelectorFinder] Invalid exclusion selector', selector, err);
          return false;
        }
      });
      if (isExcluded) return false;
    }

    switch (elementType) {
      case 'composer': {
        const isTextual = tag === 'TEXTAREA' ||
          element.getAttribute?.('contenteditable') === 'true' ||
          role === 'textbox';
        if (!isTextual) return false;
        if (elementHasSearchAffinity(element)) return false;
        return true;
      }
      case 'sendButton': {
        if (element.disabled) return false;
        const isButtonLike = tag === 'BUTTON' || role === 'button';
        if (!isButtonLike) return false;
        if (elementHasSearchAffinity(element)) return false;
        const { referenceElement } = context;
        if (referenceElement && referenceElement instanceof Element) {
          const rootNode = referenceElement.getRootNode?.();
          const rootHost = rootNode && rootNode.host instanceof Element ? rootNode.host : null;
          let sharedContainer = referenceElement.closest('form, section, article, div, main');
          if (!sharedContainer && rootHost) {
            sharedContainer = rootHost.closest('form, section, article, div, main') || rootHost;
          }
          let depth = 0;
          const maxDepth = 6;
          let withinSharedHierarchy = false;
          let cursor = sharedContainer;
          while (cursor && depth < maxDepth) {
            if (cursor.contains(element)) {
              withinSharedHierarchy = true;
              break;
            }
            const nextCandidate = cursor.parentElement?.closest?.('form, section, article, div, main');
            cursor = nextCandidate || cursor.parentElement;
            depth += 1;
          }
          if (!withinSharedHierarchy && rootHost && rootHost.contains(element)) {
            withinSharedHierarchy = true;
          }
          if (!withinSharedHierarchy) return false;
        }
        return true;
      }
      case 'response': {
        if (tag === 'BODY' || tag === 'HTML') return false;
        if (elementHasSearchAffinity(element)) return false;
        return true;
      }
      default:
        return true;
    }
  };

  /**
   * Reads versioned selectors for the specified model from the config registry.
   * @param {string} modelName - LLM model name.
   * @param {string} elementType - Element type identifier.
   * @param {string} uiVersion - Detected UI version id or 'unknown'.
   * @returns {string[]} Selector candidates in priority order.
   * @example const selectors = gatherSelectorsFromConfig('Grok', 'composer', 'grok-2024-q4');
   */
  const gatherSelectorsFromConfig = (modelName, elementType, uiVersion) => {
    const cfg = globalObject.SelectorConfig;
    if (!cfg) return [];
    const modelConfig = cfg.getModelConfig?.(modelName) || cfg.models?.[modelName];
    if (!modelConfig) return [];
    const versionEntry = (modelConfig.versions || []).find((v) => v.version === uiVersion);
    if (versionEntry?.selectors?.[elementType]) {
      return normalizeSelectorList(versionEntry.selectors[elementType]);
    }
    const aggregate = [];
    for (const version of modelConfig.versions || []) {
      const list = normalizeSelectorList(version.selectors?.[elementType]);
      if (list.length) aggregate.push(...list);
    }
    return aggregate;
  };

  /**
   * Reads constraint metadata for the specified model/element from the config registry.
   * @param {string} modelName - LLM model name.
   * @param {string} elementType - Element type identifier.
   * @param {string} uiVersion - Detected UI version.
   * @returns {{exclude?: string[]}|null} Constraint descriptor.
   */
  const gatherConstraintsFromConfig = (modelName, elementType, uiVersion) => {
    const cfg = globalObject.SelectorConfig;
    if (!cfg?.getConstraintsFor) return null;
    const bundle = cfg.getConstraintsFor(modelName, uiVersion, elementType);
    if (bundle) return bundle;
    if (uiVersion !== 'unknown') {
      return cfg.getConstraintsFor(modelName, 'unknown', elementType);
    }
    return null;
  };

  const gatherAnchorsFromConfig = (modelName, elementType, uiVersion) => {
    const cfg = globalObject.SelectorConfig;
    if (!cfg?.getAnchorsFor) return [];
    return cfg.getAnchorsFor(modelName, uiVersion, elementType) || [];
  };

  const gatherSelectorBuckets = (modelName, elementType, uiVersion) => {
    const cfg = globalObject.SelectorConfig;
    const modelConfig = cfg?.getModelConfig?.(modelName) || cfg?.models?.[modelName];
    const buckets = { primary: [], fallback: [] };
    if (!modelConfig) return buckets;

    const mergeFrom = (value) => {
      if (!value) return;
      if (Array.isArray(value)) {
        buckets.primary.push(...value);
        return;
      }
      if (typeof value === 'object') {
        if (Array.isArray(value.primary)) buckets.primary.push(...value.primary);
        if (Array.isArray(value.fallback)) buckets.fallback.push(...value.fallback);
        for (const key of Object.keys(value)) {
          if (['primary', 'fallback', 'extraction'].includes(key)) continue;
          const arr = value[key];
          if (Array.isArray(arr)) buckets.fallback.push(...arr);
        }
      }
    };

    if (uiVersion && uiVersion !== 'unknown') {
      const versionEntry = (modelConfig.versions || []).find((v) => v.version === uiVersion);
      mergeFrom(versionEntry?.selectors?.[elementType]);
    } else {
      for (const versionEntry of modelConfig.versions || []) {
        mergeFrom(versionEntry.selectors?.[elementType]);
      }
    }

    if (!buckets.primary.length) {
      mergeFrom(modelConfig.emergencyFallbacks?.[elementType]);
    }
    if (!buckets.fallback.length) {
      mergeFrom(modelConfig.emergencyFallbacks?.[elementType]);
    }

    buckets.primary = Array.from(new Set(buckets.primary.filter(Boolean)));
    buckets.fallback = Array.from(new Set(buckets.fallback.filter(Boolean)));
    return buckets;
  };

  const gatherObservationConfig = (modelName, elementType, uiVersion) => {
    const cfg = globalObject.SelectorConfig;
    const modelConfig = cfg?.getModelConfig?.(modelName) || cfg?.models?.[modelName];
    if (!modelConfig) return null;

    const cloneObservation = (source) => {
      if (!source) return null;
      const copy = { ...source };
      if (Array.isArray(source.targetSelectors)) {
        copy.targetSelectors = Array.from(new Set(source.targetSelectors.filter(Boolean)));
      }
      if (Array.isArray(source.endGenerationMarkers)) {
        copy.endGenerationMarkers = source.endGenerationMarkers.map((marker) => ({ ...marker }));
      }
      return copy;
    };

    if (uiVersion && uiVersion !== 'unknown') {
      const versionEntry = (modelConfig.versions || []).find((v) => v.version === uiVersion);
      const observation = cloneObservation(versionEntry?.observation);
      if (observation) return observation;
    }

    for (const versionEntry of modelConfig.versions || []) {
      const observation = cloneObservation(versionEntry.observation);
      if (observation) return observation;
    }

    return cloneObservation(modelConfig.observationDefaults) || null;
  };

  const gatherExtractionStrategy = (modelName, elementType, uiVersion) => {
    const cfg = globalObject.SelectorConfig;
    const extraction = cfg?.getExtractionConfig?.(modelName, uiVersion, elementType);
    if (extraction) return { ...extraction };
    return null;
  };

  /**
   * Returns emergency fallback selectors for a given model and element type.
   * @param {string} modelName - LLM model name.
   * @param {string} elementType - Element type identifier.
   * @returns {string[]} Fallback selectors.
   * @example const fallbacks = gatherEmergencyFallbacks('Grok', 'composer');
   */
  const gatherEmergencyFallbacks = (modelName, elementType) => {
    const cfg = globalObject.SelectorConfig;
    if (!cfg) return [];
    const modelConfig = cfg.getModelConfig?.(modelName) || cfg.models?.[modelName];
    if (!modelConfig) return [];
    return Array.from(modelConfig.emergencyFallbacks?.[elementType] || []);
  };

  /**
   * Detects the active UI version for the given model using the selector config.
   * @param {string} modelName - LLM model name.
   * @returns {string} Version identifier or 'unknown'.
   * @example const version = detectUIVersion('Grok');
   */
  const detectUIVersion = (modelName) => {
    const cfg = globalObject.SelectorConfig;
    if (cfg?.detectUIVersion) {
      const version = cfg.detectUIVersion(modelName, document);
      if (version) return version;
    }
    return 'unknown';
  };

  /**
   * Attempts to resolve an element using cached selectors.
   * @param {Object} params - Parameter bag.
   * @param {string} params.modelName - LLM model name.
   * @param {string} params.elementType - Element type identifier.
   * @param {number} params.timeout - Unused currently, included for parity.
   * @param {boolean} params.forceDiscovery - Skip cache when true.
   * @returns {Promise<{selector: string, element: Element, method: string}|null>} Result object or null.
   * @example await runLayerCached({ modelName: 'Grok', elementType: 'composer', timeout: 1000, forceDiscovery: false });
   */
  const runLayerCached = async ({ modelName, elementType, timeout, forceDiscovery, referenceElement, trace }) => {
    const startedAt = Date.now();
    if (forceDiscovery) {
      if (trace?.layers) {
        trace.layers.cache = { ...createLayerMetrics('cache', 0), skipped: true, skipReason: 'forceDiscovery', durationMs: Date.now() - startedAt };
      }
      return null;
    }
    const cached = await readCache(modelName, elementType);
    const metrics = createLayerMetrics('cache', cached?.selector ? 1 : 0);
    metrics.selector = cached?.selector || null;
    if (!cached || !cached.selector) {
      metrics.durationMs = Date.now() - startedAt;
      if (trace?.layers) trace.layers.cache = metrics;
      return null;
    }
    metrics.tried = 1;
    let element = null;
    try {
      element = queryDeep(cached.selector, document);
    } catch (err) {
      metrics.invalid += 1;
      metrics.lastError = err?.message || String(err);
      metrics.durationMs = Date.now() - startedAt;
      if (trace?.layers) trace.layers.cache = metrics;
      return null;
    }
    if (!element) {
      metrics.notFound += 1;
      metrics.durationMs = Date.now() - startedAt;
      if (trace?.layers) trace.layers.cache = metrics;
    } else {
      const interactable = ensureValidElement(element);
      if (!interactable) {
        metrics.notInteractable += 1;
        metrics.matchCount = countSelectorMatches(cached.selector, document);
        metrics.durationMs = Date.now() - startedAt;
        if (trace?.layers) trace.layers.cache = metrics;
      } else {
        const constraints = gatherConstraintsFromConfig(modelName, elementType, cached?.uiVersion || 'unknown');
        const fingerprintOk = fingerprintMatchesElement(cached.fingerprint, element);
        if (!fingerprintOk) {
          metrics.rejected += 1;
          metrics.lastError = 'fingerprint_mismatch';
          metrics.durationMs = Date.now() - startedAt;
          if (trace?.layers) trace.layers.cache = metrics;
        } else if (!validateElementForType(elementType, element, { referenceElement, constraints })) {
          metrics.rejected += 1;
          metrics.lastError = 'validation_failed';
          metrics.durationMs = Date.now() - startedAt;
          if (trace?.layers) trace.layers.cache = metrics;
        } else {
          metrics.success = true;
          metrics.matchCount = countSelectorMatches(cached.selector, document);
          metrics.durationMs = Date.now() - startedAt;
          if (trace?.layers) trace.layers.cache = metrics;
          log(modelName, elementType, `Cache hit (${cached.selector})`);
          sendMetric('selector_cache_hit', { modelName, elementType, selector: cached.selector });
          debugTrace(modelName, elementType, `Cache hit with selector ${cached.selector}`);
          highlightElement(element, `${modelName}/${elementType}: cache`);
          return { selector: cached.selector, element, method: 'cache', layer: 'cache' };
        }
      }
    }
    warn(modelName, elementType, `Cached selector invalid (${cached.selector})`);
    debugTrace(modelName, elementType, `Cached selector invalid (${cached.selector})`);
    try {
      await chrome.storage.local.remove(getCacheKey(modelName, elementType));
    } catch (err) {
      console.warn('[SelectorFinder] Failed to purge invalid cache entry', err);
    }
    return null;
  };

  /**
   * Iterates through selector candidates until an interactable element is found.
   * @param {string[]} selectors - Selector candidates.
   * @param {Document|Element} [scope=document] - Search scope.
   * @returns {{selector: string, element: Element}|null} Matched selector and element, or null.
   * @example const result = trySelectors(['textarea'], document);
   */
  const recordAttempt = (metrics, attempt) => {
    if (!metrics || !Array.isArray(metrics.attempts)) return;
    metrics.attempts.push(attempt);
    if (metrics.attempts.length > MAX_SELECTOR_ATTEMPTS) {
      metrics.attempts.shift();
    }
  };

  const trySelectors = (selectors, scope = document, validateFn = () => true, context = {}) => {
    const metrics = context.metrics;
    if (metrics) {
      metrics.total = selectors.length;
      if (context.captureAttempts && !metrics.attempts) {
        metrics.attempts = [];
      }
    }
    for (const selector of selectors) {
      if (metrics) metrics.tried += 1;
      const attemptStart = Date.now();
      try {
        const element = queryDeep(selector, scope);
        if (!element) {
          if (metrics) metrics.notFound += 1;
          recordAttempt(metrics, { selector, status: 'not_found', durationMs: Date.now() - attemptStart });
          continue;
        }
        const interactable = ensureValidElement(element);
        if (!interactable) {
          if (metrics) {
            metrics.notInteractable += 1;
            if (metrics.matchCount === null) {
              metrics.matchCount = countSelectorMatches(selector, scope);
            }
          }
          recordAttempt(metrics, {
            selector,
            status: 'not_interactable',
            durationMs: Date.now() - attemptStart,
            matchCount: metrics?.matchCount ?? null
          });
          continue;
        }
        let isValid = false;
        try {
          isValid = !!validateFn(interactable, selector, context);
        } catch (err) {
          if (metrics) {
            metrics.validationError += 1;
            metrics.lastError = err?.message || String(err);
          }
          isValid = false;
        }
        if (!isValid) {
          if (metrics) metrics.rejected += 1;
          recordAttempt(metrics, {
            selector,
            status: 'rejected',
            durationMs: Date.now() - attemptStart,
            error: metrics?.lastError || null
          });
          continue;
        }
        if (metrics) {
          metrics.success = true;
          metrics.selector = selector;
          metrics.matchCount = countSelectorMatches(selector, scope);
        }
        recordAttempt(metrics, {
          selector,
          status: 'success',
          durationMs: Date.now() - attemptStart,
          matchCount: metrics?.matchCount ?? null
        });
        return { selector, element: interactable };
      } catch (err) {
        if (metrics) {
          metrics.invalid += 1;
          metrics.lastError = err?.message || String(err);
        }
        recordAttempt(metrics, {
          selector,
          status: 'invalid_selector',
          durationMs: Date.now() - attemptStart,
          error: err?.message || String(err)
        });
        console.warn('[SelectorFinder] Invalid selector syntax', selector, err);
      }
    }
    return null;
  };

  /**
   * Uses versioned selectors defined in the configuration registry.
   * @param {Object} params - Parameter bag.
   * @param {string} params.modelName - LLM model name.
   * @param {string} params.elementType - Element type identifier.
   * @param {string} params.uiVersion - Detected UI version.
   * @returns {Promise<{selector: string, element: Element, method: string}|null>} Found element or null.
   * @example await runLayerVersioned({ modelName: 'Grok', elementType: 'composer', uiVersion: 'grok-2024-q4' });
   */
  const runLayerVersioned = async ({ modelName, elementType, uiVersion, referenceElement, trace }) => {
    const startedAt = Date.now();
    const selectors = gatherSelectorsFromConfig(modelName, elementType, uiVersion);
    const metrics = createLayerMetrics('versioned', selectors.length);
    metrics.uiVersion = uiVersion;
    if (trace?.captureAttempts) metrics.attempts = [];
    if (!selectors.length) {
      metrics.skipped = true;
      metrics.skipReason = 'no_selectors';
      metrics.durationMs = Date.now() - startedAt;
      if (trace?.layers) trace.layers.versioned = metrics;
      return null;
    }
    const constraints = gatherConstraintsFromConfig(modelName, elementType, uiVersion);
    const result = trySelectors(
      selectors,
      document,
      (element) => validateElementForType(elementType, element, { referenceElement, constraints }),
      { referenceElement, constraints, metrics, captureAttempts: trace?.captureAttempts }
    );
    metrics.durationMs = Date.now() - startedAt;
    if (trace?.layers) trace.layers.versioned = metrics;
    if (result) {
      stats.versionedHits += 1;
      log(modelName, elementType, `Found via version ${uiVersion}, selector: ${result.selector}`);
      sendMetric('selector_versioned_hit', { modelName, elementType, uiVersion, selector: result.selector });
      debugTrace(modelName, elementType, `Versioned selector success (${result.selector})`);
      highlightElement(result.element, `${modelName}/${elementType}: version:${uiVersion}`);
      await writeCache(modelName, elementType, result.selector, {
        uiVersion,
        method: 'versioned',
        fingerprint: buildElementFingerprint(result.element)
      });
      return { selector: result.selector, element: result.element, method: `versioned:${uiVersion}`, layer: 'versioned' };
    }
    return null;
  };

  /**
   * Executes heuristic strategies to auto-discover matching elements.
   * @param {Object} params - Parameter bag.
   * @param {string} params.modelName - LLM model name.
   * @param {string} params.elementType - Element type identifier.
   * @param {number} params.timeout - Maximum discovery duration.
   * @param {Element|null} params.referenceElement - Optional element to guide the search.
   * @returns {Promise<{selector: string, element: Element, method: string}|null>} Result or null.
   * @example await runAutoDiscovery({ modelName: 'Grok', elementType: 'composer', timeout: 30000, referenceElement: null });
   */
  const computeAnchorBoost = (element, anchors = []) => {
    if (!element || !anchors.length) return 0;
    const haystack = [
      element.textContent,
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
      element.getAttribute?.('placeholder')
    ].filter(Boolean).join(' ').toLowerCase();
    if (!haystack) return 0;
    return anchors.reduce((score, anchor) => {
      if (!anchor) return score;
      return haystack.includes(anchor.toLowerCase()) ? score + 12 : score;
    }, 0);
  };

  const runAutoDiscovery = async ({ modelName, elementType, timeout, referenceElement, uiVersion, trace }) => {
    const startedAt = Date.now();
    stats.autoDiscoveryRuns += 1;
    let attempt = 0;
    const strategies = autoDiscoveryStrategies[elementType] || [];
    const constraints = gatherConstraintsFromConfig(modelName, elementType, uiVersion);
    const anchors = gatherAnchorsFromConfig(modelName, elementType, uiVersion);
    const metrics = createLayerMetrics('autodiscovery', strategies.length);
    metrics.noCandidate = 0;
    metrics.lowConfidence = 0;
    if (!strategies.length) {
      metrics.skipped = true;
      metrics.skipReason = 'no_strategies';
      metrics.durationMs = Date.now() - startedAt;
      if (trace?.layers) trace.layers.autodiscovery = metrics;
      return null;
    }
    while (Date.now() - startedAt < timeout) {
      for (const strategy of strategies) {
        try {
          metrics.tried += 1;
          const outcome = strategy(referenceElement);
          if (!outcome) {
            metrics.noCandidate += 1;
            continue;
          }

          const element = outcome?.element instanceof Element ? outcome.element : (outcome instanceof Element ? outcome : null);
          let confidence = typeof outcome?.confidence === 'number'
            ? outcome.confidence
            : (outcome instanceof Element ? 80 : 0);
          const anchorBoost = anchors.length ? computeAnchorBoost(element, anchors) : 0;
          if (anchorBoost > 0) {
            debugTrace(modelName, elementType, `Anchor boost +${anchorBoost} for candidate`);
          }
          confidence += anchorBoost;

          if (confidence < MIN_AUTODISCOVERY_CONFIDENCE) {
            metrics.lowConfidence += 1;
            debugTrace(modelName, elementType, `Auto-discovery candidate rejected (confidence=${confidence})`);
            continue;
          }

          if (ensureValidElement(element) && validateElementForType(elementType, element, { referenceElement, constraints })) {
            const selector = getSelectorFromElement(element);
            if (selector) {
              await writeCache(modelName, elementType, selector, {
                method: 'autodiscovery',
                uiVersion: 'unknown',
                fingerprint: buildElementFingerprint(element)
              });
              log(modelName, elementType, `Auto-discovery success (${selector})`);
              sendMetric('selector_discovery_success', { modelName, elementType, selector, confidence });
              debugTrace(modelName, elementType, `Auto-discovery success (${selector}) [confidence=${confidence}]`);
              highlightElement(element, `${modelName}/${elementType}: auto-discovery`);
              metrics.success = true;
              metrics.selector = selector;
              metrics.matchCount = countSelectorMatches(selector, document);
              metrics.durationMs = Date.now() - startedAt;
              if (trace?.layers) trace.layers.autodiscovery = metrics;
              return { selector, element, method: 'auto-discovery', layer: 'autodiscovery', confidence };
            }
          }
          metrics.rejected += 1;
        } catch (err) {
          metrics.validationError += 1;
          metrics.lastError = err?.message || String(err);
          console.warn('[SelectorFinder] Auto-discovery strategy failed', err);
        }
      }
      attempt += 1;
      const delay = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    metrics.durationMs = Date.now() - startedAt;
    if (trace?.layers) trace.layers.autodiscovery = metrics;
    return null;
  };

  /**
   * Applies emergency fallback selectors when other layers fail.
   * @param {Object} params - Parameter bag.
   * @param {string} params.modelName - LLM model name.
   * @param {string} params.elementType - Element type identifier.
   * @returns {Promise<{selector: string, element: Element, method: string}|null>} Result or null.
   * @example await runEmergencyFallback({ modelName: 'Grok', elementType: 'composer' });
   */
  const runEmergencyFallback = async ({ modelName, elementType, referenceElement, uiVersion, trace }) => {
    const startedAt = Date.now();
    const selectors = gatherEmergencyFallbacks(modelName, elementType);
    const metrics = createLayerMetrics('emergency', selectors.length);
    if (trace?.captureAttempts) metrics.attempts = [];
    if (!selectors.length) {
      metrics.skipped = true;
      metrics.skipReason = 'no_selectors';
      metrics.durationMs = Date.now() - startedAt;
      if (trace?.layers) trace.layers.emergency = metrics;
      return null;
    }
    const constraints = gatherConstraintsFromConfig(modelName, elementType, uiVersion);
    const result = trySelectors(
      selectors,
      document,
      (element) => validateElementForType(elementType, element, { referenceElement, constraints }),
      { referenceElement, constraints, metrics, captureAttempts: trace?.captureAttempts }
    );
    metrics.durationMs = Date.now() - startedAt;
    if (trace?.layers) trace.layers.emergency = metrics;
    if (result) {
      warn(modelName, elementType, `Emergency fallback used (${result.selector})`);
      sendMetric('selector_emergency_fallback', { modelName, elementType, selector: result.selector });
      debugTrace(modelName, elementType, `Emergency fallback success (${result.selector})`);
      highlightElement(result.element, `${modelName}/${elementType}: emergency`);
      await writeCache(modelName, elementType, result.selector, {
        method: 'emergency',
        uiVersion: 'unknown',
        fingerprint: buildElementFingerprint(result.element)
      });
      return { selector: result.selector, element: result.element, method: 'emergency-fallback', layer: 'emergency' };
    }
    return null;
  };

  /**
   * Ensures selector discovery calls run sequentially per element key.
   * @param {string} key - Discovery namespace (model/element type).
   * @param {Function} executor - Async function returning a Promise with the discovery result.
   * @returns {Promise<*>} Resolves with executor result.
   * @example await withDiscoveryQueue('Grok:composer', () => Promise.resolve(null));
   */
  const withDiscoveryQueue = (key, executor) => {
    return new Promise((resolve, reject) => {
      const queue = discoveryQueues.get(key) || [];
      const runTask = () => {
        discoveryState.set(key, true);
        executor()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            queue.shift();
            if (queue.length) {
              queue[0]();
            } else {
              discoveryQueues.delete(key);
              discoveryState.delete(key);
            }
          });
      };
      queue.push(runTask);
      discoveryQueues.set(key, queue);
      if (queue.length === 1) {
        runTask();
      }
    });
  };

  /**
   * Public API entry point: resolves a selector for the requested model + element type.
   * Applies Cache → Versioned → Auto-discovery → Emergency fallback layers.
   * @param {Object} [options={}] - Search options.
   * @param {string} options.modelName - LLM model name.
   * @param {string} options.elementType - Element type identifier.
   * @param {number} [options.timeout=30000] - Maximum search duration in milliseconds.
   * @param {boolean} [options.forceDiscovery=false] - Skip cache lookup when true.
   * @param {Element|null} [options.referenceElement=null] - Optional element to guide heuristics.
   * @returns {Promise<{selector: string, element: Element, method: string, duration: number}|null>} Result object or null.
   * @example const result = await SelectorFinder.findOrDetectSelector({ modelName: 'Grok', elementType: 'composer' });
   */
  const findOrDetectSelector = async (options = {}) => {
    const {
      modelName = 'Unknown',
      elementType = 'composer',
      timeout = DEFAULT_TIMEOUT_MS,
      forceDiscovery = false,
      referenceElement = null
    } = options;

    const key = `${modelName}:${elementType}`;
    stats.requests += 1;
    sendMetric('selector_search', { modelName, elementType, forceDiscovery });

    const effectiveTimeout = Number.isFinite(timeout) ? timeout : DEFAULT_TIMEOUT_MS;
    const verboseSelectors = resolveVerboseSelectors();

    const attemptSearch = async () => {
      const start = Date.now();
      const resolutionSteps = [];
      const trace = {
        modelName,
        elementType,
        forceDiscovery,
        startTs: start,
        uiVersion: null,
        layers: {},
        verbose: verboseSelectors,
        captureAttempts: verboseSelectors,
        domSnapshot: null
      };
      const layerOrder = ['cache', 'versioned', 'autodiscovery', 'emergency'];
      const layerLabels = {
        cache: 'L1',
        versioned: 'L2',
        autodiscovery: 'L3',
        emergency: 'L4'
      };
      const truncate = (value, limit = 120) => {
        if (!value) return '';
        const str = String(value);
        if (str.length <= limit) return str;
        return `${str.slice(0, Math.max(0, limit - 3))}...`;
      };
      const summarizeLayer = (layerKey) => {
        const metrics = trace.layers[layerKey];
        const label = layerLabels[layerKey] || layerKey;
        if (!metrics) return `${label}: none`;
        if (metrics.skipped) return `${label}: skip`;
        if (metrics.success) return `${label}: hit`;
        const tried = Number.isFinite(metrics.tried) ? metrics.tried : 0;
        const total = Number.isFinite(metrics.total) ? metrics.total : 0;
        if (!total) return `${label}: miss`;
        return `${label}: miss ${tried}/${total}`;
      };
      const emitSelectorTrace = (status, result = null, error = null) => {
        const summary = layerOrder.map(summarizeLayer).join(' | ');
        const selectorHint = result?.selector ? ` | ${truncate(result.selector, 80)}` : '';
        const details = `${summary}${selectorHint}`.trim();
        const level = status === 'SELECTOR_RESOLVE'
          ? 'success'
          : (status === 'SELECTOR_RESOLVE_FAIL' ? 'error' : 'warning');
        if (status === 'SELECTOR_RESOLVE_FAIL' || status === 'SELECTOR_RESOLVE_ERROR') {
          trace.domSnapshot = trace.domSnapshot || buildDomSnapshot();
        }
        const timing = layerOrder.reduce((acc, layerKey) => {
          const duration = trace.layers[layerKey]?.durationMs;
          if (Number.isFinite(duration)) acc[layerKey] = duration;
          return acc;
        }, {});
        sendSelectorDiagnostic(modelName, {
          ts: Date.now(),
          type: 'SELECTOR',
          label: status,
          details,
          level,
          meta: {
            event: status,
            elementType,
            uiVersion: trace.uiVersion,
            durationMs: Date.now() - start,
            forceDiscovery,
            layer: result?.layer || null,
            selector: result?.selector || null,
            error: error?.message || error || null,
            attempts: trace.layers,
            timing,
            domSnapshot: trace.domSnapshot
          }
        });
      };
      const finalizeResult = (result, layer, extra = '') => {
        if (layer) {
          reportResolutionLayer(modelName, elementType, layer);
        }
        const pathSummary = resolutionSteps.join(' -> ');
        const detail = extra ? `${pathSummary} (${extra})` : pathSummary;
        if (pathSummary) {
          debugTrace(modelName, elementType, `Resolution path: ${detail}`);
        }
        return { ...result, duration: Date.now() - start };
      };
      try {
        if (isDebugEnabled()) {
          clearDebugHighlights();
        }
        resolutionSteps.push(`Ищу ${elementType}`);
        if (!forceDiscovery) {
          const cached = await runLayerCached({ modelName, elementType, timeout: effectiveTimeout, forceDiscovery, referenceElement, trace });
          if (cached) {
            stats.successes += 1;
            resolutionSteps.push(`L1 (Кэш): успех – ${cached.selector}`);
            emitSelectorTrace('SELECTOR_RESOLVE', cached);
            return finalizeResult(cached, cached.layer || 'cache');
          }
          resolutionSteps.push('L1 (Кэш): промах');
          log(modelName, elementType, 'Cache miss, attempting versioned selectors');
          debugTrace(modelName, elementType, 'Cache miss, proceeding to versioned selectors');
        } else {
          log(modelName, elementType, 'Force discovery enabled, skipping cache layer');
          debugTrace(modelName, elementType, 'Force discovery active, skipping cache');
          resolutionSteps.push('L1 (Кэш): пропущен (forceDiscovery)');
          trace.layers.cache = { ...createLayerMetrics('cache', 0), skipped: true, skipReason: 'forceDiscovery' };
        }

        const uiVersion = detectUIVersion(modelName);
        trace.uiVersion = uiVersion;
        debugTrace(modelName, elementType, `Detected UI version ${uiVersion}`);
        if (!forceDiscovery) {
          const versioned = await runLayerVersioned({ modelName, elementType, uiVersion, referenceElement, trace });
          if (versioned) {
            stats.successes += 1;
            resolutionSteps.push(`L2 (Версия "${uiVersion}"): успех – ${versioned.selector}`);
            emitSelectorTrace('SELECTOR_RESOLVE', versioned);
            return finalizeResult(versioned, versioned.layer || 'versioned');
          }
          resolutionSteps.push(`L2 (Версия "${uiVersion}"): промах`);
        } else {
          const metrics = createLayerMetrics('versioned', 0);
          metrics.uiVersion = uiVersion;
          metrics.skipped = true;
          metrics.skipReason = 'forceDiscovery';
          trace.layers.versioned = metrics;
        }

        log(modelName, elementType, 'Versioned selectors failed, attempting auto-discovery');
        debugTrace(modelName, elementType, 'Versioned selectors failed, trying auto-discovery');
        const discovered = await runAutoDiscovery({ modelName, elementType, timeout: effectiveTimeout, referenceElement, uiVersion, trace });
        if (discovered) {
          stats.successes += 1;
          resolutionSteps.push(`L3 (Эвристика): успех – ${discovered.selector}${discovered.confidence ? ` (уверенность=${discovered.confidence})` : ''}`);
          emitSelectorTrace('SELECTOR_RESOLVE', discovered);
          return finalizeResult(discovered, discovered.layer || 'autodiscovery', discovered.confidence ? `уверенность=${discovered.confidence}` : '');
        }
        resolutionSteps.push('L3 (Эвристика): промах');

        warn(modelName, elementType, 'Auto-discovery failed, attempting emergency fallback');
        debugTrace(modelName, elementType, 'Auto-discovery failed, trying emergency fallbacks');
        const fallback = await runEmergencyFallback({ modelName, elementType, referenceElement, uiVersion, trace });
        if (fallback) {
          stats.successes += 1;
          resolutionSteps.push(`L4 (Аварийный фолбэк): успех – ${fallback.selector}`);
          emitSelectorTrace('SELECTOR_RESOLVE', fallback);
          return finalizeResult(fallback, fallback.layer || 'emergency');
        }
        resolutionSteps.push('L4 (Аварийный фолбэк): промах');

        stats.failures += 1;
        error(modelName, elementType, 'All layers failed to locate selector');
        sendMetric('selector_search_failed', { modelName, elementType });
        debugTrace(modelName, elementType, `All layers failed to locate selector. Path: ${resolutionSteps.join(' -> ')}`);
        emitSelectorTrace('SELECTOR_RESOLVE_FAIL');
        return null;
      } catch (err) {
        stats.failures += 1;
        error(modelName, elementType, `Search errored: ${err?.message || err}`);
        sendMetric('selector_search_error', { modelName, elementType, message: err?.message || String(err) });
        emitSelectorTrace('SELECTOR_RESOLVE_ERROR', null, err);
        throw err;
      }
    };

    return withDiscoveryQueue(key, () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, effectiveTimeout);

      const timeoutPromise = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          const err = new Error(`Selector search timed out after ${effectiveTimeout}ms`);
          err.code = 'timeout';
          reject(err);
        }, { once: true });
      });

      return Promise.race([attemptSearch(), timeoutPromise])
        .finally(() => clearTimeout(timeoutId));
    });
  };

  const waitForElement = async ({
    modelName = 'Unknown',
    elementType = 'response',
    timeout = 150000,
    prompt = '',
    referenceElement = null
  } = {}) => {
    const effectiveTimeout = Number.isFinite(timeout) ? timeout : 150000;
    const uiVersion = detectUIVersion(modelName);
    debugTrace(modelName, elementType, `waitForElement started (uiVersion=${uiVersion})`);
    if (isDebugEnabled()) clearDebugHighlights();

    const selectorBuckets = gatherSelectorBuckets(modelName, elementType, uiVersion);
    const observationConfig = gatherObservationConfig(modelName, elementType, uiVersion);
    const extraction = gatherExtractionStrategy(modelName, elementType, uiVersion) || {};

    if (!observationConfig) {
      const direct = await findOrDetectSelector({ modelName, elementType, timeout: effectiveTimeout, referenceElement });
      if (direct?.element) {
        const text = extractTextFromNode(direct.element, extraction);
        debugTrace(modelName, elementType, 'waitForElement returning direct selector match');
        return { ...direct, text, extraction };
      }
      return { element: null, text: '', selector: null, method: 'direct', extraction };
    }

    const initialMatch = await findOrDetectSelector({ modelName, elementType, timeout: effectiveTimeout, referenceElement });
    const baseScope = initialMatch?.element instanceof Element ? initialMatch.element : document;
    const observationRoot = await resolveObservationRoot(observationConfig, baseScope, effectiveTimeout);
    const searchScope = baseScope instanceof Element ? baseScope : observationRoot;

    const fallbackDelay = typeof observationConfig.fallbackDelayMs === 'number'
      ? observationConfig.fallbackDelayMs
      : 10000;
    const targetSelectors = Array.isArray(observationConfig.targetSelectors) && observationConfig.targetSelectors.length
      ? observationConfig.targetSelectors
      : Array.from(new Set([...selectorBuckets.primary, ...selectorBuckets.fallback]));

    return new Promise((resolve, reject) => {
      let lastResult = null;
      let timeoutId = null;
      let observer = null;
      let hashIntervalId = null;
      const hashHistory = [];
      let settled = false;
      const startTime = Date.now();

      const cleanup = () => {
        if (observer) observer.disconnect();
        if (timeoutId) clearTimeout(timeoutId);
        if (hashIntervalId) clearInterval(hashIntervalId);
      };

      const finalize = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        const payload = result || lastResult;
        if (payload?.node) {
          highlightElement(payload.node, `${modelName}/${elementType}: waitForElement`);
        }
        if (payload?.text) {
          debugTrace(modelName, elementType, `waitForElement resolved with ${payload.bucket || 'primary'} selector`, payload.selector);
          resolve({
            element: payload.node,
            text: payload.text,
            selector: payload.selector,
            bucket: payload.bucket,
            method: `observation:${payload.bucket || 'primary'}`,
            extraction
          });
          return;
        }
        if (initialMatch?.element) {
          const fallbackText = extractTextFromNode(initialMatch.element, extraction);
          resolve({
            element: initialMatch.element,
            text: fallbackText,
            selector: initialMatch.selector,
            bucket: 'initial',
            method: initialMatch.method || 'initial',
            extraction
          });
          return;
        }
        reject(new Error('waitForElement resolved without content'));
      };

      const evaluate = (force = false) => {
        const allowFallback = force || (Date.now() - startTime) >= fallbackDelay;
        const primaryCandidate = extractFromSelectors(searchScope, selectorBuckets.primary, extraction, prompt);
        const fallbackCandidate = allowFallback
          ? extractFromSelectors(searchScope, selectorBuckets.fallback, extraction, prompt)
          : null;
        const candidate = primaryCandidate || fallbackCandidate;
        if (!candidate) {
          return;
        }
        if (!lastResult || candidate.text !== lastResult.text) {
          lastResult = {
            ...candidate,
            bucket: primaryCandidate ? 'primary' : 'fallback'
          };
          hashHistory.length = 0;
        }
      };

      const matchesTarget = (node) => {
        if (!(node instanceof Element)) return false;
        if (!targetSelectors.length) return true;
        return targetSelectors.some((selector) => {
          try {
            return node.matches(selector) || !!node.closest(selector);
          } catch {
            return false;
          }
        });
      };

      observer = new MutationObserver((mutations) => {
        const relevant = mutations.some((mutation) => {
          if (mutation.type === 'characterData') {
            const parent = mutation.target?.parentElement;
            return parent ? matchesTarget(parent) : false;
          }
          if (matchesTarget(mutation.target)) return true;
          return Array.from(mutation.addedNodes || []).some((added) => matchesTarget(added));
        });
        if (relevant) {
          evaluate(false);
        }
      });

      try {
        observer.observe(observationRoot, {
          childList: true,
          subtree: true,
          characterData: true
        });
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }

      evaluate(true);

      hashIntervalId = setInterval(() => {
        const activeResult = lastResult || (initialMatch?.element ? {
          node: initialMatch.element,
          text: extractTextFromNode(initialMatch.element, extraction),
          selector: initialMatch.selector,
          bucket: 'initial'
        } : null);

        if (!activeResult || !activeResult.node) return;

        const currentText = extractTextFromNode(activeResult.node, extraction);
        if (!currentText) return;

        const currentHash = computeHash(currentText);
        hashHistory.push({ hash: currentHash, text: currentText, selector: activeResult.selector, bucket: activeResult.bucket, node: activeResult.node });
        if (hashHistory.length > 4) hashHistory.shift();

        const allStable = hashHistory.length >= 3 && hashHistory.every((entry) => entry.hash === hashHistory[0].hash);
        if (allStable && checkEndMarkers(observationConfig.endGenerationMarkers)) {
          const stableEntry = hashHistory[hashHistory.length - 1];
          finalize({
            node: stableEntry.node,
            text: stableEntry.text,
            selector: stableEntry.selector,
            bucket: stableEntry.bucket || 'primary'
          });
        }
      }, 250);

      timeoutId = setTimeout(() => {
        cleanup();
        if (lastResult && lastResult.text) {
          resolve({
            element: lastResult.node,
            text: lastResult.text,
            selector: lastResult.selector,
            bucket: lastResult.bucket,
            method: `timeout:${lastResult.bucket}`,
            extraction
          });
        } else if (initialMatch?.element) {
          const fallbackText = extractTextFromNode(initialMatch.element, extraction);
          resolve({
            element: initialMatch.element,
            text: fallbackText,
            selector: initialMatch.selector,
            bucket: 'initial',
            method: 'timeout:initial',
            extraction
          });
        } else {
          reject(new Error('waitForElement timed out without matching content'));
        }
      }, effectiveTimeout);
    });
  };

  /**
   * Validates a selector within the provided scope and returns the interactable element.
   * @param {string} selector - CSS selector string.
   * @param {Document|Element} [scope=document] - Search scope.
   * @returns {Element|null} Interactable element or null when missing.
   * @example const element = SelectorFinder.validateSelector('#prompt');
   */
  const validateSelector = (selector, scope = document) => {
    try {
      const element = queryDeep(selector, scope);
      return ensureValidElement(element);
    } catch (err) {
      console.warn('[SelectorFinder] validateSelector failed', err);
      return null;
    }
  };

  const runHealthCheck = async ({
    modelName = 'Unknown',
    elementTypes = DEFAULT_ELEMENT_TYPES,
    timeout = DEFAULT_TIMEOUT_MS
  } = {}) => {
    const report = [];
    const targets = Array.isArray(elementTypes) && elementTypes.length ? elementTypes : DEFAULT_ELEMENT_TYPES;
    for (const elementType of targets) {
      try {
        const result = await findOrDetectSelector({ modelName, elementType, timeout, forceDiscovery: false });
        report.push({
          elementType,
          success: !!result,
          selector: result?.selector || null,
          layer: result?.layer || null
        });
      } catch (err) {
        report.push({
          elementType,
          success: false,
          error: err?.message || 'unknown error'
        });
      }
    }
    return report;
  };

  const previewSelector = (selector, label = 'Selector preview') => {
    if (!selector) return false;
    try {
      const element = queryDeep(selector, document);
      if (!ensureValidElement(element)) return false;
      highlightElement(element, `${label}: ${selector}`);
      return true;
    } catch (err) {
      console.warn('[SelectorFinder] previewSelector failed', err);
      return false;
    }
  };

  /**
   * Returns accumulated runtime statistics for diagnostics.
   * @returns {Object} Snapshot of selector finder metrics.
   * @example const stats = SelectorFinder.getStats();
   */
  const getStats = () => ({
    ...stats,
    lastCleanupRun,
    discoveryInProgress: Array.from(discoveryState.keys())
  });

  globalObject.SelectorFinder = {
    findOrDetectSelector,
    waitForElement,
    healthCheck: runHealthCheck,
    clearCache: clearCacheForModel,
    validateSelector,
    previewSelector,
    getStats,
    isElementInteractable
  };
  const waitForSelectorMatch = (selector, { root = document, timeout = 10000 } = {}) => {
    if (!selector || !root) return Promise.resolve(null);
    try {
      const existing = queryDeep(selector, root);
      if (existing) return Promise.resolve(existing);
    } catch (err) {
      console.warn('[SelectorFinder] waitForSelectorMatch initial query failed', selector, err);
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (node) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(node);
      };
      const observer = new MutationObserver(() => {
        try {
          const candidate = queryDeep(selector, root);
          if (candidate) {
            finish(candidate);
          }
        } catch (err) {
          console.warn('[SelectorFinder] waitForSelectorMatch mutation query failed', selector, err);
          finish(null);
        }
      });
      observer.observe(root, { childList: true, subtree: true });
      const timer = setTimeout(() => finish(null), timeout);
    });
  };

  const looksLikeUserEcho = (text, prompt) => {
    if (!prompt || !text) return false;
    const prefix = prompt.slice(0, Math.min(prompt.length, 60)).trim();
    if (!prefix) return false;
    return text.trim().startsWith(prefix);
  };

  const extractTextFromNode = (node, extraction) => {
    if (!node) return '';
    const method = extraction?.method || 'innerText';
    if (method.startsWith('attribute:')) {
      const attr = method.split(':')[1];
      return (node.getAttribute?.(attr) || '').trim();
    }
    if (method === 'innerHTML') {
      return (node.innerHTML || '').trim();
    }
    if (method === 'textContent') {
      return (node.textContent || '').trim();
    }
    // Default innerText strategy
    if (node.tagName === 'ARTICLE') {
      const textContainers = node.querySelectorAll('div[lang], div[dir="auto"]');
      let buf = '';
      textContainers.forEach((n) => {
        const t = (n.innerText || n.textContent || '').trim();
        if (t) {
          if (buf) buf += '\n';
          buf += t;
        }
      });
      if (buf) return buf.trim();
    }
    return (node.innerText || node.textContent || '').trim();
  };

  const computeHash = (value) => {
    if (!value) return 0;
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = ((hash << 5) - hash) + value.charCodeAt(i);
      hash |= 0; // Convert to 32bit integer
    }
    return hash >>> 0; // make non-negative
  };

  const extractFromSelectors = (scope, selectors, extraction, prompt) => {
    if (!scope || !Array.isArray(selectors) || !selectors.length) return null;
    for (const selector of selectors) {
      let nodes = [];
      try {
        nodes = queryDeepAll(selector, scope);
      } catch (err) {
        console.warn('[SelectorFinder] Failed to query selector', selector, err);
        continue;
      }
      for (const node of nodes) {
        const text = extractTextFromNode(node, extraction);
        if (text && !looksLikeUserEcho(text, prompt)) {
          return { text, node, selector };
        }
      }
    }
    return null;
  };

  const checkEndMarkers = (markers) => {
    if (!Array.isArray(markers) || !markers.length) return true;
    const doc = document;
    return markers.every((marker) => {
      if (!marker) return true;
      if (marker.type === 'disappear' && marker.selector) {
        try {
          return !queryDeep(marker.selector, doc);
        } catch (err) {
          console.warn('[SelectorFinder] end marker selector failed', marker.selector, err);
          return false;
        }
      }
      const selector = marker.selector || 'body';
      let node = null;
      try {
        node = queryDeep(selector, doc);
      } catch (err) {
        console.warn('[SelectorFinder] end marker selector invalid', selector, err);
        return false;
      }
      if (!node) return false;
      if (marker.attribute) {
        const attrName = typeof marker.attribute === 'string' ? marker.attribute : marker.attribute?.name;
        if (!attrName) return false;
        const expected = marker.value ?? marker.attribute?.value;
        const actual = node.getAttribute(attrName);
        if (expected === undefined) {
          return actual === null || actual === 'false' || actual === '0' || actual === '';
        }
        if (Array.isArray(expected)) {
          return expected.includes(actual);
        }
        return actual === String(expected);
      }
      if (marker.type === 'text') {
        const textContent = (node.textContent || '').trim();
        if (marker.value === undefined) return textContent.length > 0;
        return textContent.includes(marker.value);
      }
      return true;
    });
  };
  const resolveObservationRoot = async (observationConfig, fallbackScope, timeout) => {
    if (observationConfig?.rootSelector) {
      const root = await waitForSelectorMatch(observationConfig.rootSelector, {
        root: document,
        timeout: Math.min(timeout, 15000)
      });
      if (root) return root;
    }
    if (fallbackScope instanceof Element) return fallbackScope;
    return document;
  };

})();
