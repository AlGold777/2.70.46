/* Lightweight bootstrap: initializes shared namespaces without altering behavior. */
(function initContentBootstrap() {
  const root = typeof window !== 'undefined' ? window : globalThis;
  root.LLMExtension = root.LLMExtension || {};
  root.SelectorConfig = root.SelectorConfig || {};

  // v2.54.24 (2025-12-22 23:14 UTC): Verbose feature flags (Purpose: toggle deep diagnostics without code changes).
  const defaultFlags = {
    buildVersion: 'dev',
    selectorV2: false,
    extractorV2: false,
    humanoidV2: false,
    adaptersV2: {},
    verboseLogging: false,
    verboseSelectors: false,
    verboseAnswerWatcher: false,
    verboseTelemetry: false
  };
  root.LLMExtension.flags = Object.assign({}, defaultFlags, root.LLMExtension.flags || {});

  // Budgets/Contracts (Embedded Pragmatist v2.0)
  if (!root.__PRAGMATIST_BUDGETS && typeof root.__loadPragmatistBudgets !== 'function') {
    try {
      // Attempt to load shared budgets module if present
      // eslint-disable-next-line global-require, import/no-unresolved
      require?.('../shared/budgets');
    } catch (_) {}
  }

  // Stamp build info once per page
  if (!root.LLMExtension.__bootstrapInfo) {
    root.LLMExtension.__bootstrapInfo = {
      ts: Date.now(),
      source: 'content-bootstrap'
    };
  }

  try {
    chrome?.storage?.local?.onChanged?.addListener((changes, area) => {
      if (area !== 'local') return;
      const payload = changes.kill_switch?.newValue;
      const isAuthorized = payload && typeof payload === 'object' && payload.source === 'background';
      if (isAuthorized) {
        try {
          if (root.humanSessionController?.forceHardStop) {
            root.humanSessionController.forceHardStop('kill-switch');
          } else if (root.humanSessionController?._hardStop) {
            root.humanSessionController._hardStop('kill-switch');
          }
          root.__LLMScrollHardStop = true;
        } catch (_) {}
      }
    });
  } catch (_) {}

  // Main-world bridge (единый для текста и вложений)
  try {
    if (!root.__LLMMainBridgeInjected) {
      root.__LLMMainBridgeInjected = true;
      const s = document.createElement('script');
      s.src = chrome.runtime?.getURL('content-scripts/content-bridge.js');
      s.onload = () => { try { s.remove(); } catch (_) {} };
      (document.documentElement || document.head || document.body).appendChild(s);
    }
  } catch (_) {}
})();
