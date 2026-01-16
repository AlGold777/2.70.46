/**
 * UniversalScrollToolkit v2.0 - Production-Ready (Nov 2025)
 * Единый модуль для всех LLM-платформ (GPT, Claude, Gemini, Grok, etc.)
 * Скомпоновано в ES5-совместимом виде для прямой загрузки в content scripts.
 */

// ============================================================================//
// ScrollGatekeeper (hard-stop abort + capture guard)
// ============================================================================//
const __scrollGatekeeper = (() => {
  if (typeof window === 'undefined') return null;
  if (window.__ScrollGatekeeper) return window.__ScrollGatekeeper;

  class ScrollGatekeeper {
    constructor() {
      this.isStopped = false;
      this.abortController = new AbortController();
      this._blocker = (e) => {
        try {
          e.stopImmediatePropagation();
          e.preventDefault();
        } catch (_) {}
      };
    }

    engageHardStop() {
      if (this.isStopped) return;
      this.isStopped = true;
      try { this.abortController.abort(); } catch (_) {}
      this.abortController = new AbortController();
      try {
        window.addEventListener('wheel', this._blocker, { capture: true, passive: false });
        window.addEventListener('scroll', this._blocker, { capture: true, passive: false });
      } catch (_) {}
    }

    release() {
      if (!this.isStopped) return;
      this.isStopped = false;
      try {
        window.removeEventListener('wheel', this._blocker, { capture: true, passive: false });
        window.removeEventListener('scroll', this._blocker, { capture: true, passive: false });
      } catch (_) {}
    }

    async requestScroll(source, fn) {
      if (this.isStopped) return { blocked: true };
      if (typeof document !== 'undefined' && document.hidden && source !== 'vital_heartbeat') {
        return { skipped: 'hidden' };
      }
      try {
        const res = await fn({ signal: this.abortController.signal });
        return res;
      } catch (err) {
        if (err?.name === 'AbortError') {
          return { aborted: true };
        }
        throw err;
      }
    }

    getSignal() {
      return this.abortController?.signal;
    }
  }

  window.__ScrollGatekeeper = new ScrollGatekeeper();
  return window.__ScrollGatekeeper;
})();

// ============================================================================//
// Scroll event hook (for diagnostics/testing)
// ============================================================================//
let __scrollEventHook = null;
function __setScrollEventHook(fn) { __scrollEventHook = typeof fn === 'function' ? fn : null; }
function __emitScrollEvent(origin, delta) {
  if (!__scrollEventHook) return;
  try {
    __scrollEventHook({ origin, delta, ts: Date.now(), stack: (new Error()).stack });
  } catch (_) {}
}

const __scrollToolkitKeepAlive = (() => {
  if (typeof window === 'undefined') return () => {};
  let traceId = null;
  let stopTimer = null;
  const mode = () => (document?.visibilityState === 'hidden' ? 'background' : (window.__humanoidActivityMode || 'interactive'));
  return (meta = {}) => {
    const events = window.HumanoidEvents;
    if (!events) return;
    try {
      if (!traceId && typeof events.start === 'function') {
        traceId = events.start('keep-alive', { mode: mode(), source: 'scroll-toolkit' });
      }
      if (traceId && typeof events.heartbeat === 'function') {
        events.heartbeat(traceId, 0, Object.assign({ action: 'keep-alive-ping', source: 'scroll-toolkit' }, meta));
      }
      if (stopTimer) clearTimeout(stopTimer);
      stopTimer = setTimeout(() => {
        if (traceId && typeof events.stop === 'function') {
          events.stop(traceId, { status: 'idle', source: 'scroll-toolkit' });
        }
        traceId = null;
        stopTimer = null;
      }, 5000);
    } catch (_) {}
  };
})();

// ============================================================================//
// StickyCalculator
// ============================================================================//
class StickyCalculator {
  constructor(maxElements = 50) {
    this.cache = new WeakMap();
    this.maxElements = maxElements;
  }

  async compute(container) {
    const cacheKey = container === window ? document.documentElement : container;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      return { top: cached, bottom: 0 };
    }

    const isWindow = container === window;
    const root = isWindow ? document.documentElement : container;
    const stickies = this._findVisibleSticky(root, isWindow);

    let topOffset = 0;
    let bottomOffset = 0;
    for (const el of stickies.slice(0, this.maxElements)) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.height === 0) continue;
      if (style.position === 'fixed' || style.position === 'sticky') {
        if (rect.top < 100) topOffset = Math.max(topOffset, rect.bottom);
        if (rect.bottom > window.innerHeight - 100) {
          bottomOffset = Math.max(bottomOffset, window.innerHeight - rect.top);
        }
      }
    }

    this.cache.set(cacheKey, topOffset);
    return { top: topOffset, bottom: bottomOffset };
  }

  _findVisibleSticky(root, isWindow) {
    const results = [];
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          if (results.length >= this.maxElements) return NodeFilter.FILTER_REJECT;
          const el = node;
          const style = getComputedStyle(el);
          if (!['fixed', 'sticky'].includes(style.position)) return NodeFilter.FILTER_SKIP;
          const rect = el.getBoundingClientRect();
          if (rect.height === 0 || rect.width === 0) return NodeFilter.FILTER_SKIP;
          if (!isWindow && !this._belongsToContainer(el, root)) return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let node;
    while ((node = walker.nextNode()) && results.length < this.maxElements) {
      results.push(node);
    }
    return results;
  }

  _belongsToContainer(el, container) {
    let parent = el;
    while (parent && parent !== document.body) {
      if (parent === container) return true;
      parent = parent.parentElement;
    }
    return false;
  }

  invalidate(container) {
    if (container) this.cache.delete(container);
    else this.cache = new WeakMap();
  }
}

// ============================================================================//
// SecureTelemetry (opt-in debug batching)
// ============================================================================//
class SecureTelemetry {
  constructor() {
    this.buffer = [];
    this.lastFlush = Date.now();
    this.config = {
      maxBufferSize: 50,
      flushInterval: 60000 // 60s
    };
    this._bindLifecycle();
    this._startTimer();
  }

  isDebug() {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem('__debug_telemetry') === 'true';
    } catch (_) {
      return false;
    }
  }

  sanitize(data) {
    const clean = Object.assign({}, data);
    delete clean.content;
    delete clean.text;
    delete clean.value;
    if (clean.selector && clean.selector.length > 100) {
      clean.selector = `${clean.selector.slice(0, 100)}...`;
    }
    return clean;
  }

  log(event, data) {
    if (!this.isDebug()) return;
    const sanitized = this.sanitize({ event, ts: Date.now(), ...data });
    this.buffer.push(sanitized);
    if (this.buffer.length >= this.config.maxBufferSize) {
      this.flush();
    }
  }

  flush() {
    if (!this.isDebug()) {
      this.buffer = [];
      this.lastFlush = Date.now();
      return;
    }
    if (!this.buffer.length) return;
    try {
      console.debug('[Telemetry][batch]', this.buffer);
      if (typeof chrome !== 'undefined' && chrome.runtime) {
        chrome.runtime.sendMessage({
          type: 'TELEMETRY_BATCH',
          data: this.buffer.slice(),
          sessionId: `telemetry-${this.lastFlush}`
        }).catch(() => {});
      }
    } catch (_) {
      // ignore
    } finally {
      this.buffer = [];
      this.lastFlush = Date.now();
    }
  }

  _bindLifecycle() {
    if (typeof window === 'undefined') return;
    ['pagehide', 'visibilitychange', 'beforeunload'].forEach((evt) => {
      window.addEventListener(evt, () => this.flush(), { passive: true });
    });
  }

  _startTimer() {
    setInterval(() => this.flush(), this.config.flushInterval);
  }
}

const secureTelemetry = new SecureTelemetry();

// ============================================================================//
// ScrollCoordinator - shared SmartScroll orchestrator
// ============================================================================//
class ScrollCoordinator {
  constructor(config = {}) {
    this.config = Object.assign({
      source: 'smart-scroll',
      keepAliveInterval: 2000,
      operationTimeout: 300000,
      logPrefix: '[SmartScroll]',
      getLifecycleMode: () => (document?.visibilityState === 'hidden' ? 'background' : 'interactive'),
      registerForceStopHandler: () => () => {},
      startDrift: () => {},
      stopDrift: () => {},
      emitLog: () => {},
      isScrollAllowed: () => {
        if (typeof window === 'undefined') return true;
        if (__scrollGatekeeper?.isStopped) return false;
        if (window.humanSessionController?.getState?.() === 'HARD_STOP') return false;
        const state = window.__HumanoidSessionState?.state;
        if (state === 'HARD_STOP') return false;
        return !window.__LLMScrollHardStop;
      },
      jitterRange: [1, 5]
    }, config);
  }

  async run(asyncOperation, overrides = {}) {
    const {
      keepAliveInterval = this.config.keepAliveInterval,
      operationTimeout = this.config.operationTimeout,
      debug = false
    } = overrides;

    const log = (...args) => {
      if (debug) {
        console.log(this.config.logPrefix, ...args);
      } else if (typeof this.config.emitLog === 'function') {
        this.config.emitLog(...args);
      }
    };

    const heartbeatSource = this.config.source || 'smart-scroll';
    const events = typeof window !== 'undefined' ? window.HumanoidEvents : null;
    const mode = typeof this.config.getLifecycleMode === 'function'
      ? this.config.getLifecycleMode()
      : (document?.visibilityState === 'hidden' ? 'background' : 'interactive');
    const traceId = events?.start
      ? events.start(heartbeatSource, { mode, keepAliveInterval, timeout: operationTimeout })
      : null;

    let intervalId = null;
    let timeoutId = null;
    let cleaned = false;
    let active = true;
    let unregisterForceStop = null;
    let forceStopReject = null;
    let scrollDirection = 1;
    let scrollAnimating = false;
    // Защитные лимиты для пассивных режимов
    const passiveWindowMs = this.config.passiveWindowMs || 5000;
    const passiveMaxEvents = this.config.passiveMaxEvents || 2;
    const deltaWarnThreshold = this.config.deltaWarnThreshold || 50;
    let jitterWindowStart = Date.now();
    let jitterCount = 0;

    const isScrollAllowed = () => {
      try {
        if (window.__LLMScrollHardStop) return false;
        return this.config.isScrollAllowed();
      } catch (_) {
        return !window.__LLMScrollHardStop;
      }
    };

    const shouldThrottleJitter = (delta) => {
      const now = Date.now();
      if (now - jitterWindowStart > passiveWindowMs) {
        jitterWindowStart = now;
        jitterCount = 0;
      }
      jitterCount += 1;
      if (jitterCount > passiveMaxEvents || Math.abs(delta) > deltaWarnThreshold) {
        const diag = {
          type: 'scroll_jitter_warn',
          origin: 'micro_jitter',
          count: jitterCount,
          delta,
          windowMs: passiveWindowMs,
          stack: (new Error()).stack
        };
        log('diag', diag);
        return true;
      }
      return false;
    };

    const heartbeat = (meta = {}) => {
      if (!traceId || !events?.heartbeat) return;
      try {
        events.heartbeat(traceId, 0, Object.assign({ phase: 'tick', source: heartbeatSource }, meta));
      } catch (_) {}
    };

    const cleanup = (reason = 'success') => {
      if (cleaned) return;
      cleaned = true;
      active = false;
      try { this.config.stopDrift(reason); } catch (_) {}
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (typeof unregisterForceStop === 'function') {
        try { unregisterForceStop(); } catch (_) {}
        unregisterForceStop = null;
      }
      if (traceId && events?.stop) {
        const status = reason === 'force-stop'
          ? 'forced'
          : reason === 'error'
            ? 'error'
            : reason === 'timeout'
              ? 'timeout'
              : 'success';
        try {
          events.stop(traceId, { status, reason, source: heartbeatSource });
        } catch (_) {}
      }
      log('stopped:', reason);
    };

    if (!isScrollAllowed()) {
      log('blocked: scroll not allowed by policy/hard-stop');
      cleanup('blocked_by_policy');
      return Promise.resolve({ blocked: true });
    }

    const smoothDriftTo = (targetY, durationMs = 720) => new Promise((resolve) => {
      const startY = window.scrollY;
      const delta = targetY - startY;
      if (Math.abs(delta) < 1) {
        resolve();
        return;
      }
      const duration = Math.max(400, durationMs + (Math.random() * 240 - 120));
      let startTs = null;
      const ease = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
      const step = (ts) => {
        if (!startTs) startTs = ts;
        const t = Math.min(1, (ts - startTs) / duration);
        const eased = ease(t);
        const nextY = Math.round(startY + delta * eased);
        window.scrollTo({ top: nextY, behavior: 'auto' });
        if (t < 1 && active) {
          requestAnimationFrame(step);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(step);
    });

    const microJitter = () => {
      if (window.__PRAGMATIST_SPEED_MODE) return;
      const [minJitter, maxJitter] = this.config.jitterRange || [1, 5];
      const delta = Math.max(1, Math.random() * (maxJitter - minJitter) + minJitter) * scrollDirection;
      try {
        if (shouldThrottleJitter(delta)) return;
        __emitScrollEvent('micro_jitter', delta);
        window.scrollBy({ top: delta, behavior: 'auto' });
        setTimeout(() => {
          __emitScrollEvent('micro_jitter', -delta);
          window.scrollBy({ top: -delta, behavior: 'auto' });
        }, 50);
        scrollDirection *= -1;
      } catch (err) {
        log('microJitter failed', err);
      }
    };

    const tick = () => {
      if (!active) return;
      if (!isScrollAllowed()) {
        cleanup('blocked_by_policy');
        return;
      }
      if (document.hidden) {
        heartbeat({ phase: 'tick-hidden', scrollY: window.scrollY });
        return; // не трогаем layout, пока вкладка скрыта
      }
      try { this.config.stopDrift('visible'); } catch (_) {}
      microJitter();
      heartbeat({ phase: 'tick-visible', scrollY: window.scrollY });
      log('tick-visible', window.scrollY);
    };

    const timeoutPromise = new Promise((_, rej) => {
      timeoutId = setTimeout(() => {
        const err = new Error(`Timeout ${operationTimeout}ms`);
        err.code = 'smart-scroll-timeout';
        rej(err);
      }, operationTimeout);
    });

    let forceStopPromise = Promise.resolve();
    if (typeof this.config.registerForceStopHandler === 'function') {
      forceStopPromise = new Promise((_, reject) => { forceStopReject = reject; });
      unregisterForceStop = this.config.registerForceStopHandler(() => {
        if (typeof forceStopReject === 'function') {
          const err = new Error('background-force-stop');
          err.code = 'background-force-stop';
          forceStopReject(err);
        }
      });
    }

    try {
      heartbeat({ phase: 'init' });
      intervalId = setInterval(tick, keepAliveInterval);
      const result = await Promise.race([asyncOperation(), timeoutPromise, forceStopPromise]);
      cleanup('success');
      return result;
    } catch (error) {
      if (error?.code === 'background-force-stop') {
        cleanup('force-stop');
      } else if (error?.code === 'smart-scroll-timeout') {
        cleanup('timeout');
      } else {
        cleanup('error');
      }
      throw error;
    } finally {
      cleanup('finalize');
    }
  }
}

const globalRef = typeof globalThis !== 'undefined'
  ? globalThis
  : (typeof window !== 'undefined' ? window : undefined);

if (globalRef) {
  globalRef.ScrollCoordinator = ScrollCoordinator;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScrollCoordinator;
}

// ============================================================================//
// VirtualizationHandler
// ============================================================================//
class VirtualizationHandler {
  async detect(target) {
    const el = target.element === window ? document.documentElement : target.element;
    const fiberCtrl = this._findFiberController(el);
    if (fiberCtrl) return fiberCtrl;
    const domCtrl = this._findDomController(el);
    if (domCtrl) return domCtrl;
    const devtoolsCtrl = this._findDevToolsController();
    if (devtoolsCtrl) return devtoolsCtrl;
    const adapterCtrl = this._findAdapterController(el);
    if (adapterCtrl) return adapterCtrl;
    const globalCtrl = this._findGlobalOrCustomController(el);
    if (globalCtrl) return globalCtrl;
    return null;
  }

  _findFiberController(el) {
    const fiber = this._getFiber(el);
    if (!fiber) return null;
    const checkProps = (props) => {
      if (!props) return null;
      if (props.scrollToItem || props.scrollToIndex || props.scrollToOffset || props.scrollTo) {
        const method = props.scrollToItem || props.scrollToIndex || props.scrollToOffset || props.scrollTo;
        return {
          type: 'fiber',
          scrollToEnd: () => {
            try { method.call(null, Infinity); } catch (_) { method.call(null, 999999); }
          },
          scrollByItems: (count) => {
            if (props.scrollToIndex) {
              const cur = props.overscanStartIndex || props.startIndex || 0;
              props.scrollToIndex(cur + count);
            }
          }
        };
      }
      return null;
    };
    let current = fiber;
    while (current) {
      const props = current.memoizedProps || current.pendingProps;
      const ctrl = checkProps(props);
      if (ctrl) return ctrl;
      current = current.return;
    }
    // fallback: смотрим в owner (родительский fiber с memoizedProps.children)
    current = fiber.return;
    while (current) {
      const props = current.memoizedProps || current.pendingProps;
      if (props && props.children && typeof props.children === 'object') {
        const ctrl = checkProps(props.children.props || props.children);
        if (ctrl) return ctrl;
      }
      current = current.return;
    }
    return null;
  }

  _getFiber(el) {
    for (const key in el) {
      if (key.startsWith('__reactFiber') || key.startsWith('__reactInternalInstance')) {
        return el[key];
      }
    }
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (hook && hook.getFiberRoots) {
      try {
        const roots = Array.from(hook.getFiberRoots(1));
        for (const root of roots) {
          const fiber = this._findFiberByDOMNode(root.current, el);
          if (fiber) return fiber;
        }
      } catch (_) {}
    }
    return null;
  }

  _findFiberByDOMNode(fiber, target) {
    if (!fiber) return null;
    if (fiber.stateNode === target) return fiber;
    let child = fiber.child;
    while (child) {
      const result = this._findFiberByDOMNode(child, target);
      if (result) return result;
      child = child.sibling;
    }
    return null;
  }

  _findDomController(el) {
    if (typeof el.scrollToItem === 'function') {
      return { type: 'dom-api', scrollToEnd: () => el.scrollToItem(Infinity) };
    }
    if (el.dataset && el.dataset.virtualList) {
      const ref = window[el.dataset.virtualList];
      if (ref && typeof ref.scrollToIndex === 'function') {
        return { type: 'dom-api', scrollToEnd: () => ref.scrollToIndex(Infinity) };
      }
    }
    return null;
  }

  _findDevToolsController() {
    const directCandidates = ['listRef', 'virtualListRef', 'scrollerRef'];
    for (const key of directCandidates) {
      const ctrl = this._extractControllerMethods(window[key], key);
      if (ctrl) return ctrl;
    }

    try {
      const keys = Object.getOwnPropertyNames(window).slice(0, 2000);
      for (const key of keys) {
        if (!/[Rr]ef|list|virtual|scroll/i.test(key)) continue;
        const ctrl = this._extractControllerMethods(window[key], key);
        if (ctrl) return ctrl;
      }
    } catch (_) {}
    return null;
  }

  _findAdapterController(el) {
    const doc = (el && el.ownerDocument) || document;

    // React-window / React-virtualized
    const reactWindowContainer = el && el.closest
      ? el.closest('[data-react-window-list],[data-test-id*="react-window"],.ReactVirtualized__Grid')
      : null;
    const reactWindow = reactWindowContainer || doc.querySelector('[data-react-window-list],[data-test-id*="react-window"],.ReactVirtualized__Grid');
    if (reactWindow || window.__REACT_WINDOW__) {
      const targetEl = reactWindow || el;
      return {
        type: 'adapter/react-window',
        element: targetEl,
        scrollToEnd: () => {
          try {
            targetEl.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: 'auto' });
          } catch (_) {
            targetEl.scrollTop = targetEl.scrollHeight || Number.MAX_SAFE_INTEGER;
          }
        }
      };
    }

    // TanStack virtual (data-index pattern)
    const dataIndexNode = doc.querySelector('[data-index]');
    if (dataIndexNode) {
      const container = dataIndexNode.parentElement || el;
      return {
        type: 'adapter/tanstack-virtual',
        element: container,
        scrollToEnd: () => {
          try {
            container.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: 'auto' });
          } catch (_) {
            container.scrollTop = (container.scrollHeight || 0) + 2000;
          }
        }
      };
    }

    // Virtuoso
    const virtuosoNode = doc.querySelector('[data-test-id*="virtuoso"],[class*="virtuoso"]');
    if (virtuosoNode) {
      const scroller = virtuosoNode.querySelector('[data-test-id*="virtuoso-scroller"]') || virtuosoNode;
      return {
        type: 'adapter/virtuoso',
        element: scroller,
        scrollToEnd: () => {
          try {
            scroller.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: 'auto' });
          } catch (_) {
            scroller.scrollTop = (scroller.scrollHeight || 0) + 2000;
          }
        }
      };
    }

    const attrVirtual = doc.querySelector('[data-virtualized],[data-virtual-scroll],[data-virtual-list],[data-recycle-list],[data-infinite-scroll]');
    if (attrVirtual) {
      const container = attrVirtual.closest('[data-scroll-container]') || attrVirtual.parentElement || el;
      return this._buildHeuristicController(container, 'adapter/data-virtual');
    }

    const classVirtual = doc.querySelector('[class*="Virtualized"],[class*="virtualized"],[class*="recycle-list"],[class*="RecycleList"],[class*="InfiniteScroller"],[class*="virtual-scroller"]');
    if (classVirtual) {
      const container = classVirtual.closest('[data-scroll-container]') || classVirtual.parentElement || el;
      return this._buildHeuristicController(container, 'adapter/class-virtual');
    }

    const items = Array.from(doc.querySelectorAll('[data-index],[data-idx],[role="row"],[role="option"]'));
    if (items.length > 20) {
      const heights = new Set(items.slice(0, 80).map((n) => n.getBoundingClientRect().height.toFixed(1)));
      if (heights.size > 0 && heights.size <= 10) {
        const container = items[0].parentElement || el;
        return this._buildHeuristicController(container, 'adapter/heuristic');
      }
    }
    return null;
  }

  _extractControllerMethods(ref, label = 'custom-ref') {
    if (!ref) return null;
    const target = ref.current || ref;
    if (!target) return null;
    const methodMap = [
      { key: 'scrollToItem', invoke: (fn) => fn.call(target, Infinity) },
      { key: 'scrollToIndex', invoke: (fn) => fn.call(target, Infinity) },
      { key: 'scrollToOffset', invoke: (fn) => fn.call(target, Number.MAX_SAFE_INTEGER) },
      { key: 'scrollTo', invoke: (fn) => fn.call(target, Number.MAX_SAFE_INTEGER) },
      { key: 'scrollToRow', invoke: (fn) => fn.call(target, Infinity) }
    ];
    for (const entry of methodMap) {
      const fn = target[entry.key];
      if (typeof fn === 'function') {
        return {
          type: `devtools:${label}`,
          scrollToEnd: () => {
            try { entry.invoke(fn); } catch (_) { fn.call(target, { top: Number.MAX_SAFE_INTEGER }); }
          }
        };
      }
    }
    if (typeof target.scrollTop === 'number' && typeof target.scrollHeight === 'number') {
      return {
        type: `devtools:${label}:element`,
        scrollToEnd: () => {
          target.scrollTop = target.scrollHeight || Number.MAX_SAFE_INTEGER;
        }
      };
    }
    return null;
  }

  _buildHeuristicController(container, type) {
    const targetEl = container || document.documentElement;
    return {
      type,
      element: targetEl,
      scrollToEnd: () => {
        try {
          targetEl.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: 'auto' });
        } catch (_) {
          targetEl.scrollTop = (targetEl.scrollHeight || 0) + 2000;
        }
      }
    };
  }

  _extractControllerMethods(obj) {
    if (!obj) return null;
    if (typeof obj.scrollToIndex === 'function') {
      return { type: 'global', scrollToEnd: () => obj.scrollToIndex(Number.MAX_SAFE_INTEGER) };
    }
    if (typeof obj.scrollToItem === 'function') {
      return { type: 'global', scrollToEnd: () => obj.scrollToItem(Number.MAX_SAFE_INTEGER) };
    }
    if (typeof obj.scrollToBottom === 'function') {
      return { type: 'global', scrollToEnd: () => obj.scrollToBottom() };
    }
    if (typeof obj.scrollTo === 'function') {
      return { type: 'global', scrollToEnd: () => obj.scrollTo({ top: Number.MAX_SAFE_INTEGER }) };
    }
    if (obj.current) {
      return this._extractControllerMethods(obj.current);
    }
    return null;
  }

  _findGlobalOrCustomController(element) {
    const customProps = ['_virtualList', '__vue_app__', '$scroller', 'simplebar', 'lenis', 'locomotive', 'overlayscrollbars'];
    for (const prop of customProps) {
      if (element && element[prop]) {
        const c = this._extractControllerMethods(element[prop]);
        if (c) return c;
      }
    }
    if (element && element.id && window[element.id]) {
      const c = this._extractControllerMethods(window[element.id]);
      if (c) return c;
    }
    return null;
  }
}

// ============================================================================//
// SettlementWatcher
// ============================================================================//
class SettlementWatcher {
  constructor(idleThreshold = 1500) {
    this.idleThreshold = idleThreshold;
    this.abortController = undefined;
  }

  async watch(container, sentinel, maxDuration) {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    let mutations = 0;
    let idleTimer;
    const startTime = Date.now();

    return new Promise((resolve) => {
      const mutationObs = new MutationObserver((muts) => {
        if (signal.aborted) return;
        mutations += muts.length;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => checkSettlement(), this.idleThreshold);
      });
      mutationObs.observe(container, { childList: true, subtree: true, characterData: true });

      let sentinelVisible = false;
      const ioObs = new IntersectionObserver((entries) => {
        if (signal.aborted) return;
        sentinelVisible = entries.some((e) => e.isIntersecting && e.intersectionRatio > 0.5);
      });
      ioObs.observe(sentinel);

      const deadlineTimer = setTimeout(() => {
        cleanup();
        resolve({
          settled: false,
          reason: 'timeout',
          mutations,
          sentinelVisible,
          duration: Date.now() - startTime
        });
      }, maxDuration);

      const checkSettlement = () => {
        if (signal.aborted) return;
        if (sentinelVisible) {
          cleanup();
          resolve({
            settled: true,
            reason: 'idle+sentinel',
            mutations,
            sentinelVisible: true,
            duration: Date.now() - startTime
          });
        }
      };

      const cleanup = () => {
        mutationObs.disconnect();
        ioObs.disconnect();
        clearTimeout(idleTimer);
        clearTimeout(deadlineTimer);
      };

      signal.addEventListener('abort', () => {
        cleanup();
        resolve({
          settled: false,
          reason: 'manual-abort',
          mutations,
          sentinelVisible,
          duration: Date.now() - startTime
        });
      });

      idleTimer = setTimeout(checkSettlement, this.idleThreshold);
    });
  }

  abort() {
    this.abortController && this.abortController.abort();
  }
}

// ============================================================================//
// DriftEngine
// ============================================================================//
class DriftEngine {
  constructor(stepMs = 50, emitWheel = true) {
    this.stepMs = stepMs;
    this.emitWheel = emitWheel;
    this.abortController = undefined;
  }

  async scrollTo(target, targetY, stickyOffset = 0) {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const el = target.element === window ? window : target.element;
    const getCurrentScroll = () => (el === window ? window.scrollY : el.scrollTop);
    const setScroll = (y) => {
      if (el === window) window.scrollTo(0, y);
      else el.scrollTop = y;
    };

    const start = getCurrentScroll();
    const end = Math.max(0, targetY - stickyOffset);
    const distance = end - start;
    if (Math.abs(distance) < 10) return;

    const startTime = performance.now();
    const duration = Math.min(Math.abs(distance) * 0.5, 2000);

    return new Promise((resolve) => {
      const animate = (currentTime) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 3) / 2;

        const current = start + distance * eased;
        setScroll(current);

        if (this.emitWheel && elapsed % 100 < this.stepMs) {
          const wheelEvent = new WheelEvent('wheel', {
            deltaY: distance > 0 ? 120 : -120,
            deltaMode: 0,
            bubbles: true,
            cancelable: true
          });
          const targetEl = el === window ? document.documentElement : el;
          targetEl.dispatchEvent(wheelEvent);
        }

        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(animate);
    });
  }

  abort() {
    this.abortController && this.abortController.abort();
  }
}

// ============================================================================//
// ContainerDetector
// ============================================================================//
class ContainerDetector {
  constructor(config = {}) {
    this.config = {
      maxShadowDepth: typeof config.maxShadowDepth === 'number' ? config.maxShadowDepth : 5,
      maxIframeDepth: typeof config.maxIframeDepth === 'number' ? config.maxIframeDepth : 2,
      logBreadcrumbs: config.logBreadcrumbs !== false
    };
    this.answerSelectors = [
      '[data-testid=\"conversation-turn\"]',
      'main article',
      'article',
      '[class*=\"response\"]',
      '.chat-message',
      '.prose',
      '.answer',
      '.assistant-message'
    ];
  }

  _findRecentAnswer() {
    const nodes = Array.from(document.querySelectorAll(this.answerSelectors.join(',')))
      .filter((el) => (el.innerText || el.textContent || '').trim().length > 20);
    return nodes.length ? nodes[nodes.length - 1] : null;
  }

  _collectShadowScrollable(root, depth = 0, maxDepth = this.config.maxShadowDepth || 5, acc = []) {
    if (!root || depth > maxDepth) return;
    const list = root.querySelectorAll('*');
    list.forEach((el) => {
      if (this._isScrollable(el)) {
        acc.push({
          element: el,
          type: 'container',
          selector: 'shadow-scrollable',
          isVirtualized: this._hasVirtualHints(el)
        });
      }
      if (el.shadowRoot) {
        this._collectShadowScrollable(el.shadowRoot, depth + 1, maxDepth, acc);
      }
    });
    return acc;
  }

  findScrollable(hint) {
    const candidates = [];

    const seed = hint || this._findRecentAnswer();

    const tryPush = (el, selectorHint) => {
      candidates.push({
        element: el,
        type: el === window ? 'window' : 'container',
        selector: selectorHint || this._getSelector(el),
        isVirtualized: this._hasVirtualHints(el)
      });
    };

    // 1) От seed вверх по родителям
    if (seed) {
      let parent = seed instanceof Element ? seed : null;
      let depth = 0;
      while (parent && parent !== document.body && depth < 8) {
        if (this._isScrollable(parent) && parent.contains(seed)) {
          tryPush(parent);
        }
        parent = parent.parentElement;
        depth += 1;
      }
    }

    // 2) ShadowRoot shallow scan вокруг seed
    if (seed && seed.getRootNode && seed.getRootNode() instanceof ShadowRoot) {
      const host = seed.getRootNode().host;
      if (host && this._isScrollable(host)) {
        tryPush(host, 'shadow-host');
      }
      if (host && host.parentElement && this._isScrollable(host.parentElement)) {
        tryPush(host.parentElement, 'shadow-host-parent');
      }
      this._collectShadowScrollable(seed.getRootNode(), 0, Math.min(1, this.config.maxShadowDepth), candidates);
    }

    // 3) Известные селекторы
    const knownSelectors = [
      'main[class*=\"conversation\"]',
      'div[class*=\"thread\"]',
      'div[class*=\"messages\"]',
      '[role=\"main\"]',
      'div.overflow-y-auto',
      'div.overflow-y-scroll'
    ];

    for (const sel of knownSelectors) {
      document.querySelectorAll(sel).forEach((el) => {
        if (this._isScrollable(el)) {
          tryPush(el, sel);
        }
      });
    }

    // 3.1) Глобальный shadow scan документа (shallow)
    this._collectShadowScrollable(document, 0, Math.min(2, this.config.maxShadowDepth), candidates);

    this._scanIframeDocuments(document, 0, this.config.maxIframeDepth || 2, candidates, 'document');

    if (!candidates.length) {
      tryPush(window, 'window');
    }
    return candidates;
  }

  _scanIframeDocuments(doc, depth, maxDepth, acc, breadcrumb) {
    if (!doc || depth > maxDepth) return;
    const frames = doc.querySelectorAll('iframe');
    frames.forEach((frame, index) => {
      const label = `${breadcrumb}>iframe[${index}]`;
      try {
        const frameDoc = frame.contentWindow?.document;
        if (!frameDoc || !frameDoc.body) return;
        const scrollEl = frameDoc.scrollingElement || frameDoc.documentElement;
        if (scrollEl && this._isScrollable(scrollEl)) {
          acc.push({
            element: scrollEl,
            type: 'container',
            selector: label,
            isVirtualized: this._hasVirtualHints(scrollEl)
          });
        }
        const nextDepth = depth + 1;
        if (nextDepth > maxDepth) {
          if (this.config.logBreadcrumbs) {
            console.warn(`[ContainerDetector] iframe depth limit reached at ${label}`);
          }
          return;
        }
        const shadowDepth = Math.min(this.config.maxShadowDepth || 5, nextDepth + 1);
        this._collectShadowScrollable(frameDoc, 0, shadowDepth, acc);
        this._scanIframeDocuments(frameDoc, nextDepth, maxDepth, acc, label);
      } catch (err) {
        const message = String(err?.message || '');
        const isCrossOrigin =
          err?.name === 'SecurityError' ||
          message.includes('Blocked a frame with origin') ||
          message.toLowerCase().includes('cross-origin');
        if (isCrossOrigin) return;
        if (this.config.logBreadcrumbs) {
          console.warn(`[ContainerDetector] iframe traversal blocked at ${label}`, err);
        }
      }
    });
  }

  _isScrollable(el) {
    const style = getComputedStyle(el);
    const hasOverflow = ['auto', 'scroll'].includes(style.overflowY);
    const hasContent = el.scrollHeight > el.clientHeight + 10;
    return hasOverflow && hasContent;
  }

  _hasVirtualHints(el) {
    const classList = el.className || '';
    const patterns = ['virtual', 'react-window', 'virtuoso', 'infinite-scroll'];
    return patterns.some((p) => classList.includes(p));
  }

  _getSelector(el) {
    if (el.id) return `#${el.id}`;
    if (el.className) return `${el.tagName.toLowerCase()}.${(el.className || '').split(' ')[0]}`;
    return el.tagName.toLowerCase();
  }
}

// ============================================================================//
// MetricsCollector
// ============================================================================//
class MetricsCollector {
  constructor() {
    this.entries = [];
  }

  startSession() {
    return {
      sessionId: `scroll-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: Date.now(),
      target: { selector: '', type: '', scrollHeight: 0, clientHeight: 0 },
      sticky: { offsetTop: 0, offsetBottom: 0, elementsFound: 0 },
      virtual: { detected: false, attempts: 0 },
      settlement: { settled: false, reason: 'timeout', mutations: 0, sentinelVisible: false, duration: 0 },
      performance: { scanDurationMs: 0, scrollDurationMs: 0, totalDurationMs: 0 }
    };
  }

  async flush(entry) {
    this.entries.push(entry);
    secureTelemetry.log('scroll', entry);
    console.info(
      `[ScrollToolkit] ${entry.sessionId}: ${entry.settlement.settled ? '✓' : '✗'} ` +
      `${entry.performance.totalDurationMs}ms (${entry.settlement.reason})`
    );
  }

  getEntries() {
    return this.entries.slice();
  }
}

// ============================================================================//
// UniversalScrollToolkit
// ============================================================================//
class UniversalScrollToolkit {
  constructor(config = {}) {
    this.config = Object.assign({
      maxDuration: 30000,
      idleThreshold: 1500,
      maxStickyElements: 50,
      maxShadowDepth: 6,
      maxIframeDepth: 3,
      virtualRetries: 5,
      driftStepMs: 50,
      sentinelMargin: 100,
      wheelEventDelta: 120,
      logLevel: 'info',
      logBreadcrumbs: true
    }, config);

    this.containerDetector = new ContainerDetector({
      maxShadowDepth: this.config.maxShadowDepth,
      maxIframeDepth: this.config.maxIframeDepth,
      logBreadcrumbs: this.config.logBreadcrumbs
    });
    this.stickyCalc = new StickyCalculator(this.config.maxStickyElements);
    this.virtualHandler = new VirtualizationHandler();
    this.metrics = new MetricsCollector();
  }

  async scrollToBottom(options = {}) {
    const session = this.metrics.startSession();
    const startTime = performance.now();
    try {
      const scanStart = performance.now();
      const candidates = this.containerDetector.findScrollable(options.targetNode);
      const container = candidates[0];
      if (!container) throw new Error('No scrollable container found');

      session.target = {
        selector: container.selector || 'window',
        type: container.type,
        scrollHeight: this._getScrollHeight(container.element),
        clientHeight: this._getClientHeight(container.element)
      };
      session.performance.scanDurationMs = performance.now() - scanStart;

      const virtualCtrl = await this.virtualHandler.detect(container);
      session.virtual.detected = !!virtualCtrl;
      if (virtualCtrl) {
        session.virtual.method = virtualCtrl.type;
        return await this._handleVirtualized(container, virtualCtrl, session);
      }
      return await this._classicScroll(container, session);
    } catch (err) {
      console.error('[ScrollToolkit] Error:', err);
      return false;
    } finally {
      session.performance.totalDurationMs = performance.now() - startTime;
      await this.metrics.flush(session);
    }
  }

  async _handleVirtualized(container, ctrl, session) {
    const scrollStart = performance.now();
    const targetContainer = ctrl.element
      ? { element: ctrl.element, type: ctrl.element === window ? 'window' : 'container', isVirtualized: true }
      : container;
    try {
      await ctrl.scrollToEnd();
      await this._wait(300);
    } catch (e) {
      console.warn('[ScrollToolkit] Virtual API failed:', e);
    }

    const sentinel = this._injectSentinel(targetContainer);
    let visible = false;
    for (let i = 0; i < this.config.virtualRetries; i++) {
      session.virtual.attempts++;
      visible = this._isSentinelVisible(sentinel);
      if (visible) break;
      const drift = new DriftEngine(this.config.driftStepMs);
      const el = targetContainer.element === window ? window : targetContainer.element;
      const current = el === window ? window.scrollY : el.scrollTop;
      await drift.scrollTo(targetContainer, current + 500, 0);
      await this._wait(200);
    }
    this._removeSentinel(sentinel);
    session.settlement = {
      settled: visible,
      reason: visible ? 'idle+sentinel' : 'timeout',
      mutations: 0,
      sentinelVisible: visible,
      duration: performance.now() - scrollStart
    };
    session.performance.scrollDurationMs = performance.now() - scrollStart;
    return visible;
  }

  async _classicScroll(container, session) {
    const scrollStart = performance.now();
    const el = container.element === window ? window : container.element;
    const stickyOffsets = await this.stickyCalc.compute(el);
    session.sticky.offsetTop = stickyOffsets.top;
    session.sticky.offsetBottom = stickyOffsets.bottom;

    const scrollHeight = this._getScrollHeight(el);
    const clientHeight = this._getClientHeight(el);
    const targetY = scrollHeight - clientHeight;

    const sentinel = this._injectSentinel(container);
    const drift = new DriftEngine(this.config.driftStepMs);
    await drift.scrollTo(container, targetY, stickyOffsets.top);

    const containerEl = el === window ? document.documentElement : el;
    const watcher = new SettlementWatcher(this.config.idleThreshold);
    const result = await watcher.watch(containerEl, sentinel, this.config.maxDuration);
    this._removeSentinel(sentinel);

    session.settlement = result;
    session.performance.scrollDurationMs = performance.now() - scrollStart;
    return result.settled;
  }

  _injectSentinel(container) {
    const sentinel = document.createElement('div');
    sentinel.id = `scroll-sentinel-${Date.now()}`;
    sentinel.style.cssText = `
      position: absolute;
      bottom: ${this.config.sentinelMargin}px;
      height: 1px;
      width: 1px;
      pointer-events: none;
      opacity: 0;
    `;
    const target = container.type === 'window' ? document.body : container.element;
    target.appendChild(sentinel);
    return sentinel;
  }

  _isSentinelVisible(sentinel) {
    const rect = sentinel.getBoundingClientRect();
    return rect.top >= 0 && rect.top <= window.innerHeight;
  }

  _removeSentinel(sentinel) {
    if (sentinel && sentinel.parentNode) sentinel.parentNode.removeChild(sentinel);
  }

  _getScrollHeight(el) {
    return el === window ? document.documentElement.scrollHeight : el.scrollHeight;
  }

  _getClientHeight(el) {
    return el === window ? window.innerHeight : el.clientHeight;
  }

  _wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async driftStep(distance = 20) {
    const drift = new DriftEngine(this.config.driftStepMs, false);
    await drift.scrollTo(
      { element: window, type: 'window', isVirtualized: false },
      window.scrollY + distance,
      0
    );
  }

  async scrollElementIntoView(element, options = {}) {
    if (!element || !(element instanceof Element)) return false;
    const container = this.containerDetector.findScrollable(element)[0] || { element: window, type: 'window', isVirtualized: false };
    const el = container.element === window ? window : container.element;
    const stickyOffsets = await this.stickyCalc.compute(el);
    const rect = element.getBoundingClientRect();
    const current = el === window ? window.scrollY : el.scrollTop;
    const targetY = current + rect.top - (options.offset || (stickyOffsets.top + 12));
    const drift = new DriftEngine(this.config.driftStepMs, true);
    await drift.scrollTo(container, targetY, stickyOffsets.top);
    if (options.settle) {
      await this.waitForSettlement(container, { maxDuration: options.maxDuration || 5000 });
    }
    return true;
  }

  async humanScrollBy(distance, options = {}) {
    const container = this.containerDetector.findScrollable(options.targetNode)[0] || { element: window, type: 'window', isVirtualized: false };
    const el = container.element === window ? window : container.element;
    const stickyOffsets = await this.stickyCalc.compute(el);
    const jitter = options.jitter ? ((Math.random() - 0.5) * Math.abs(distance) * 0.15) : 0;
    const totalDistance = distance + jitter;
    const base = el === window ? window.scrollY : el.scrollTop;
    const drift = new DriftEngine(this.config.driftStepMs, true);
    await drift.scrollTo(container, base + totalDistance, stickyOffsets.top);
    if (options.settle !== false) {
      await this.waitForSettlement(container, { maxDuration: options.settleTimeout || Math.min(this.config.maxDuration, 8000) });
    }
    return true;
  }

  async waitForSettlement(container, opts = {}) {
    const target = container || this.containerDetector.findScrollable(opts.targetNode)[0] || { element: window, type: 'window', isVirtualized: false };
    const targetEl = target.element === window ? document.documentElement : target.element;
    const sentinel = this._injectSentinel(target);
    const watcher = new SettlementWatcher(opts.idleThreshold || this.config.idleThreshold);
    const result = await watcher.watch(targetEl, sentinel, opts.maxDuration || Math.min(this.config.maxDuration, 8000));
    this._removeSentinel(sentinel);
    return result;
  }

  /**
   * Anti-sleep tick с событийным watcher: если sentinel уже виден и нет мутаций — скролл не делаем.
   */
  async keepAliveTick(distance = 16) {
    const target = { element: window, type: 'window', isVirtualized: false };
    __scrollToolkitKeepAlive({ phase: 'watcher-start', distance });
    const sentinel = this._injectSentinel(target);
    const watcher = new SettlementWatcher(Math.min(this.config.idleThreshold, 800));
    const containerEl = document.documentElement;
    const result = await watcher.watch(containerEl, sentinel, 4000);
    if (!result.settled) {
      const drift = new DriftEngine(this.config.driftStepMs, false);
      await drift.scrollTo(target, window.scrollY + distance, 0);
      __scrollToolkitKeepAlive({ phase: 'drift', distance });
    } else {
      __scrollToolkitKeepAlive({ phase: 'watcher-stable', distance: 0 });
    }
    this._removeSentinel(sentinel);
    return result;
  }

  invalidateCache() {
    this.stickyCalc.invalidate();
  }

  // For tests/diagnostics: manual micro-jitter tick with event hook
  _testMicroJitter() {
    try {
      if (window.__LLMScrollHardStop) return;
      if (window.__PRAGMATIST_SPEED_MODE) return;
      __emitScrollEvent('micro_jitter', 1);
      window.scrollBy({ top: 1, behavior: 'auto' });
      __emitScrollEvent('micro_jitter', -1);
      window.scrollBy({ top: -1, behavior: 'auto' });
    } catch (_) {}
  }
}

if (typeof window !== 'undefined') {
  window.__UniversalScrollToolkit = UniversalScrollToolkit;
  window.__setScrollEventHook = __setScrollEventHook;
}
