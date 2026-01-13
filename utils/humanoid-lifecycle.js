(function initHumanoidLifecycle() {
  const globalObject = typeof window !== 'undefined' ? window : self;
  if (globalObject.HumanoidEvents) {
    return;
  }

  const hasChromeRuntime = () => typeof chrome !== 'undefined' && !!chrome.runtime?.id;

  class HumanoidLifecycle extends EventTarget {
    constructor() {
      super();
      this.activeActivities = new Map();
      this.activityHistory = new Map();
      this.watchdogTimers = new Map();
      this.TIMEOUTS = {
        'anti-sleep': 300000,
        scroll: 120000,
        read: 120000,
        pipeline: 600000,
        default: 180000
      };
      this.pendingEvents = [];
      this.pendingKey = '__humanoid_pending_events';
      this.debugLogKey = '__humanoid_debug_log';
      this.debugEnabled = false;
      this.pendingFlushInterval = null;
      this._restorePendingEvents();
      this._initDebugFlag();
      this._startPendingFlush();
    }

    start(source, context = {}) {
      const traceId = context.traceId || this._generateTraceId();
      const timestamp = Date.now();
      const activity = Object.assign({ traceId, source, timestamp }, context);
      this.activeActivities.set(traceId, activity);
      this._emit('activity:start', activity);
      this._startWatchdog(traceId, source);
      return traceId;
    }

    stop(traceId, result = {}) {
      const activity = this.activeActivities.get(traceId);
      if (!activity) return;
      const duration = Date.now() - activity.timestamp;
      const stopData = Object.assign({}, activity, result, {
        duration,
        stoppedAt: Date.now()
      });
      this._saveToHistory(traceId, stopData);
      this.activeActivities.delete(traceId);
      this._clearWatchdog(traceId);
      this._emit('activity:stop', stopData);
    }

    heartbeat(traceId, progress = 0, meta = {}) {
      const activity = this.activeActivities.get(traceId);
      if (!activity) return;
      this._resetWatchdog(traceId, activity.source);
      const heartbeatData = Object.assign({
        traceId,
        source: activity.source,
        progress,
        timestamp: Date.now()
      }, meta);
      this._emit('activity:heartbeat', heartbeatData);
    }

    error(traceId, error, fatal = false) {
      const payload = {
        traceId,
        error: error?.message || String(error || 'unknown'),
        stack: error?.stack,
        fatal,
        timestamp: Date.now()
      };
      this._emit('activity:error', payload);
      if (fatal && traceId) {
        this.stop(traceId, { status: 'error', error: payload });
      }
    }

    stopAll(reason = 'force') {
      const ids = Array.from(this.activeActivities.keys());
      ids.forEach((traceId) => {
        this.stop(traceId, { status: 'forced', reason, forced: true });
      });
    }

    get isBusy() {
      return this.activeActivities.size > 0;
    }

    _emit(eventType, detail) {
      this.dispatchEvent(new CustomEvent(eventType, { detail }));
      this._mirrorToBackground(eventType, detail);
      this._logDebug(eventType, detail);
    }

    _mirrorToBackground(eventType, detail) {
      if (!hasChromeRuntime()) {
        this._queuePendingEvent(eventType, detail);
        return;
      }
      try {
        chrome.runtime.sendMessage(
          {
            type: 'HUMANOID_EVENT',
            event: eventType,
            detail
          },
          () => {
            if (chrome.runtime.lastError) {
              this._queuePendingEvent(eventType, detail);
            }
          }
        );
      } catch (_) {
        this._queuePendingEvent(eventType, detail);
      }
    }

    _queuePendingEvent(eventType, detail) {
      this.pendingEvents.push({ eventType, detail, timestamp: Date.now() });
      if (this.pendingEvents.length > 50) {
        this.pendingEvents.shift();
      }
      this._persistPendingEvents();
    }

    _startPendingFlush() {
      if (this.pendingFlushInterval) return;
      this.pendingFlushInterval = setInterval(() => this._flushPendingEvents(), 10000);
    }

    _flushPendingEvents() {
      if (!this.pendingEvents.length || !hasChromeRuntime()) {
        return;
      }
      const queue = [...this.pendingEvents];
      this.pendingEvents.length = 0;
      this._persistPendingEvents();
      queue.forEach(({ eventType, detail }) => this._mirrorToBackground(eventType, detail));
    }

    _persistPendingEvents() {
      try {
        sessionStorage.setItem(this.pendingKey, JSON.stringify(this.pendingEvents));
      } catch (_) {
        // ignore storage errors
      }
    }

    _restorePendingEvents() {
      try {
        const stored = sessionStorage.getItem(this.pendingKey);
        if (stored) {
          this.pendingEvents = JSON.parse(stored) || [];
        }
      } catch (_) {
        this.pendingEvents = [];
      }
    }

    _safeStorageGet(key, defaultValue = null) {
      try {
        return globalObject.localStorage?.getItem(key) ?? defaultValue;
      } catch (_) {
        return defaultValue;
      }
    }

    _safeStorageSet(key, value) {
      try {
        globalObject.localStorage?.setItem(key, value);
        return true;
      } catch (_) {
        return false;
      }
    }

    _initDebugFlag() {
      const flag = this._safeStorageGet('HUMANOID_DEBUG', 'false');
      this.debugEnabled = flag === 'true';
      if (this.debugEnabled) {
        console.log('🐛 HumanoidLifecycle debug mode enabled');
      }
    }

    _logDebug(eventType, detail) {
      if (!this.debugEnabled) return;
      const entry = {
        type: eventType,
        detail,
        timestamp: Date.now(),
        url: globalObject.location?.href
      };
      try {
        const stored = this._safeStorageGet(this.debugLogKey, '[]');
        const existing = JSON.parse(stored) || [];
        existing.push(entry);
        this._safeStorageSet(this.debugLogKey, JSON.stringify(existing.slice(-500)));
      } catch (_) {
        // ignore
      }
      console.log('[HumanoidLifecycle]', eventType, detail);
    }

    _startWatchdog(traceId, source) {
      const timeout = this.TIMEOUTS[source] || this.TIMEOUTS.default;
      if (this.watchdogTimers.has(traceId)) {
        clearTimeout(this.watchdogTimers.get(traceId));
      }
      const timer = setTimeout(() => {
        if (!this.activeActivities.has(traceId)) return;
        console.warn(`[HumanoidLifecycle] Watchdog timeout for ${traceId} (${source})`);
        this.stop(traceId, { status: 'timeout', forced: true, reason: 'watchdog' });
      }, timeout);
      this.watchdogTimers.set(traceId, timer);
    }

    _resetWatchdog(traceId, source) {
      this._startWatchdog(traceId, source);
    }

    _clearWatchdog(traceId) {
      const timer = this.watchdogTimers.get(traceId);
      if (timer) {
        clearTimeout(timer);
        this.watchdogTimers.delete(traceId);
      }
    }

    _saveToHistory(traceId, data) {
      this.activityHistory.set(traceId, data);
      if (this.activityHistory.size > 100) {
        const firstKey = this.activityHistory.keys().next().value;
        this.activityHistory.delete(firstKey);
      }
    }

    async runActivity(source, context = {}, executor) {
      if (typeof executor !== 'function') {
        throw new Error('HumanoidLifecycle.runActivity requires executor function');
      }
      const traceId = this.start(source, context);
      let stopped = false;
      const controller = {
        traceId,
        heartbeat: (progress, meta) => this.heartbeat(traceId, progress, meta),
        stop: (result = {}) => {
          if (stopped) return;
          if (this.activeActivities.has(traceId)) {
            this.stop(traceId, result);
          }
          stopped = true;
        },
        error: (error, fatal = false) => this.error(traceId, error, fatal)
      };
      try {
        const result = await executor(controller);
        if (!stopped) {
          controller.stop({ status: 'success' });
        }
        return result;
      } catch (error) {
        controller.error(error, true);
        if (!stopped) {
          controller.stop({ status: 'error', error: error?.message || String(error) });
        }
        throw error;
      }
    }

    _generateTraceId() {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
      }
      return `humanoid-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    }
  }

  const lifeCycle = new HumanoidLifecycle();
  globalObject.HumanoidEvents = lifeCycle;
  globalObject.HumanoidLifecycle = HumanoidLifecycle;

  globalObject.HumanoidDebug = {
    getActivities: () => Array.from(lifeCycle.activeActivities.values()),
    getHistory: () => Array.from(lifeCycle.activityHistory.values()),
    getPending: () => [...lifeCycle.pendingEvents],
    clearHistory: () => lifeCycle.activityHistory.clear(),
    stopAll: (reason) => lifeCycle.stopAll(reason || 'manual-debug')
  };

  globalObject.withHumanoidActivity = function (source, context = {}, executor) {
    const lifecycle = globalObject.HumanoidEvents;
    if (lifecycle?.runActivity) {
      return lifecycle.runActivity(source, context, executor);
    }
    if (typeof executor === 'function') {
      return executor({
        traceId: null,
        heartbeat: () => {},
        stop: () => {},
        error: () => {}
      });
    }
    return undefined;
  };

  if (globalObject.addEventListener) {
    globalObject.addEventListener('pagehide', () => {
      lifeCycle.stopAll('pagehide');
    });
    globalObject.addEventListener('beforeunload', () => {
      lifeCycle.stopAll('page-unload');
    });
  }
})();
