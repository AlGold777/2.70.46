(function initAnswerPipelineConfig() {
  if (window.AnswerPipelineConfig) return;

  const CONFIG = {
    preparation: {
      tabActivationTimeout: 3000,
      allowTabActivation: false,
      streamStartTimeout: 30000,
      streamStartPollInterval: 100
    },
    streaming: {
      coordinationMode: 'balanced',
      platformOverrides: {
        chatgpt: {
          maintenanceScroll: { enabled: false },
          continuousActivity: { enabled: false },
          initialScrollKick: { enabled: true, delay: 1000 }
        }
      },
      adaptiveTimeout: {
        short: { maxChars: 500, timeout: 20000 },
        medium: { maxChars: 2000, timeout: 45000 },
        long: { maxChars: 5000, timeout: 90000 },
        veryLong: { maxChars: Infinity, timeout: 180000 },
        softExtension: 30000,
        hardMax: 180000
      },
      intelligentRetry: {
        enabled: true,
        maxRetries: 5,
        backoffSequence: [300, 600, 1200, 2000, 2000],
        noGrowthThreshold: 2
      },
      initialScrollKick: {
        enabled: true,
        delay: 0
      },
      settlementWatcher: {
        idleThreshold: 2000,
        maxDuration: 45000
      },
      completionCriteria: {
        completionSignalEnabled: true,
        mutationIdle: 3000,
        scrollStable: 4000,
        contentStable: 3000,
        contentStableChecks: 3,
        contentStableDelta: 5,
        minMetCriteria: 3,
        stopButtonCheckMode: 'fresh',
        stopButtonCacheMaxAgeMs: 3000,
        checkInterval: 1000
      },
      // v2.54.24 (2025-12-22 23:14 UTC): Verbose criteria logging (Purpose: toggle detailed completion logs).
      verboseCriteria: true,
      continuousActivity: {
        enabled: true,
        interval: 5000,
        scrollRange: [50, 200],
        pauseBetweenMoves: 3000
      },
      maintenanceScroll: {
        enabled: true,
        checkInterval: 3000,
        growthThreshold: 50,
        scrollStep: 120,
        idleThreshold: 5000,
        maxDuration: 20000
      }
    },
    finalization: {
      stabilityChecks: 3,
      stabilityInterval: 2000,
      sanityCheck: {
        enabled: true,
        warnOnHardTimeout: true,
        warnOnActiveIndicators: true,
        recentGrowthWindow: 2000,
        recentGrowthThreshold: 10
      }
    },
    telemetry: {
      enabled: true,
      useTraceId: true,
      sendToBackground: true,
      consoleLog: false,
      sessionStorage: false,
      sessionStorageKey: '__answer_pipeline_telemetry'
    },
    platforms: {
      deepseek: {
        preparation: { streamStartTimeout: 45000 }
      },
      perplexity: {
        preparation: { streamStartTimeout: 20000 }
      }
    }
  };

  window.AnswerPipelineConfig = CONFIG;
})();
