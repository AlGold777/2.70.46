/* Finder-lite: facade over PLATFORM_SELECTORS with optional overrides (no behavior change unless overrides set). */
(function initSelectorFinderLite() {
  if (window.SelectorFinderLite) return;
  const bundle = window.AnswerPipelineSelectors;
  if (!bundle?.PLATFORM_SELECTORS) return;

  const getOverrides = () => {
    try {
      return window.SelectorConfig?.overrides || {};
    } catch (_) {
      return {};
    }
  };

  function mergeSelectors(base = {}, override = {}) {
    const result = Object.assign({}, base);
    Object.keys(override).forEach((key) => {
      if (Array.isArray(override[key])) {
        result[key] = override[key].slice();
      } else if (override[key]) {
        result[key] = override[key];
      }
    });
    return result;
  }

  function getSelectors(platform) {
    const normalized = (platform || '').toLowerCase() || 'generic';
    const base = bundle.PLATFORM_SELECTORS[normalized] || bundle.PLATFORM_SELECTORS.generic || {};
    const overrides = getOverrides()[normalized] || {};
    return mergeSelectors(base, overrides);
  }

  window.SelectorFinderLite = {
    getSelectors
  };
})(); 
