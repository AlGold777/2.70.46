/* Lightweight selector metrics logger (no behavior change unless consumed). */
(function initSelectorMetrics() {
  if (window.SelectorMetrics) return;

  const counters = {};
  const key = (platform, type, status) => `${platform || 'generic'}:${type}:${status}`;

  function record(platform, type, status) {
    const k = key(platform, type, status);
    counters[k] = (counters[k] || 0) + 1;
    try {
      const telemetry = window.LLMExtension?.telemetry;
      telemetry?.record?.('selector_metric', counters[k], { platform, type, status });
    } catch (_) {}
  }

  function getAll() {
    return Object.assign({}, counters);
  }

  window.SelectorMetrics = { record, getAll };
})(); 
