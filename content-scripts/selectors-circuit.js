/* Soft circuit breaker for selectors (session-scoped, optional). */
(function initSelectorCircuit() {
  if (window.SelectorCircuit) return;

  const STORAGE_KEY = '__selectorCircuit';

  const load = () => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  };

  const save = (state) => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
  };

  const getConfig = () => {
    try {
      const cfg = window.SelectorConfig?.circuitBreaker || {};
      return Object.assign({ enabled: true, threshold: 3 }, cfg);
    } catch (_) {
      return { enabled: true, threshold: 3 };
    }
  };

  function shouldUse(selector, platform, type) {
    const cfg = getConfig();
    if (!cfg.enabled) return true;
    const state = load();
    const key = `${platform || 'generic'}:${type || 'generic'}:${selector}`;
    const entry = state[key];
    if (!entry) return true;
    if (entry.disabled) return false;
    return true;
  }

  function report(selector, platform, type, success) {
    const cfg = getConfig();
    if (!cfg.enabled) return;
    const threshold = typeof cfg.threshold === 'number' ? cfg.threshold : 3;
    const state = load();
    const key = `${platform || 'generic'}:${type || 'generic'}:${selector}`;
    const entry = state[key] || { fails: 0, disabled: false };
    if (success) {
      entry.fails = 0;
      entry.disabled = false;
    } else {
      entry.fails += 1;
      if (entry.fails >= threshold) {
        entry.disabled = true;
      }
    }
    state[key] = entry;
    save(state);
  }

  window.SelectorCircuit = { shouldUse, report };
})();
