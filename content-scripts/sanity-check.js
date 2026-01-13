/* eslint-disable no-console */

(function initSanityCheck() {
  const namespace = window.AnswerPipeline = window.AnswerPipeline || {};
  if (namespace.SanityCheck) return;

  const Config = window.AnswerPipelineConfig;
  if (!Config) {
    console.warn('[SanityCheck] Missing AnswerPipelineConfig');
    return;
  }

  class SanityCheck {
    constructor(customConfig = {}) {
      this.config = Object.assign({}, Config.finalization?.sanityCheck || {}, customConfig);
      this.channelAvailable = typeof chrome !== 'undefined' && !!chrome.runtime?.sendMessage;
    }

    async execute(pipelineResult = {}) {
      if (!this.config.enabled) {
        return { ok: true, warnings: [], overallConfidence: 1 }; 
      }

      const warnings = [];
      const answerResult = pipelineResult.answerResult || {};
      const scrollResult = pipelineResult.scrollResult || {};
      const answerText = pipelineResult.answer || '';
      const context = {
        llmName: pipelineResult.llmName || this.config.llmName || pipelineResult.platform || 'unknown',
        platform: pipelineResult.platform || this.config.platform || 'generic',
        answerLength: answerText.length
      };

      if (this.config.warnOnHardTimeout && answerResult.reason === 'hard_timeout') {
        warnings.push({
          type: 'hard_timeout',
          message: 'Answer may be incomplete (hard timeout reached)',
          confidence: 0.6,
          severity: 'high'
        });
      }

      if (this.config.warnOnActiveIndicators && answerResult.indicators?.streaming) {
        warnings.push({
          type: 'streaming_active',
          message: 'Streaming indicators still active at completion',
          confidence: 0.5,
          severity: 'medium'
        });
      }

      const recentGrowth = answerResult.scrollGrowthInLast2s || 0;
      if (recentGrowth > (this.config.recentGrowthThreshold || 10)) {
        warnings.push({
          type: 'content_growing',
          message: `Scroll height still increasing (+${recentGrowth}px)`,
          confidence: 0.7,
          severity: 'medium'
        });
      }

      if (answerText.length && answerText.length < 50) {
        warnings.push({
          type: 'short_answer',
          message: `Answer is very short (${answerText.length} chars)`,
          confidence: 0.8,
          severity: 'low'
        });
      }

      if (scrollResult.reason === 'timeout') {
        warnings.push({
          type: 'scroll_timeout',
          message: 'Scroll settlement timed out',
          confidence: 0.75,
          severity: 'medium'
        });
      }

      const overallConfidence = this.calculateConfidence(warnings);
      if (warnings.length) {
        this.emitDiagnostics(warnings, context);
      }
      return {
        ok: warnings.length === 0,
        warnings,
        overallConfidence
      };
    }

    calculateConfidence(warnings) {
      if (!warnings.length) return 1;
      const minConfidence = Math.min(...warnings.map((w) => w.confidence));
      const penalty = warnings.length * 0.05;
      return Math.max(0.3, minConfidence - penalty);
    }

    emitDiagnostics(warnings, context) {
      if (!this.channelAvailable) return;
      warnings.forEach((warning) => {
        try {
          chrome.runtime.sendMessage({
            type: 'LLM_DIAGNOSTIC_EVENT',
            llmName: context.llmName,
            event: {
              ts: Date.now(),
              type: 'SANITY_WARNING',
              label: `[${context.platform}] ${warning.message}`,
              details: warning.message,
              level: warning.severity === 'high' ? 'warning' : 'info',
              meta: {
                warningType: warning.type,
                confidence: warning.confidence,
                severity: warning.severity,
                platform: context.platform,
                answerLength: context.answerLength
              }
            }
          });
        } catch (_) {
          /* noop */
        }
      });
    }
  }

  namespace.SanityCheck = SanityCheck;
})();
