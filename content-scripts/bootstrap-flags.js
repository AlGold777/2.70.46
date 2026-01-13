// Initializes global namespace, feature flags, and lightweight telemetry stub for content scripts.
(function() {
  'use strict';

  const globalNS = (typeof window !== 'undefined' ? window : globalThis);
  globalNS.LLMExtension = globalNS.LLMExtension || {};

  const defaultFlags = {
    buildVersion: 'dev',
    selectorV2: false,
    extractorV2: false,
    humanoidV2: false,
    adaptersV2: {}, // per-platform overrides, e.g. { chatgpt: true }
    // v2.54.24 (2025-12-22 23:14 UTC): Verbose diagnostics toggles (Purpose: enable deep logging on demand).
    verboseLogging: false,
    verboseSelectors: false,
    verboseAnswerWatcher: false,
    verboseTelemetry: false
  };

  // Merge existing flags with defaults
  globalNS.LLMExtension.flags = Object.assign({}, defaultFlags, globalNS.LLMExtension.flags || {});

  // Minimal telemetry stub in content scripts; background owns durable storage.
  const telemetry = globalNS.LLMExtension.telemetry || {
    record(metric, value, meta = {}) {
      try {
        console.debug('[telemetry:cs]', metric, value, meta);
      } catch (_) {}
    }
  };
  globalNS.LLMExtension.telemetry = telemetry;

})();
