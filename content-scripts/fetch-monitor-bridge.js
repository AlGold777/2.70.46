(() => {
  const init = window.__HFM_INIT__;
  if (!init || !init.channel || !init.model) return;
  try { delete window.__HFM_INIT__; } catch (_) {}
  const { channel, model } = init;
  try {
    const globalState = window.__humanoidFetchMonitor = window.__humanoidFetchMonitor || {
      hooked: false,
      models: [],
      record(modelName) {
        if (!this.models.includes(modelName)) this.models.push(modelName);
      }
    };
    globalState.record(model);
    if (globalState.hooked || typeof window.fetch !== 'function') return;
    const originalFetch = window.fetch;
    globalState.hooked = true;
    window.fetch = async (...args) => {
      const requestInfo = args[0];
      const init = args[1] || {};
      const method = init.method || requestInfo?.method || 'GET';
      const url = typeof requestInfo === 'string' ? requestInfo : requestInfo?.url || '';
      const startedAt = Date.now();
      try {
        const response = await originalFetch(...args);
        const status = Number(response?.status) || 0;
        if (status >= 400) {
          let retryAfter = '';
          try {
            retryAfter = response.headers?.get?.('Retry-After') || '';
          } catch (_) {}
          window.postMessage({
            source: channel,
            status,
            method,
            url,
            retryAfter,
            ok: response?.ok ?? true,
            startedAt,
            endedAt: Date.now(),
            models: globalState.models.slice()
          }, '*');
        }
        return response;
      } catch (error) {
        window.postMessage({
          source: channel,
          status: 0,
          method,
          url,
          retryAfter: '',
          error: error?.message || String(error),
          startedAt,
          endedAt: Date.now(),
          models: globalState.models.slice()
        }, '*');
        throw error;
      }
    };
  } catch (_) {
    /* swallow */
  }
})();
