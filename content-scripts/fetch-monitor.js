(function () {
  const CHANNEL = 'humanoid-fetch-monitor';

  function injectMainWorldHook(modelName) {
    if (!document.documentElement) return;
    try {
      window.__HFM_INIT__ = { channel: CHANNEL, model: modelName };
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('content-scripts/fetch-monitor-bridge.js');
      script.async = false;
      (document.documentElement || document.head || document.body).appendChild(script);
      script.remove();
    } catch (err) {
      console.warn('[fetch-monitor] Failed to inject bridge', err);
    }
  }

  window.setupHumanoidFetchMonitor = function setupHumanoidFetchMonitor(modelName, handler) {
    if (!modelName || typeof handler !== 'function') return;
    const guardKey = `__humanoidFetchBridge_${modelName}`;
    if (window[guardKey]) return;
    window[guardKey] = true;
    injectMainWorldHook(modelName);
    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data || event.data.source !== CHANNEL) return;
      const payload = event.data;
      if (Array.isArray(payload.models) && !payload.models.includes(modelName)) return;
      handler(payload);
    });
  };
})();
