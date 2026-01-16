(function initHumanoidCleanupRegistry() {
  if (typeof window === 'undefined') return;
  if (window.HumanoidCleanup?.createScope) return;

  const toArray = (iterable) => (Array.isArray(iterable) ? iterable : Array.from(iterable || []));

  function createScope(label = 'default') {
    const intervals = new Set();
    const timeouts = new Set();
    const animationFrames = new Set();
    const observers = new Set();
    const abortControllers = new Set();
    const disposables = new Set();
    const listeners = new Set();
    let cleaned = false;
    let cleanupReason = null;

    const track = (collection, value) => {
      if (value == null) return value;
      collection.add(value);
      return value;
    };

    const forget = (collection, value) => {
      if (value == null) return;
      collection.delete(value);
    };

    const scope = {
      label,
      trackInterval: (id) => track(intervals, id),
      trackTimeout: (id) => track(timeouts, id),
      trackAnimationFrame: (id) => track(animationFrames, id),
      trackObserver: (observer) => {
        if (observer && typeof observer.disconnect === 'function') {
          observers.add(observer);
        }
        return observer;
      },
      trackAbortController: (controller) => {
        if (controller && typeof controller.abort === 'function') {
          abortControllers.add(controller);
        }
        return controller;
      },
      register: (fn) => {
        if (typeof fn !== 'function') return () => {};
        disposables.add(fn);
        return () => disposables.delete(fn);
      },
      addEventListener: (target, event, handler, options) => {
        if (!target?.addEventListener || typeof handler !== 'function') {
          return () => {};
        }
        target.addEventListener(event, handler, options);
        const entry = { target, event, handler, options };
        listeners.add(entry);
        return () => {
          listeners.delete(entry);
          try {
            target.removeEventListener(event, handler, options);
          } catch (_) {}
        };
      },
      isCleaned: () => cleaned,
      getReason: () => cleanupReason,
      cleanup: (reason = 'manual-stop') => {
        if (cleaned) return cleanupReason;
        cleaned = true;
        cleanupReason = reason;
        toArray(intervals).forEach((id) => {
          try { clearInterval(id); } catch (_) {}
        });
        toArray(timeouts).forEach((id) => {
          try { clearTimeout(id); } catch (_) {}
        });
        toArray(animationFrames).forEach((id) => {
          try { cancelAnimationFrame(id); } catch (_) {}
        });
        toArray(observers).forEach((observer) => {
          try { observer.disconnect(); } catch (_) {}
        });
        observers.clear();
        toArray(abortControllers).forEach((controller) => {
          try { controller.abort(reason); } catch (_) {}
        });
        abortControllers.clear();
        toArray(listeners).forEach(({ target, event, handler, options }) => {
          try {
            target.removeEventListener(event, handler, options);
          } catch (_) {}
        });
        listeners.clear();
        toArray(disposables).forEach((fn) => {
          try { fn(reason); } catch (_) {}
        });
        disposables.clear();
        intervals.clear();
        timeouts.clear();
        animationFrames.clear();
        return cleanupReason;
      },
      forgetInterval: (id) => forget(intervals, id),
      forgetTimeout: (id) => forget(timeouts, id),
      forgetAnimationFrame: (id) => forget(animationFrames, id)
    };

    // Convenience helpers to reduce boilerplate in long waits
    scope.setTrackedTimeout = (fn, ms) => {
      const id = setTimeout(fn, ms);
      return scope.trackTimeout(id);
    };
    scope.setTrackedInterval = (fn, ms) => {
      const id = setInterval(fn, ms);
      return scope.trackInterval(id);
    };
    scope.requestTrackedAnimationFrame = (fn) => {
      const id = requestAnimationFrame(fn);
      return scope.trackAnimationFrame(id);
    };
    scope.createTrackedMutationObserver = (callback) => {
      if (typeof MutationObserver === 'undefined') return null;
      const observer = new MutationObserver(callback);
      return scope.trackObserver(observer);
    };
    scope.createTrackedIntersectionObserver = (callback, options) => {
      if (typeof IntersectionObserver === 'undefined') return null;
      const observer = new IntersectionObserver(callback, options);
      return scope.trackObserver(observer);
    };
    scope.observeMutations = (target, options, callback) => {
      const observer = scope.createTrackedMutationObserver(callback);
      if (observer && target) {
        observer.observe(target, options);
      }
      return observer;
    };

    return scope;
  }

  window.HumanoidCleanup = {
    createScope
  };
})();
