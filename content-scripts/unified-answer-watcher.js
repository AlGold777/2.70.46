/* eslint-disable no-console */

(function initUnifiedAnswerWatcher() {
  const namespace = window.AnswerPipeline = window.AnswerPipeline || {};
  if (namespace.UnifiedAnswerCompletionWatcher) return;

  const Modules = window.UnifiedPipelineModules;
  const Config = window.AnswerPipelineConfig;
  const SelectorBundle = window.AnswerPipelineSelectors;
  if (!Modules || !Config || !SelectorBundle) {
    console.warn('[AnswerWatcher] Missing dependencies (modules/config/selectors)');
    return;
  }

  const { PLATFORM_SELECTORS, detectPlatform } = SelectorBundle;
  const {
    UniversalCompletionCriteria,
    AdaptiveTimeoutManager
  } = Modules;

  // v2.54.24 (2025-12-22 23:14 UTC): Verbose flags for completion watcher (Purpose: enable detailed criteria logging).
  const readFlag = (key) => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return null;
      return raw === 'true' || raw === '1';
    } catch (_) {
      return null;
    }
  };

  const resolveVerboseCriteria = (options = {}) => {
    if (typeof options.verboseCriteria === 'boolean') return options.verboseCriteria;
    const flags = window.LLMExtension?.flags || {};
    if (typeof flags.verboseAnswerWatcher === 'boolean') return flags.verboseAnswerWatcher;
    if (typeof flags.verboseLogging === 'boolean') return flags.verboseLogging;
    const storageFlag = readFlag('__verbose_answer_watcher');
    return storageFlag === null ? false : storageFlag;
  };

  class UnifiedAnswerCompletionWatcher {
    constructor(platform, options = {}) {
      this.platform = platform || detectPlatform?.() || 'generic';
      this.selectors = PLATFORM_SELECTORS[this.platform] || PLATFORM_SELECTORS.generic || {};
      const completionConfig = Object.assign({}, Config.streaming?.completionCriteria || {}, options.completionCriteria || {});
      const adaptiveConfig = Object.assign({}, Config.streaming?.adaptiveTimeout || {}, options.adaptiveTimeout || {});
      this.humanSession = options.humanSession || null;
      this.criteria = new UniversalCompletionCriteria(completionConfig);
      this.timeoutManager = new AdaptiveTimeoutManager(adaptiveConfig);
      this.checkInterval = completionConfig.checkInterval || 1000;
      this.minMetCriteria = completionConfig.minMetCriteria || 4;
      this.stopButtonCheckMode = completionConfig.stopButtonCheckMode || 'cached';
      this.stopButtonCacheMaxAgeMs = Number(completionConfig.stopButtonCacheMaxAgeMs) || this.checkInterval;
      this.options = options;
      this.llmName = options.llmName || null;
      this.verboseCriteria = resolveVerboseCriteria(options);
      this.scrollHeightHistory = [];
      this.invalidSelectors = new Set();
      this.lastStopVisible = false;
      this.lastStopVisibleAt = 0;
      this.stopSeenAt = 0;
      this.stopDisappearedAt = 0;
      this.lastCriteriaLogKey = '';
      this.lastStopSelector = null;
      this.lastStopSelectorAttempt = null;
      this.lastRegenerateSelector = null;
      this.lastRegenerateSelectorAttempt = null;
      this.autoDiscoveredSelectors = this.initAutoDiscoveredSelectors();
      this.autoDiscoveryInFlight = new Set();
      this.contentStableStreak = 0;
      this.fingerprintStableStreak = 0;
      this.lastFingerprint = '';
      this.fingerprintStable = false;
      this.latestContentLength = 0;
      this.scoreThreshold = completionConfig.scoring?.threshold || 0.6;
      this.scoreWeights = Object.assign({
        typingGone: 0.4,
        contentStable: 0.3,
        mutationIdle: 0.2,
        scrollStable: 0.05,
        sentinelVisible: 0.05
      }, completionConfig.scoring?.weights || {});
      this.fingerprintBonus = typeof completionConfig.scoring?.fingerprintBonus === 'number'
        ? completionConfig.scoring.fingerprintBonus
        : 0.1;
      this.scoringEnabled = completionConfig.scoring?.enabled !== false;
      this.contentStableChecks = Number(completionConfig.contentStableChecks || 3);
      this.contentStableDelta = Number(completionConfig.contentStableDelta || 5);
      this.fingerprintStableChecks = Number(completionConfig.fingerprintStableChecks || 3);
      this.fingerprintSampleLength = Number(completionConfig.fingerprintSampleLength || 100);
    }

    async waitForCompletion(params = {}) {
      this.container = this.resolveContainer(params?.container);
      this.criteria.reset();
      this.scrollHeightHistory = [];
      this.startTime = Date.now();
      const currentLength = this.getCurrentContentLength();
      const { soft, hard } = this.timeoutManager.calculateTimeout(currentLength);
      let typingActive = true;
      const growthHistory = [];

      const recordGrowth = (diff) => {
        const now = Date.now();
        growthHistory.push({ ts: now, diff });
        while (growthHistory.length && now - growthHistory[0].ts > 2000) {
          growthHistory.shift();
        }
      };

      const getRecentGrowth = () => {
        const now = Date.now();
        return growthHistory
          .filter((item) => now - item.ts <= 2000)
          .reduce((sum, item) => sum + item.diff, 0);
      };

      let lastMutation = Date.now();
      let lastScrollHeight = this.getScrollHeight();
      let lastContentLength = 0;
      const mutationOptions = { childList: true, subtree: true, characterData: true };
      const stopObserve = window.ContentUtils?.observeMutations
        ? window.ContentUtils.observeMutations(this.container, mutationOptions, () => {
          lastMutation = Date.now();
          this.criteria.mark('mutationIdle', false);
          this.humanSession?.reportActivity?.('mutation');
        })
        : (() => () => {})();

      let cleanup = () => {};
      const updateHandle = setInterval(() => {
        const hardStopped = window.__LLMScrollHardStop || this.humanSession?.getState?.() === 'HARD_STOP';
        if (hardStopped) {
          cleanup(this.buildResult('hard_stop', 0, typingActive, getRecentGrowth(), false));
          return;
        }
        const now = Date.now();
        if (now - lastMutation > (this.criteria.criteria.mutationIdle?.threshold || 1500)) {
          this.criteria.mark('mutationIdle', true);
        }

        const height = this.getScrollHeight();
        this.scrollHeightHistory.push({ timestamp: now, height });
        while (this.scrollHeightHistory.length > 40) {
          this.scrollHeightHistory.shift();
        }
        if (Math.abs(height - lastScrollHeight) < 2) {
          this.criteria.mark('scrollStable', true);
        } else {
          if (height - lastScrollHeight > 0) {
            recordGrowth(height - lastScrollHeight);
          }
          lastScrollHeight = height;
          this.criteria.mark('scrollStable', false);
        }

        typingActive = this.detectTyping();
        this.criteria.mark('typingGone', !typingActive);
        const regenerateVisible = this.detectRegenerateVisible();
        this.criteria.mark('regenerateVisible', regenerateVisible);

        const sentinelVisible = this.isSentinelVisible();
        this.criteria.mark('sentinelVisible', sentinelVisible);

        const answerEl = this.getAnswerElement();
        if (answerEl) {
          const text = answerEl.textContent || '';
          const len = text.length || 0;
          this.latestContentLength = len;
          const delta = Math.abs(len - lastContentLength);
          if (len > 0 && delta <= this.contentStableDelta) {
            this.contentStableStreak += 1;
          } else {
            this.contentStableStreak = 0;
          }
          lastContentLength = len;
          this.criteria.mark('contentStable', this.contentStableStreak >= this.contentStableChecks);

          const sample = this.fingerprintSampleLength > 0
            ? text.slice(-this.fingerprintSampleLength)
            : text;
          const fingerprint = this.hashString(sample);
          if (fingerprint && fingerprint === this.lastFingerprint) {
            this.fingerprintStableStreak += 1;
          } else {
            this.lastFingerprint = fingerprint;
            this.fingerprintStableStreak = 0;
          }
          this.fingerprintStable = this.fingerprintStableStreak >= this.fingerprintStableChecks;
          if (delta > 0) {
            this.humanSession?.reportActivity?.('content-change');
          }
        } else {
          this.criteria.mark('contentStable', false);
          this.fingerprintStable = false;
        }
      }, this.checkInterval / 2);

      return new Promise((resolve) => {
        let checkHandle;
        cleanup = (payload) => {
          clearInterval(checkHandle);
          clearInterval(updateHandle);
          stopObserve();
          resolve(payload);
        };

        checkHandle = setInterval(() => {
          // v2.54.24 (2025-12-22 23:14 UTC): stop_disappeared detection (Purpose: finalize when stop vanishes).
          const stopVisible = this.getStopVisible();
          const stopDisappeared = Boolean(this.stopDisappearedAt) && !stopVisible;
          const regenerateVisible = this.detectRegenerateVisible();
          const completionSignal = this.detectCompletionIndicator();
          this.criteria.mark('completionSignal', completionSignal);
          const expiration = this.timeoutManager.checkExpiration();
          if (stopVisible && !expiration.softExpired && !expiration.hardExpired) {
            return;
          }
          if (regenerateVisible) {
            cleanup(this.buildResult('regenerate_visible', 1, typingActive, getRecentGrowth(), true));
            return;
          }
          if (completionSignal && this.criteria.criteria.completionSignal?.enabled) {
            cleanup(this.buildResult('completion_signal', 1, typingActive, getRecentGrowth(), true));
            return;
          }
          const metCount = this.criteria.metCount();
          const criteriaTotal = Object.values(this.criteria.criteria).filter((c) => c.enabled !== false).length || 5;
          this.maybeLogCriteria({ stopVisible, regenerateVisible, completionSignal, stopDisappeared, metCount, criteriaTotal });
          if (stopDisappeared) {
            this.stopDisappearedAt = 0;
            cleanup(this.buildResult('stop_disappeared', 0.9, typingActive, getRecentGrowth(), true));
            return;
          }
          const contentMutationStable = this.criteria.criteria.contentStable?.met && this.criteria.criteria.mutationIdle?.met;
          if (contentMutationStable) {
            cleanup(this.buildResult('content_mutation_stable', 0.85, typingActive, getRecentGrowth(), true));
            return;
          }
          if (this.scoringEnabled) {
            const score = this.calculateScore();
            if (score > this.scoreThreshold) {
              cleanup(this.buildResult('score_threshold', score, typingActive, getRecentGrowth(), true));
              return;
            }
          } else if (metCount >= this.minMetCriteria) {
            cleanup(this.buildResult('criteria_met', metCount / criteriaTotal, typingActive, getRecentGrowth(), true));
            return;
          }

          if (expiration.hardExpired) {
            cleanup(this.buildResult('hard_timeout', 0.3, typingActive, getRecentGrowth(), false));
            return;
          }

          if (expiration.softExpired) {
            if (metCount >= 2 && this.timeoutManager.extendSoftTimeout()) {
              return;
            }
            cleanup(this.buildResult('soft_timeout', 0.5, typingActive, getRecentGrowth(), false));
          }
        }, this.checkInterval);
      });
    }

    initAutoDiscoveredSelectors() {
      const cache = window.__AnswerWatcherSelectorCache || {};
      const key = this.platform || 'generic';
      if (!cache[key]) {
        cache[key] = {};
      }
      window.__AnswerWatcherSelectorCache = cache;
      return cache[key];
    }

    getAutoDiscoveredSelectors(type) {
      const values = this.autoDiscoveredSelectors?.[type];
      if (!values) return [];
      if (Array.isArray(values)) return values;
      return [values];
    }

    queueAutoDiscovery(type) {
      if (!type || this.autoDiscoveryInFlight.has(type)) return;
      const finder = window.SelectorFinder;
      if (!finder?.findOrDetectSelector) return;
      this.autoDiscoveryInFlight.add(type);
      const modelName = this.llmName || this.platform;
      finder.findOrDetectSelector({
        modelName,
        elementType: type,
        timeout: 1500,
        referenceElement: this.container || null
      })
        .then((result) => {
          const selector = result?.selector;
          if (!selector) return;
          const bucket = this.autoDiscoveredSelectors[type] || [];
          if (!bucket.includes(selector)) {
            bucket.unshift(selector);
          }
          this.autoDiscoveredSelectors[type] = bucket.slice(0, 5);
        })
        .catch(() => {})
        .finally(() => {
          this.autoDiscoveryInFlight.delete(type);
        });
    }

    emitSelectorMiss(targetType, selector, meta = {}) {
      if (!selector) return;
      try {
        chrome.runtime?.sendMessage?.({
          type: 'LLM_DIAGNOSTIC_EVENT',
          llmName: this.llmName || this.platform,
          event: {
            ts: Date.now(),
            type: 'SELECTOR',
            label: 'SELECTOR_MISS',
            details: selector,
            level: 'warning',
            meta: Object.assign({
              platform: this.platform,
              target: targetType,
              selector
            }, meta || {})
          }
        });
      } catch (_) {}
    }

    normalizeSelectorList(input) {
      if (!input) return [];
      if (Array.isArray(input)) return input.filter(Boolean);
      if (typeof input === 'string') {
        return input
          .split(',')
          .map((sel) => sel.trim())
          .filter(Boolean);
      }
      return [];
    }

    mergeSelectors(primary = [], secondary = []) {
      const merged = [...primary, ...secondary].filter(Boolean);
      return Array.from(new Set(merged));
    }

    filterSelectors(list, type) {
      const circuit = window.SelectorCircuit;
      if (!circuit) return list || [];
      const filtered = [];
      (list || []).forEach((selector) => {
        if (circuit.shouldUse(selector, this.platform, type)) {
          filtered.push(selector);
        } else if (type === 'stopButton' || type === 'regenerateButton') {
          this.queueAutoDiscovery(type);
        }
      });
      return filtered;
    }

    getStopVisible() {
      const mode = this.stopButtonCheckMode;
      if (mode === 'direct') {
        return this.detectStopButtonVisible();
      }
      if (mode === 'fresh') {
        const ageMs = this.lastStopVisibleAt ? (Date.now() - this.lastStopVisibleAt) : Infinity;
        if (ageMs <= this.stopButtonCacheMaxAgeMs) return this.lastStopVisible;
        return this.detectStopButtonVisible();
      }
      return this.lastStopVisible;
    }

    resolveContainer(containerParam) {
      if (containerParam?.element && containerParam.element !== window && containerParam.element.nodeType === 1) {
        return containerParam.element;
      }
      const candidates = [
        this.selectors.answerContainer,
        this.selectors.lastMessage
      ].filter(Boolean);
      for (const sel of candidates) {
        const el = this.safeQuery(sel);
        if (el) {
          if (this.selectors.answerContainer && sel === this.selectors.answerContainer) {
            return el;
          }
          return el.parentElement || el;
        }
      }
      const main = document.querySelector('main article') || document.querySelector('main') || document.querySelector('article');
      if (main) return main;
      return document.scrollingElement || document.documentElement || document.body;
    }

    detectTyping() {
      const circuit = window.SelectorCircuit;
      const generatingSelectors = this.filterSelectors(this.selectors.generatingIndicators, 'generating');
      const streamingSelectors = this.filterSelectors(this.selectors.streaming, 'streaming');
      const spinnerSelectors = this.filterSelectors(this.selectors.spinner, 'spinner');

      const isVisibleMatch = (selector, type) => {
        const nodes = this.safeQueryAll(selector);
        const match = Array.from(nodes).some((el) => this.isElementVisible(el));
        if (match) circuit?.report(selector, this.platform, type, true);
        return match;
      };
      const generating = generatingSelectors.some((selector) => isVisibleMatch(selector, 'generating'));
      const streaming = streamingSelectors.some((selector) => isVisibleMatch(selector, 'streaming'));
      const spinners = spinnerSelectors.some((selector) => {
        const nodes = this.safeQueryAll(selector);
        return Array.from(nodes).some((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
      });
      const stopVisible = this.detectStopButtonVisible();
      return generating || streaming || spinners || stopVisible;
    }

    getStopSelectors() {
      const base = this.normalizeSelectorList(this.selectors.stopButton);
      const filtered = this.filterSelectors(base, 'stopButton');
      if (!filtered.length && base.length) {
        this.queueAutoDiscovery('stopButton');
      }
      const discovered = this.getAutoDiscoveredSelectors('stopButton');
      return this.mergeSelectors(discovered, filtered);
    }

    getRegenerateSelectors() {
      const base = this.normalizeSelectorList(this.selectors.regenerateButton);
      const fallback = base.length ? base : this.normalizeSelectorList(this.selectors.completionIndicators);
      const filtered = this.filterSelectors(fallback, 'regenerateButton');
      if (!filtered.length && fallback.length) {
        this.queueAutoDiscovery('regenerateButton');
      }
      const discovered = this.getAutoDiscoveredSelectors('regenerateButton');
      return this.mergeSelectors(discovered, filtered);
    }

    detectStopButtonVisible() {
      const stopSelectors = this.getStopSelectors();
      let stopButton = null;
      let matchedSelector = null;
      for (const selector of stopSelectors) {
        this.lastStopSelectorAttempt = selector;
        const node = this.safeQuery(selector);
        const visible = node ? this.isElementVisible(node) : false;
        const disabled = node?.disabled || node?.getAttribute?.('aria-disabled') === 'true' || node?.getAttribute?.('data-disabled') === 'true';
        if (visible && !disabled) {
          stopButton = node;
          matchedSelector = selector;
          break;
        }
        this.emitSelectorMiss('stopButton', selector, {
          visible,
          disabled
        });
      }
      if (matchedSelector) {
        this.lastStopSelector = matchedSelector;
      }
      const stopVisible = stopButton ? this.isElementVisible(stopButton) : false;
      const disabled = stopButton?.disabled || stopButton?.getAttribute?.('aria-disabled') === 'true' || stopButton?.getAttribute?.('data-disabled') === 'true';
      const wasVisible = this.lastStopVisible;
      this.lastStopVisible = Boolean(stopVisible && !disabled);
      if (wasVisible && !this.lastStopVisible) {
        this.stopDisappearedAt = Date.now();
      }
      if (this.lastStopVisible) {
        this.stopSeenAt = Date.now();
        this.stopDisappearedAt = 0;
      }
      this.lastStopVisibleAt = Date.now();
      return this.lastStopVisible;
    }

    isSentinelVisible() {
      const sentinel = document.getElementById('toolkit-sentinel');
      if (!sentinel) return false;
      const rect = sentinel.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    }

    getScrollHeight() {
      const node = this.container === document.body ? document.documentElement : this.container;
      return node?.scrollHeight || document.documentElement.scrollHeight || 0;
    }

    getAnswerElement() {
      const selectors = this.selectors.lastMessage ? [this.selectors.lastMessage] : [];
      if (!selectors.length && this.selectors.answerContainer) {
        selectors.push(`${this.selectors.answerContainer} > :last-child`);
      }
      return selectors
        .map((selector) => this.safeQuery(selector))
        .find(Boolean);
    }

    getCurrentContentLength() {
      const el = this.getAnswerElement();
      return el?.textContent?.length || 0;
    }

    detectCompletionIndicator() {
      const completionSelectors = this.filterSelectors(this.selectors.completionIndicators, 'completion');
      if (!completionSelectors.length) return false;
      const circuit = window.SelectorCircuit;
      return completionSelectors.some((selector) => {
        const nodes = this.safeQueryAll(selector);
        const found = Array.from(nodes).some((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
        if (found) circuit?.report(selector, this.platform, 'completion', true);
        return found;
      });
    }

    detectRegenerateVisible() {
      const regenSelectors = this.getRegenerateSelectors();
      if (!regenSelectors.length) return false;
      let match = null;
      for (const selector of regenSelectors) {
        this.lastRegenerateSelectorAttempt = selector;
        const node = this.safeQuery(selector);
        const visible = node ? this.isElementVisible(node) : false;
        if (visible) {
          match = selector;
          break;
        }
        this.emitSelectorMiss('regenerateButton', selector, {
          visible
        });
      }
      if (match) {
        this.lastRegenerateSelector = match;
        return true;
      }
      return false;
    }

    isElementVisible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }

    calculateScore() {
      const snapshot = this.buildCriteriaSnapshot();
      const weights = this.scoreWeights || {};
      let totalWeight = 0;
      let rawScore = 0;
      Object.keys(weights).forEach((key) => {
        const weight = Number(weights[key]) || 0;
        if (weight <= 0) return;
        const entry = snapshot[key];
        if (entry && entry.enabled !== false) {
          totalWeight += weight;
          if (entry.met) rawScore += weight;
        }
      });
      let score = totalWeight > 0 ? rawScore / totalWeight : 0;
      if (this.fingerprintStable) {
        score = Math.min(1, score + this.fingerprintBonus);
      }
      return score;
    }

    buildResult(reason, confidence, typingActive, recentGrowth, completed = true) {
      const criteriaSnapshot = this.buildCriteriaSnapshot();
      return {
        success: completed,
        completed,
        reason,
        confidence,
        duration: Date.now() - this.startTime,
        indicators: { streaming: typingActive },
        scrollGrowthInLast2s: recentGrowth,
        criteriaMet: this.criteria.metCount(),
        score: this.calculateScore(),
        metrics: {
          scrollHeightHistory: this.scrollHeightHistory.slice(-20),
          timeoutStatus: this.timeoutManager.getStatus(),
          typingActive,
          contentLength: this.latestContentLength,
          criteriaStatus: this.buildCriteriaStatus(criteriaSnapshot),
          criteriaSnapshot,
          completionSelectors: {
            stopButton: this.lastStopSelector || null,
            regenerateButton: this.lastRegenerateSelector || null
          },
          selectorAttempts: {
            stopButton: this.lastStopSelectorAttempt || null,
            regenerateButton: this.lastRegenerateSelectorAttempt || null
          }
        }
      };
    }

    buildCriteriaSnapshot() {
      const criteria = this.criteria?.criteria || {};
      const snapshot = {};
      Object.keys(criteria).forEach((key) => {
        const entry = criteria[key] || {};
        snapshot[key] = {
          met: !!entry.met,
          enabled: entry.enabled !== false,
          threshold: entry.threshold ?? null
        };
      });
      snapshot.fingerprintStable = {
        met: !!this.fingerprintStable,
        enabled: true,
        threshold: this.fingerprintStableChecks
      };
      return snapshot;
    }

    buildCriteriaStatus(criteriaSnapshot = null) {
      const snapshot = criteriaSnapshot || this.buildCriteriaSnapshot();
      return Object.keys(snapshot).map((key) => {
        const entry = snapshot[key];
        if (entry?.enabled === false) return `${key}:off`;
        return `${key}:${entry?.met ? '1' : '0'}`;
      }).join(' ');
    }

    maybeLogCriteria({ stopVisible, regenerateVisible, completionSignal, stopDisappeared, metCount, criteriaTotal }) {
      if (!this.verboseCriteria) return;
      const status = this.buildCriteriaStatus();
      const score = this.calculateScore();
      const key = `${stopVisible ? 1 : 0}|${regenerateVisible ? 1 : 0}|${completionSignal ? 1 : 0}|${stopDisappeared ? 1 : 0}|${metCount}|${status}|${score.toFixed(2)}`;
      if (key === this.lastCriteriaLogKey) return;
      this.lastCriteriaLogKey = key;
      const prefix = this.llmName ? `[AnswerWatcher:${this.llmName}]` : '[AnswerWatcher]';
      console.log(`${prefix} stop=${stopVisible ? '1' : '0'} regen=${regenerateVisible ? '1' : '0'} completion=${completionSignal ? '1' : '0'} stopGone=${stopDisappeared ? '1' : '0'} met=${metCount}/${criteriaTotal} score=${score.toFixed(2)} | ${status}`);
    }

    hashString(value = '') {
      let hash = 0;
      const str = String(value || '');
      for (let i = 0; i < str.length; i += 1) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
      }
      return hash.toString(16);
    }

    safeQuery(selector) {
      try {
        const circuit = window.SelectorCircuit;
        if (circuit && !circuit.shouldUse(selector, this.platform, 'query')) return null;
        const node = document.querySelector(selector);
        if (node) circuit?.report(selector, this.platform, 'query', true);
        return node;
      } catch (err) {
        window.SelectorMetrics?.record?.(this.platform, 'query', 'fail');
        if (!this.invalidSelectors.has(selector)) {
          this.invalidSelectors.add(selector);
          console.warn('[AnswerWatcher] Invalid selector', selector, err);
        }
        window.SelectorCircuit?.report(selector, this.platform, 'query', false);
        return null;
      }
    }

    safeQueryAll(selector) {
      try {
        return document.querySelectorAll(selector);
      } catch (err) {
        if (!this.invalidSelectors.has(selector)) {
          this.invalidSelectors.add(selector);
          console.warn('[AnswerWatcher] Invalid selector', selector, err);
        }
        return [];
      }
    }
  }

  namespace.UnifiedAnswerCompletionWatcher = UnifiedAnswerCompletionWatcher;
})();
