

importScripts(
    'selectors/chatgpt.config.js',
    'selectors/claude.config.js',
    'selectors/deepseek.config.js',
    'selectors/gemini.config.js',
    'selectors/grok.config.js',
    'selectors/lechat.config.js',
    'selectors/perplexity.config.js',
    'selectors/qwen.config.js',
    'selectors-config.js',
    'shared/storage-budgets.js',
    'notes/notes-constants.js',
    'notes/notes-idb.js',
    'notes/notes-orderkey.js',
    'notes/notes-chunks.js',
    'notes/notes-service.js'
);

chrome.windows.onFocusChanged.addListener((windowId) => {
    const hasFocus = windowId !== chrome.windows.WINDOW_ID_NONE;
    handleBrowserFocusChange(hasFocus);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
    if (!activeInfo || !browserHasFocus) return;
    handleTabActivation(activeInfo.tabId, activeInfo.windowId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabVisitTracker.tabId === tabId) {
        finalizeTabVisit('tab_closed');
    }
    untrackSessionTab(tabId);
});

let jobState = {};
let activeListeners = new Map();
let resultsTabId = null;
let resultsWindowId = null;
let llmTabMap = {};
const jobMetadata = new Map();
const llmRequestMap = {};
const pickerRequests = new Map();
const selectorResolutionMetrics = {};
const selectorFailureMetrics = {};
const selectorHealthMeta = { updatedAt: null, perKey: {} };
const selectorHealthChecks = {};
const platformRunHistory = new Map();
const platformDegradedAt = new Map();
const platformDegradedHourlyAt = new Map();
const PLATFORM_DEGRADED_WINDOW = 10;
const PLATFORM_DEGRADED_THRESHOLD = 0.5;
const PLATFORM_DEGRADED_COOLDOWN_MS = 15 * 60 * 1000;
const PLATFORM_DEGRADED_HOURLY_THRESHOLD = 0.7;
const PLATFORM_DEGRADED_HOURLY_COOLDOWN_MS = 60 * 60 * 1000;
const PLATFORM_HISTORY_MAX = 50;
let selectorMetricsDirty = false;
let selectorMetricsFlushTimer = null;
let selectorMetricsFlushInFlight = false;
const AUTO_PING_WINDOW_MS = 45000;
const MANUAL_PING_WINDOW_MS = 20000;
const pingWindowByTabId = {};
const pingStartByTabId = {};
const llmActivityMap = {};
const SESSION_TAB_IDS_KEY = 'llm_session_tab_ids_v1';
const sessionTabIds = new Set();
let sessionTabsLoaded = false;
const tabVisitTracker = {
    tabId: null,
    llmName: null,
    startedAt: 0,
    source: null
};

const loadSessionTabs = () => {
    if (!chrome?.storage?.local?.get) return;
    chrome.storage.local.get(SESSION_TAB_IDS_KEY, (result) => {
        const list = Array.isArray(result?.[SESSION_TAB_IDS_KEY]) ? result[SESSION_TAB_IDS_KEY] : [];
        list.forEach((tabId) => {
            if (Number.isInteger(tabId)) {
                sessionTabIds.add(tabId);
            }
        });
        sessionTabsLoaded = true;
    });
};

const persistSessionTabs = () => {
    if (!chrome?.storage?.local?.set) return;
    chrome.storage.local.set({ [SESSION_TAB_IDS_KEY]: Array.from(sessionTabIds) });
};

const trackSessionTab = (tabId) => {
    if (!Number.isInteger(tabId)) return;
    if (!sessionTabIds.has(tabId)) {
        sessionTabIds.add(tabId);
        persistSessionTabs();
    }
};

const untrackSessionTab = (tabId) => {
    if (!Number.isInteger(tabId)) return;
    if (sessionTabIds.delete(tabId)) {
        persistSessionTabs();
    }
};

const getTrackedSessionTabs = async () => {
    const ids = Array.from(sessionTabIds);
    if (!ids.length) return [];
    const tabs = await Promise.all(ids.map((tabId) => new Promise((resolve) => {
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError || !tab) {
                untrackSessionTab(tabId);
                resolve(null);
                return;
            }
            resolve({
                tabId: tab.id,
                url: tab.url || '',
                index: tab.index,
                windowId: tab.windowId
            });
        });
    })));
    return tabs
        .filter(Boolean)
        .filter((tab) => typeof tab.url === 'string' && /^https?:\/\//i.test(tab.url))
        .sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index));
};
const TAB_LOAD_TIMEOUT_MS = 45000;
const TAB_READY_TIMEOUT_MS = 15000; // Guard: cap wait for existing tabs before dispatch.
const MAX_LOG_ENTRIES = 60;
// How long we keep the LLM tab focused while the content-script injects & submits the prompt.
// Too small => we switch focus away mid-injection and "prompt not sent" happens.
const PROMPT_SUBMIT_TIMEOUT_MS = 20000;
// v2.54.3 (2025-12-19 20:10): CRITICAL - Reduce Perplexity timeout (early ready not working reliably)
const PROMPT_SUBMIT_TIMEOUTS_MS = {
    GPT: 15000,
    Grok: 20000,
    Gemini: 20000,
    Claude: 20000,
    'Le Chat': 20000,
    Qwen: 20000,
    DeepSeek: 22000,
    Perplexity: 8000  // REDUCED: 20s → 8s (early ready should fire at 0.5-1.5s, 8s is safe fallback)
};
const CLAUDE_TYPING_TIMEOUT_PER_CHAR_MS = 6;
const CLAUDE_TYPING_TIMEOUT_MAX_MS = 180000;
const CLAUDE_TYPING_TIMEOUT_MIN_MS = 30000;
const RESOLUTION_LAYER_MAP = {
    cache: 'L1',
    versioned: 'L2',
    autodiscovery: 'L3',
    emergency: 'L4'
};
const REMOTE_SELECTORS_URL = 'https://algold777.github.io/llm-selectors-override/selectors-override.json';
const REMOTE_SELECTORS_ENABLED = false; // защищаемся по умолчанию: только opt-in
const REMOTE_SELECTORS_FLAG_KEY = 'enable_remote_selectors_override';
const REMOTE_SELECTORS_EXPECTED_SHA256 = null; // можно задать контрольную сумму для пейлоада
const REMOTE_SELECTORS_REFRESH_MS = 6 * 60 * 60 * 1000;
const REMOTE_SELECTORS_ALARM = 'remote_selectors_refresh';
const REMOTE_SELECTORS_FETCH_TIMEOUT_MS = 15000;
const VERSION_STATUS_ALARM = 'selector_version_audit';
const VERSION_STATUS_REFRESH_MINUTES = 60 * 24;
const SELECTOR_ELEMENT_TYPES = ['composer', 'sendButton', 'response'];
const SELECTOR_OVERRIDE_AUDIT_KEY = 'selector_override_audit';
const SELECTOR_OVERRIDE_AUDIT_LIMIT = 80;
const SELECTOR_HEALTH_FAILURES_KEY = 'selector_health_failures';
const SELECTOR_HEALTH_META_KEY = 'selector_health_meta';
const SELECTOR_HEALTH_CHECKS_KEY = 'selector_health_checks';
const SELECTOR_METRICS_FLUSH_MS = 5000;
const HUMAN_VISIT_INITIAL_DELAY_MS = 7000;
const HUMAN_VISIT_DWELL_MS = 7000;
const HUMAN_VISIT_SCROLL_DURATION_MS = 3600;
const HUMAN_VISIT_LOOP_PAUSE_MS = 1500;
const HUMAN_VISIT_ALERT_THRESHOLD = 6;
const POST_SUCCESS_SCROLL_ATTEMPTS_MS = [0, 1200, 3600];
let humanPresenceLoopTimeout = null;
let humanPresenceActive = false;
let humanPresencePaused = false;
let humanPresenceManuallyStopped = false;
let currentHumanVisit = null;
let browserHasFocus = true;
loadSessionTabs();
const deferredAnswerTimers = {};
const SEND_PROMPT_DELAY_MS = 3000;
// v2.54.3 (2025-12-19 20:10): Reduced delay for models with early ready signal
// v2.54.4 (2025-12-19 20:20): Added Le Chat with aggressive timing
const SEND_PROMPT_DELAY_OVERRIDES = {
    'Perplexity': 1000,  // REDUCED: 3s → 1s (has early ready signal, 1s is safe fallback)
    'Claude': 1500,       // REDUCED: 3s → 1.5s (has early ready signal)
    'GPT': 1500,          // REDUCED: 3s → 1.5s (has early ready signal)
    'Le Chat': 1000       // v2.54.4: REDUCED 3s → 1s (has early ready signal, removed 1200ms internal delay)
};

function getSendPromptDelay(llmName) {
    return SEND_PROMPT_DELAY_OVERRIDES[llmName] || SEND_PROMPT_DELAY_MS;
}
const DEFERRED_VISIT_DELAYS_MS = [15000, 45000, 90000];
const API_MODE_STORAGE_KEY = 'llmComparatorApiModeEnabled';
const AUTO_FOCUS_NEW_TABS_KEY = 'autofocus_llm_tabs_enabled';
// v2.54.24 (2025-12-22 23:14 UTC): Telemetry sampling (Purpose: cap diagnostics volume to 5% of sessions).
const TELEMETRY_SAMPLE_RATE = 0.05;
const telemetrySampleCache = new Map();
let cachedApiMode = true;
let remoteSelectorsAllowed = REMOTE_SELECTORS_ENABLED;
let autoFocusNewTabsEnabled = false;
const rateLimitState = new Map();
const rateLimitTimers = new Map();
const llmStartChains = Object.create(null);
const postSuccessScrollTimers = new Map();
const TAB_STOP_PREFIX = 'tab_stop_';

// --- Prompt dispatch coordinator (prevents focus thrash) ---
// v2.54.24 (2025-12-22 23:14 UTC): Per-model dispatch locks + focus serialization (Purpose: reduce cross-model contention).
const promptDispatchMutexByLlm = new Map();
let promptDispatchFocusMutex = Promise.resolve();
let promptDispatchInProgress = 0;
const promptSubmitWaiters = new Map(); // llmName -> Set<fn>
let promptDispatchSupervisorTimer = null;
const DISPATCH_SUPERVISOR_TICK_MS = 1200;
// v2.54 (2025-12-19 19:30): Optimized retry backoffs for faster recovery
// v2.54.2 (2025-12-19 20:00): CRITICAL - Conservative mode for bot-sensitive models
// Grok (X.com) showed CAPTCHA challenge - too aggressive optimizations detected
// Solution: Use old conservative timings for sensitive models
const DISPATCH_RETRY_BACKOFF_MS = [0, 800, 3000, 8000]; // Aggressive (default)
const CONSERVATIVE_RETRY_BACKOFF_MS = [0, 2500, 5000, 9000]; // Conservative (for Grok, etc)
const CONNECTION_RETRY_DELAYS = [500, 1500, 3000]; // Aggressive connection retries
const CONSERVATIVE_CONNECTION_RETRY_DELAYS = [2000, 4000, 6000]; // Conservative (for Grok, etc)
// v2.54.24 (2025-12-22 23:14 UTC): Expand conservative backoffs (Purpose: reduce bot-detection risk on slow UIs).
const CONSERVATIVE_MODELS = ['Grok', 'Qwen', 'DeepSeek']; // Models that require conservative timing to avoid bot detection
const DISPATCH_MAX_ATTEMPTS = 4;

// Get retry backoff delays based on model sensitivity
function getRetryBackoffForModel(llmName) {
    if (CONSERVATIVE_MODELS.includes(llmName)) {
        return CONSERVATIVE_RETRY_BACKOFF_MS;
    }
    return DISPATCH_RETRY_BACKOFF_MS;
}

// Get connection retry delays based on model sensitivity
function getConnectionRetryDelaysForModel(llmName) {
    if (CONSERVATIVE_MODELS.includes(llmName)) {
        return CONSERVATIVE_CONNECTION_RETRY_DELAYS;
    }
    return CONNECTION_RETRY_DELAYS;
}

const withPromptDispatchLock = (llmName, fn) => {
    const key = llmName || 'global';
    const current = promptDispatchMutexByLlm.get(key) || Promise.resolve();
    const next = current.then(() => Promise.resolve(fn())).catch((err) => {
        console.warn('[DISPATCH] lock fn failed', err);
    });
    promptDispatchMutexByLlm.set(key, next);
    next.finally(() => {
        if (promptDispatchMutexByLlm.get(key) === next) {
            promptDispatchMutexByLlm.delete(key);
        }
    });
    return next;
};

const withPromptDispatchFocusLock = (fn) => {
    promptDispatchFocusMutex = promptDispatchFocusMutex.then(() => Promise.resolve(fn())).catch((err) => {
        console.warn('[DISPATCH] focus lock fn failed', err);
    });
    return promptDispatchFocusMutex;
};

function resolvePromptSubmitted(llmName, payload = {}) {
    const waiters = promptSubmitWaiters.get(llmName);
    if (waiters && waiters.size) {
        waiters.forEach((cb) => {
            try { cb(payload); } catch (_) {}
        });
        waiters.clear();
    }
}

function waitForPromptSubmitted(llmName, timeoutMs = PROMPT_SUBMIT_TIMEOUT_MS) {
    return new Promise((resolve) => {
        if (!llmName) {
            resolve(false);
            return;
        }
        const waiters = promptSubmitWaiters.get(llmName) || new Set();
        promptSubmitWaiters.set(llmName, waiters);
        let settled = false;
        const done = (ok, payload) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            waiters.delete(handler);
            resolve(ok ? (payload || true) : false);
        };
        const handler = (payload) => done(true, payload);
        waiters.add(handler);
        const timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
    });
}

function getPromptSubmitTimeoutMs(llmName) {
    if (!llmName) return PROMPT_SUBMIT_TIMEOUT_MS;
    const override = PROMPT_SUBMIT_TIMEOUTS_MS[llmName];
    return Number.isFinite(override) ? override : PROMPT_SUBMIT_TIMEOUT_MS;
}

function updateTypingStateFromDiagnostic(llmName, event) {
    if (llmName !== 'Claude') return;
    const entry = jobState?.llms?.[llmName];
    if (!entry || !event) return;
    const label = String(event.label || '').trim().toLowerCase();
    if (!label) return;
    const ts = Number(event.ts) || Date.now();
    if (label.startsWith('typing start')) {
        entry.typingActive = true;
        entry.typingStartedAt = ts;
        entry.typingEndedAt = null;
        if (!entry.typingGuardUntil) {
            entry.typingGuardUntil = ts + CLAUDE_TYPING_TIMEOUT_MIN_MS;
        }
        entry.typingGuardReason = entry.typingGuardReason || 'diagnostic';
        saveJobState(jobState);
    } else if (label.startsWith('typing done')) {
        entry.typingActive = false;
        entry.typingEndedAt = ts;
        entry.typingGuardUntil = 0;
        entry.typingGuardReason = null;
        saveJobState(jobState);
    }
}

function isTypingGuardActive(entry) {
    if (!entry || !entry.typingActive) return false;
    const guardUntil = Number(entry.typingGuardUntil || 0);
    const now = Date.now();
    if (guardUntil && now > guardUntil) {
        entry.typingActive = false;
        entry.typingEndedAt = now;
        entry.typingGuardUntil = 0;
        entry.typingGuardReason = 'guard_expired';
        saveJobState(jobState);
        return false;
    }
    return true;
}

// v2.54 (2025-12-19 19:36): Early ready signal system for faster script readiness detection
const earlyReadyWaiters = new Map(); // llmName -> Set<callback>

function waitForEarlyReadySignal(llmName, timeoutMs = 2000) {
    return new Promise((resolve) => {
        if (!llmName) {
            resolve(false);
            return;
        }
        const waiters = earlyReadyWaiters.get(llmName) || new Set();
        earlyReadyWaiters.set(llmName, waiters);

        let settled = false;
        const done = (success) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            waiters.delete(handler);
            resolve(success);
        };

        const handler = () => done(true);
        waiters.add(handler);
        const timer = setTimeout(() => done(false), timeoutMs);
    });
}

function resolveEarlyReadySignal(llmName) {
    const waiters = earlyReadyWaiters.get(llmName);
    if (waiters && waiters.size) {
        waiters.forEach((cb) => {
            try { cb(); } catch (_) {}
        });
        waiters.clear();
    }
}

function activateTabForDispatch(tabId) {
    return new Promise((resolve) => {
        if (!isValidTabId(tabId)) {
            resolve(false);
            return;
        }
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError || !tab) {
                resolve(false);
                return;
            }
            const winId = tab.windowId;
            const focusWindow = (cb) => {
                if (!winId) return cb();
                chrome.windows.update(winId, { focused: true }, () => cb());
            };
            focusWindow(() => {
                chrome.tabs.update(tabId, { active: true }, () => {
                    resolve(!chrome.runtime.lastError);
                });
            });
        });
    });
}

async function captureTabSnapshot(tabId) {
    const tab = await getTabSafe(tabId);
    return buildTabSnapshot(tab);
}

function waitForTabComplete(tabId, timeoutMs = TAB_READY_TIMEOUT_MS) {
    return new Promise((resolve) => {
        if (!isValidTabId(tabId)) {
            resolve(false);
            return;
        }
        let settled = false;
        const done = (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve(ok);
        };
        const listener = (updatedTabId, changeInfo) => {
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
                done(true);
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
        const timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
    });
}

function reloadTab(tabId) {
    return new Promise((resolve) => {
        if (!isValidTabId(tabId)) {
            resolve(false);
            return;
        }
        chrome.tabs.reload(tabId, () => resolve(!chrome.runtime.lastError));
    });
}

// Purpose: ensure the tab is eligible, loaded, and not discarded before dispatching.
async function ensureTabReadyForDispatch(tabId, llmName, { reason = 'unknown' } = {}) {
    const initialTab = await getTabSafe(tabId);
    const initialSnapshot = buildTabSnapshot(initialTab);
    emitTelemetry(llmName, 'TAB_READY_CHECK', {
        meta: { snapshot: initialSnapshot || null, reason }
    });
    if (!initialTab) {
        emitTelemetry(llmName, 'TAB_READY_FAIL', {
            details: 'tab_missing',
            level: 'warning',
            meta: { snapshot: initialSnapshot || null, reason }
        });
        return { ok: false, reason: 'tab_missing', snapshot: initialSnapshot };
    }
    if (!isEligibleTabForLlm(llmName, initialTab)) {
        emitTelemetry(llmName, 'TAB_READY_FAIL', {
            details: 'tab_ineligible',
            level: 'warning',
            meta: { snapshot: initialSnapshot || null, reason }
        });
        return { ok: false, reason: 'tab_ineligible', snapshot: initialSnapshot };
    }
    if (initialTab.discarded) {
        emitTelemetry(llmName, 'TAB_DISCARDED_RELOAD', {
            level: 'warning',
            meta: { snapshot: initialSnapshot || null, reason }
        });
        const reloaded = await reloadTab(tabId);
        if (!reloaded) {
            emitTelemetry(llmName, 'TAB_READY_FAIL', {
                details: 'tab_reload_failed',
                level: 'warning',
                meta: { snapshot: initialSnapshot || null, reason }
            });
            return { ok: false, reason: 'tab_reload_failed', snapshot: initialSnapshot };
        }
        const reloadStart = Date.now();
        const loaded = await waitForTabComplete(tabId, TAB_READY_TIMEOUT_MS);
        emitTelemetry(llmName, 'TAB_READY_WAIT_END', {
            details: `ok=${loaded}`,
            meta: { waitMs: Date.now() - reloadStart, ok: loaded, phase: 'reload', reason }
        });
        if (!loaded) {
            emitTelemetry(llmName, 'TAB_READY_FAIL', {
                details: 'tab_reload_timeout',
                level: 'warning',
                meta: { snapshot: initialSnapshot || null, reason }
            });
            return { ok: false, reason: 'tab_reload_timeout', snapshot: initialSnapshot };
        }
    } else if (initialTab.status !== 'complete') {
        const loadStart = Date.now();
        const loaded = await waitForTabComplete(tabId, TAB_READY_TIMEOUT_MS);
        emitTelemetry(llmName, 'TAB_READY_WAIT_END', {
            details: `ok=${loaded}`,
            meta: { waitMs: Date.now() - loadStart, ok: loaded, phase: 'load', reason }
        });
        if (!loaded) {
            emitTelemetry(llmName, 'TAB_READY_FAIL', {
                details: 'tab_load_timeout',
                level: 'warning',
                meta: { snapshot: initialSnapshot || null, reason }
            });
            return { ok: false, reason: 'tab_load_timeout', snapshot: initialSnapshot };
        }
    }
    const refreshedTab = await getTabSafe(tabId);
    const refreshedSnapshot = buildTabSnapshot(refreshedTab) || initialSnapshot;
    if (!refreshedTab) {
        emitTelemetry(llmName, 'TAB_READY_FAIL', {
            details: 'tab_missing_after_wait',
            level: 'warning',
            meta: { snapshot: refreshedSnapshot || null, reason }
        });
        return { ok: false, reason: 'tab_missing_after_wait', snapshot: refreshedSnapshot };
    }
    if (!isEligibleTabForLlm(llmName, refreshedTab)) {
        emitTelemetry(llmName, 'TAB_READY_FAIL', {
            details: 'tab_ineligible_after_wait',
            level: 'warning',
            meta: { snapshot: refreshedSnapshot || null, reason }
        });
        return { ok: false, reason: 'tab_ineligible_after_wait', snapshot: refreshedSnapshot };
    }
    if (refreshedTab.discarded) {
        emitTelemetry(llmName, 'TAB_READY_FAIL', {
            details: 'tab_discarded_after_wait',
            level: 'warning',
            meta: { snapshot: refreshedSnapshot || null, reason }
        });
        return { ok: false, reason: 'tab_discarded_after_wait', snapshot: refreshedSnapshot };
    }
    return { ok: true, tab: refreshedTab, snapshot: refreshedSnapshot };
}

async function dispatchPromptToTab(llmName, tabId, prompt, attachments = [], reason = 'auto') {
    if (!llmName || !isValidTabId(tabId) || !prompt) return;
    const entry = jobState?.llms?.[llmName];
    if (!entry) return;
    if (TERMINAL_STATUSES.includes(entry.status)) return;
    if (reason === 'retry_supervisor' && isTypingGuardActive(entry)) return;
    const busyUntil = Number(entry.csBusyUntil || 0);
    if (busyUntil && Date.now() < busyUntil) return;
    if (entry.messageSent) return;
    if (entry.dispatchInFlight) return;
    entry.dispatchInFlight = true;
    entry.dispatchAttempts = (entry.dispatchAttempts || 0) + 1;
    entry.dispatchQueuedAt = Date.now();
    saveJobState(jobState);

    withPromptDispatchLock(llmName, async () => {
        promptDispatchInProgress += 1;
        stopHumanPresenceLoop();
        const lockAcquiredAt = Date.now();
        const sessionId = jobState?.session?.startTime || Date.now();
        const dispatchId = `${llmName}:${sessionId}:${entry.dispatchAttempts || 0}`;
        entry.lastDispatchAt = Date.now();
        entry.lastDispatchMeta = { dispatchReason: reason, sessionId, dispatchId };
        entry.recentDispatchIds = Array.isArray(entry.recentDispatchIds) ? entry.recentDispatchIds : [];
        entry.recentDispatchIds = [...entry.recentDispatchIds.filter(Boolean), dispatchId].slice(-8);
        saveJobState(jobState);
        let submitTimeoutMs = getPromptSubmitTimeoutMs(llmName);
        // Purpose: avoid retrying while Claude is still typing long prompts.
        if (llmName === 'Claude') {
            const promptLength = String(prompt || '').length;
            const typingBudget = CLAUDE_TYPING_TIMEOUT_PER_CHAR_MS * promptLength;
            const computed = Math.round(20000 + typingBudget);
            submitTimeoutMs = Math.max(
                submitTimeoutMs,
                Math.min(CLAUDE_TYPING_TIMEOUT_MAX_MS, Math.max(CLAUDE_TYPING_TIMEOUT_MIN_MS, computed))
            );
            entry.typingActive = true;
            entry.typingStartedAt = Date.now();
            entry.typingEndedAt = null;
            entry.typingGuardUntil = Date.now() + submitTimeoutMs;
            entry.typingGuardReason = 'typing_budget';
        }
        const queueWaitMs = entry.dispatchQueuedAt ? Math.max(0, lockAcquiredAt - entry.dispatchQueuedAt) : null;
        emitTelemetry(llmName, 'DISPATCH_LOCK_ACQUIRE', {
            details: queueWaitMs !== null ? `${queueWaitMs}ms` : '',
            meta: { queueWaitMs, dispatchId, dispatchReason: reason, attempt: entry.dispatchAttempts }
        });
        emitTelemetry(llmName, 'DISPATCH_START', {
            meta: { dispatchId, dispatchReason: reason, attempt: entry.dispatchAttempts }
        });
        try {
            const readiness = await ensureTabReadyForDispatch(tabId, llmName, { reason });
            if (!readiness.ok) {
                broadcastDiagnostic(llmName, {
                    type: 'DISPATCH',
                    label: 'Вкладка не готова для отправки',
                    details: readiness.reason || 'unknown',
                    level: 'warning',
                    meta: { snapshot: readiness.snapshot || null, dispatchId, dispatchReason: reason }
                });
                return;
            }
            broadcastDiagnostic(llmName, {
                type: 'DISPATCH',
                label: 'Активация вкладки для отправки',
                details: reason,
                level: 'info',
                meta: { snapshot: readiness.snapshot || null, dispatchId, dispatchReason: reason }
            });
            // v2.54.24 (2025-12-22 23:14 UTC): Serialize focus+send (Purpose: avoid cross-tab focus collisions).
            let waiter = null;
            await withPromptDispatchFocusLock(async () => {
                await activateTabForDispatch(tabId);

                // v2.54 (2025-12-19 19:36): Try early ready signal first for faster dispatch
                // v2.54.3 (2025-12-19 20:10): Use reduced delays for models with early ready signal
                // If content script sends early signal, saves 1.5-2.5s
                const sendDelay = getSendPromptDelay(llmName);
                const earlyReadyPromise = waitForEarlyReadySignal(llmName, Math.min(1500, sendDelay));
                const fullWaitPromise = waitForScriptReady(tabId, llmName, { timeoutMs: sendDelay, intervalMs: 250 });

                const earlyReady = await Promise.race([earlyReadyPromise, fullWaitPromise]);
                if (earlyReady) {
                    // Early signal received, verify with quick health check
                    const verified = await checkScriptHealth(tabId, llmName, { silent: true });
                    if (!verified) {
                        // Early signal was false positive, wait for full ready
                        await fullWaitPromise.catch(() => false);
                    }
                } else {
                    // No early signal, full wait already completed
                }

                waiter = waitForPromptSubmitted(llmName, submitTimeoutMs);
                const readyWaitMs = Math.max(0, Date.now() - lockAcquiredAt);
                emitTelemetry(llmName, 'DISPATCH_SEND', {
                    details: `readyWaitMs=${readyWaitMs}`,
                    meta: {
                        dispatchId,
                        dispatchReason: reason,
                        attempt: entry.dispatchAttempts,
                        readyWaitMs
                    }
                });
                sendMessageSafely(tabId, llmName, { type: 'GET_ANSWER', prompt, attachments, meta: { dispatchReason: reason, sessionId, dispatchId } });
            });
            const submittedPayload = waiter ? await waiter : false;
            const submittedOk = submittedPayload === true || (submittedPayload && submittedPayload.ok === true);
            if (submittedOk) {
                entry.messageSent = true;
                entry.promptSubmittedAt = Date.now();
                broadcastDiagnostic(llmName, { type: 'DISPATCH', label: 'Промпт отправлен (подтверждено)', level: 'success' });
            } else if (submittedPayload && submittedPayload.busy) {
                broadcastDiagnostic(llmName, { type: 'DISPATCH', label: 'Content script занят — без ретрая', level: 'warning' });
            } else {
                const timeoutSnapshot = await captureTabSnapshot(tabId);
                emitTelemetry(llmName, 'PROMPT_SUBMITTED_TIMEOUT', {
                    details: `${submitTimeoutMs}ms`,
                    level: 'warning',
                    meta: { dispatchId, dispatchReason: reason, timeoutMs: submitTimeoutMs, snapshot: timeoutSnapshot || null }
                });
                broadcastDiagnostic(llmName, {
                    type: 'DISPATCH',
                    label: 'Таймаут подтверждения отправки',
                    details: `${submitTimeoutMs}ms`,
                    level: 'warning',
                    meta: { snapshot: timeoutSnapshot || null, dispatchId, dispatchReason: reason }
                });
            }
        } catch (err) {
            console.warn('[DISPATCH] dispatchPromptToTab failed', llmName, err);
            broadcastDiagnostic(llmName, { type: 'DISPATCH', label: 'Ошибка отправки промпта', details: err?.message || String(err), level: 'error' });
        } finally {
            try {
                entry.dispatchInFlight = false;
                saveJobState(jobState);
            } catch (_) {}
            // v2.54.5 (2025-12-19 20:30): REMOVED focusResultsTab() call
            // Фокус должен переключаться на результаты только когда все ответы собраны (line 4126),
            // а не после каждого dispatch. Иначе зависает на странице расширения.
            promptDispatchInProgress = Math.max(0, promptDispatchInProgress - 1);
            schedulePromptDispatchSupervisor();
        }
    });
}

function hasPendingPromptDispatches() {
    if (!jobState?.llms) return false;
    return Object.keys(jobState.llms).some((llmName) => {
        const entry = jobState.llms[llmName];
        if (!entry) return false;
        if (TERMINAL_STATUSES.includes(entry.status)) return false;
        if (entry.messageSent) return false;
        if (!isValidTabId(entry.tabId)) return false;
        const attempts = entry.dispatchAttempts || 0;
        return attempts < DISPATCH_MAX_ATTEMPTS;
    });
}

// v2.54 (2025-12-19 19:34): Count pending retries for adaptive tick rate
function countPendingRetries() {
    if (!jobState?.llms) return 0;
    const now = Date.now();
    let count = 0;

    for (const llmName of Object.keys(jobState.llms)) {
        const entry = jobState.llms[llmName];
        if (!entry || entry.messageSent || entry.dispatchInFlight) continue;
        if (TERMINAL_STATUSES.includes(entry.status)) continue;
        const busyUntil = Number(entry.csBusyUntil || 0);
        if (busyUntil && now < busyUntil) continue;
        if (!isValidTabId(entry.tabId)) continue;
        const attempts = entry.dispatchAttempts || 0;
        if (attempts >= DISPATCH_MAX_ATTEMPTS || attempts === 0) continue;
        if (isTypingGuardActive(entry)) continue;

        // This entry is waiting for retry
        // v2.54.2: Use conservative backoffs for bot-sensitive models
        const backoffArray = getRetryBackoffForModel(llmName);
        const backoff = backoffArray[Math.min(attempts, backoffArray.length - 1)] || 0;
        const lastAt = entry.lastDispatchAt || 0;
        if (now - lastAt >= backoff) {
            count++; // Ready to retry now
        }
    }

    return count;
}

function schedulePromptDispatchSupervisor() {
    if (promptDispatchSupervisorTimer) return;
    if (!hasPendingPromptDispatches()) return;

    // v2.54 (2025-12-19 19:34): Adaptive supervisor tick rate
    // v2.54.2 (2025-12-19 20:00): NEVER use fast tick for conservative models (bot detection risk)
    // Fast tick (400ms) when pending retries exist, normal tick (1200ms) otherwise
    // Saves up to 800ms on each retry processing
    const pendingRetries = countPendingRetries();

    // Check if any pending retry is for a conservative model
    const hasConservativePending = Object.keys(jobState?.llms || {}).some(llmName => {
        const entry = jobState.llms[llmName];
        if (!entry || entry.messageSent) return false;
        return CONSERVATIVE_MODELS.includes(llmName) && (entry.dispatchAttempts || 0) > 0;
    });

    // ALWAYS use slow tick for conservative models to avoid bot detection
    const adaptiveTick = (hasConservativePending || pendingRetries === 0)
        ? DISPATCH_SUPERVISOR_TICK_MS
        : 400;

    promptDispatchSupervisorTimer = setTimeout(() => {
        promptDispatchSupervisorTimer = null;
        runPromptDispatchSupervisor();
    }, adaptiveTick);
}

function runPromptDispatchSupervisor() {
    if (!jobState?.llms) return;
    if (promptDispatchInProgress > 0) {
        schedulePromptDispatchSupervisor();
        return;
    }
    const now = Date.now();
    for (const llmName of Object.keys(jobState.llms)) {
        const entry = jobState.llms[llmName];
        if (!entry || entry.messageSent || entry.dispatchInFlight) continue;
        if (TERMINAL_STATUSES.includes(entry.status)) continue;
        const busyUntil = Number(entry.csBusyUntil || 0);
        if (busyUntil && now < busyUntil) continue;
        const tabId = entry.tabId;
        if (!isValidTabId(tabId)) continue;
        const attempts = entry.dispatchAttempts || 0;
        if (attempts >= DISPATCH_MAX_ATTEMPTS) continue;
        if (attempts > 0 && isTypingGuardActive(entry)) continue;
        // v2.54.2: Use conservative backoffs for bot-sensitive models
        const backoffArray = getRetryBackoffForModel(llmName);
        const backoff = backoffArray[Math.min(attempts, backoffArray.length - 1)] || 0;
        const lastAt = entry.lastDispatchAt || 0;
        if (now - lastAt < backoff) continue;
        dispatchPromptToTab(llmName, tabId, jobState.prompt, jobState.attachments || [], 'retry_supervisor');
    }
    schedulePromptDispatchSupervisor();
}

function getTabSafe(tabId) {
    return new Promise((resolve) => {
        if (!isValidTabId(tabId)) {
            resolve(null);
            return;
        }
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError || !tab) {
                resolve(null);
            } else {
                resolve(tab);
            }
        });
    });
}

async function findExistingResultsTab() {
    const current = await getTabSafe(resultsTabId);
    if (current) return current;
    try {
        const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('result_new.html') });
        return tabs.find((t) => t?.id) || null;
    } catch (err) {
        console.warn('[BACKGROUND] Failed to query results tabs', err);
        return null;
    }
}

async function openOrFocusResultsTab() {
    const existing = await findExistingResultsTab();
    const tabToUse = existing || await new Promise((resolve) => {
        chrome.tabs.create({ url: chrome.runtime.getURL('result_new.html'), active: true }, (tab) => resolve(tab || null));
    });
    if (tabToUse?.id) {
        resultsTabId = tabToUse.id;
        resultsWindowId = tabToUse.windowId || resultsWindowId;
        try {
            chrome.windows.update(tabToUse.windowId, { focused: true }, () => chrome.runtime.lastError);
            chrome.tabs.update(tabToUse.id, { active: true }, () => chrome.runtime.lastError);
        } catch (err) {
            console.warn('[BACKGROUND] Failed to focus results tab', err);
        }
    }
    return tabToUse;
}

// Claude / Dato  2025-10-19 00-31 — singleton results tab
chrome.action.onClicked.addListener(() => {
    openOrFocusResultsTab().catch((err) => {
        console.warn('[BACKGROUND] Failed to open results tab', err);
    });
});

chrome.storage.local.get(API_MODE_STORAGE_KEY, (data) => {
    if (typeof data?.[API_MODE_STORAGE_KEY] === 'boolean') {
        cachedApiMode = data[API_MODE_STORAGE_KEY];
    }
});

chrome.storage.local.get(REMOTE_SELECTORS_FLAG_KEY, (data) => {
    if (typeof data?.[REMOTE_SELECTORS_FLAG_KEY] === 'boolean') {
        remoteSelectorsAllowed = data[REMOTE_SELECTORS_FLAG_KEY];
    }
    if (remoteSelectorsAllowed) {
        fetchRemoteSelectors().catch(() => {});
    }
});

chrome.storage.local.get(AUTO_FOCUS_NEW_TABS_KEY, (data) => {
    if (typeof data?.[AUTO_FOCUS_NEW_TABS_KEY] === 'boolean') {
        autoFocusNewTabsEnabled = data[AUTO_FOCUS_NEW_TABS_KEY];
    }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[API_MODE_STORAGE_KEY]) {
        cachedApiMode = !!changes[API_MODE_STORAGE_KEY].newValue;
    }
    if (changes[REMOTE_SELECTORS_FLAG_KEY]) {
        remoteSelectorsAllowed = !!changes[REMOTE_SELECTORS_FLAG_KEY].newValue;
        if (remoteSelectorsAllowed) {
            fetchRemoteSelectors().catch(() => {});
        }
    }
    if (changes[AUTO_FOCUS_NEW_TABS_KEY]) {
        autoFocusNewTabsEnabled = !!changes[AUTO_FOCUS_NEW_TABS_KEY].newValue;
    }
});

async function setTabStopState(tabId, state) {
    const key = `${TAB_STOP_PREFIX}${tabId}`;
    if (state === 'HARD_STOP') {
        const payload = {};
        payload[key] = { state, timestamp: Date.now() };
        await chrome.storage.session.set(payload);
        closePingWindowForTab(tabId);
    } else {
        await chrome.storage.session.remove(key);
    }
}

async function getHardStoppedTabs() {
    const all = await chrome.storage.session.get(null);
    const ids = new Set();
    Object.keys(all || {}).forEach((key) => {
        if (key.startsWith(TAB_STOP_PREFIX) && all[key]?.state === 'HARD_STOP') {
            const id = Number(key.replace(TAB_STOP_PREFIX, ''));
            if (Number.isFinite(id)) ids.add(id);
        }
    });
    return ids;
}

const LLM_TARGETS = {
    'GPT': {
        url: 'https://chat.openai.com/',
        delay: 3000,
        queryPatterns: ['https://chat.openai.com/*', 'https://chatgpt.com/*']
    },
    'Gemini': {
        url: 'https://gemini.google.com/',
        delay: 3000,
        queryPatterns: ['https://gemini.google.com/*', 'https://bard.google.com/*']
    },
    'Claude': {
        url: 'https://claude.ai/chat/new',
        delay: 3000,
        queryPatterns: ['https://claude.ai/*']
    },
    'Grok': {
        url: 'https://grok.com/',
        delay: 3000,
        queryPatterns: ['https://grok.com/*', 'https://x.com/*'],
        attachUrlAllowPrefixes: ['https://grok.com/', 'https://x.com/i/grok', 'https://x.com/i/grok/']
    },
    'Le Chat': {
        url: 'https://chat.mistral.ai/chat/',
        delay: 3000,
        queryPatterns: ['https://chat.mistral.ai/*']
    },
    'Qwen': {
        url: 'https://chat.qwen.ai/',
        delay: 3000,
        queryPatterns: ['https://chat.qwen.ai/*']
    },
    'DeepSeek': {
        url: 'https://chat.deepseek.com/',
        delay: 3000,
        queryPatterns: ['https://chat.deepseek.com/*']
    },
    'Perplexity': {
        url: 'https://www.perplexity.ai/',
        delay: 3000,
        queryPatterns: ['https://www.perplexity.ai/*', 'https://perplexity.ai/*']
    }
};

// Purpose: avoid attaching/reusing tabs on shared domains that are not actual LLM pages.
const URL_MATCH_BOUNDARY = new Set(['/', '?', '#']);

function normalizePatternToPrefix(pattern) {
    if (!pattern || typeof pattern !== 'string') return null;
    const starIndex = pattern.indexOf('*');
    if (starIndex === -1) return pattern;
    return pattern.slice(0, starIndex);
}

function matchesUrlPrefix(url, prefix) {
    if (!url || !prefix) return false;
    if (!url.startsWith(prefix)) return false;
    if (url.length === prefix.length) return true;
    if (prefix.endsWith('/')) return true;
    const nextChar = url.charAt(prefix.length);
    return URL_MATCH_BOUNDARY.has(nextChar);
}

function resolveTabForLlmName(llmName, done) {
    const cached = TabMapManager.get(llmName);
    if (cached) {
        done(cached);
        return;
    }
    const entry = LLM_TARGETS[llmName];
    const patterns = entry?.queryPatterns;
    const list = Array.isArray(patterns) ? patterns : (patterns ? [patterns] : []);
    if (!list.length) {
        done(null);
        return;
    }
    const finalize = (tabs) => {
        const eligible = (tabs || []).filter((tab) => isEligibleTabForLlm(llmName, tab));
        const selected = eligible.find((tab) => tab.active) || eligible[0] || null;
        if (selected?.id) {
            TabMapManager.setTab(llmName, selected.id);
            if (jobState?.llms?.[llmName]) {
                jobState.llms[llmName].tabId = selected.id;
            }
            done(selected.id);
            return;
        }
        done(null);
    };
    chrome.tabs.query({ url: list, currentWindow: true }, (tabs) => {
        if (tabs?.length) {
            finalize(tabs);
            return;
        }
        chrome.tabs.query({ url: list }, (allTabs) => finalize(allTabs));
    });
}

function resolveTabForLlmNameAsync(llmName) {
    return new Promise((resolve) => resolveTabForLlmName(llmName, resolve));
}

function getAttachAllowPrefixes(llmName) {
    const entry = LLM_TARGETS[llmName];
    if (!entry) return [];
    if (Array.isArray(entry.attachUrlAllowPrefixes) && entry.attachUrlAllowPrefixes.length) {
        return entry.attachUrlAllowPrefixes;
    }
    const patterns = entry.queryPatterns;
    if (!patterns) return [];
    const list = Array.isArray(patterns) ? patterns : [patterns];
    return list.map(normalizePatternToPrefix).filter(Boolean);
}

function getAttachDenyPrefixes(llmName) {
    const entry = LLM_TARGETS[llmName];
    if (!entry || !Array.isArray(entry.attachUrlDenyPrefixes)) return [];
    return entry.attachUrlDenyPrefixes.filter(Boolean);
}

function isEligibleTabForLlm(llmName, tab) {
    if (!llmName || !tab || !tab.url) return false;
    const url = tab.url;
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://')) {
        return false;
    }
    const denyPrefixes = getAttachDenyPrefixes(llmName);
    if (denyPrefixes.some((prefix) => matchesUrlPrefix(url, prefix))) {
        return false;
    }
    const allowPrefixes = getAttachAllowPrefixes(llmName);
    if (!allowPrefixes.length) return true;
    return allowPrefixes.some((prefix) => matchesUrlPrefix(url, prefix));
}

function buildTabSnapshot(tab) {
    if (!tab) return null;
    return {
        tabId: tab.id,
        url: tab.url || '',
        status: tab.status || '',
        discarded: tab.discarded === true,
        active: tab.active === true,
        lastAccessed: typeof tab.lastAccessed === 'number' ? tab.lastAccessed : null,
        windowId: tab.windowId,
        pinned: tab.pinned === true,
        audible: tab.audible === true,
        title: tab.title || ''
    };
}

function isValidTabId(tabId) {
    return Number.isInteger(tabId) && tabId > 0;
}

function extendPingWindowForTab(tabId, durationMs = AUTO_PING_WINDOW_MS) {
    if (!isValidTabId(tabId)) return;
    if (!pingStartByTabId[tabId]) {
        pingStartByTabId[tabId] = Date.now();
    }
    pingWindowByTabId[tabId] = Date.now() + durationMs;
}

function extendPingWindowForLLM(llmName, durationMs = AUTO_PING_WINDOW_MS) {
    const tabId = TabMapManager.get(llmName);
    if (!tabId) return;
    extendPingWindowForTab(tabId, durationMs);
}

function isPingWindowActive(tabId) {
    if (!isValidTabId(tabId)) return false;
    const expiresAt = pingWindowByTabId[tabId];
    if (!expiresAt) return false;
    if (expiresAt < Date.now()) {
        delete pingWindowByTabId[tabId];
        if (pingStartByTabId[tabId]) {
            delete pingStartByTabId[tabId];
        }
        return false;
    }
    return true;
}

function closePingWindowForTab(tabId) {
    if (!isValidTabId(tabId)) return;
    if (pingWindowByTabId[tabId]) {
        delete pingWindowByTabId[tabId];
    }
    if (pingStartByTabId[tabId]) {
        delete pingStartByTabId[tabId];
    }
}

function closePingWindowForLLM(llmName) {
    const tabId = TabMapManager.get(llmName);
    if (!tabId) return;
    closePingWindowForTab(tabId);
}

function ensureLogBuffer(llmName) {
    if (!jobState?.llms?.[llmName]) return null;
    if (!Array.isArray(jobState.llms[llmName].logs)) {
        jobState.llms[llmName].logs = [];
    }
    return jobState.llms[llmName].logs;
}

function getAppVersion() {
    try {
        return chrome?.runtime?.getManifest?.().version || 'unknown';
    } catch (_) {
        return 'unknown';
    }
}

function appendLogEntry(llmName, entry = {}) {
    const buffer = ensureLogBuffer(llmName);
    if (!buffer) return null;
    const sharedMeta = {
        extVersion: getAppVersion(),
        sessionId: jobState?.session?.startTime || null,
        requestId: jobState?.llms?.[llmName]?.requestId || null,
        llmName,
        tabId: jobState?.llms?.[llmName]?.tabId || null
    };
    const logEntry = {
        ts: entry.ts || Date.now(),
        type: entry.type || 'INFO',
        label: entry.label || '',
        details: entry.details || '',
        level: entry.level || 'info',
        meta: { ...sharedMeta, ...(entry.meta || {}) }
    };
    buffer.push(logEntry);
    if (buffer.length > MAX_LOG_ENTRIES) {
        buffer.splice(0, buffer.length - MAX_LOG_ENTRIES);
    }
    saveJobState(jobState);
    return logEntry;
}

function getLogSnapshot(llmName) {
    const buffer = ensureLogBuffer(llmName);
    return buffer ? [...buffer] : [];
}

function downgradePipelineHardTimeoutLogs(llmName) {
    const buffer = ensureLogBuffer(llmName);
    if (!buffer) return false;
    let changed = false;
    buffer.forEach((entry) => {
        if (!entry || entry.label !== 'PIPELINE_ERROR') return;
        const reason = String(entry?.meta?.message || entry?.details || '').toLowerCase();
        const downgradeReasons = ['hard_timeout', 'soft_timeout', 'stream_start_timeout', 'streaming_incomplete'];
        const matched = downgradeReasons.find((value) => reason.includes(value));
        if (!matched) return;
        entry.level = 'warning';
        entry.meta = {
            ...(entry.meta || {}),
            degraded: true,
            degradedReason: entry?.meta?.degradedReason || matched
        };
        changed = true;
    });
    if (changed) saveJobState(jobState);
    return changed;
}

function downgradePipelineHardTimeoutStorage(llmName) {
    const sessionId = jobState?.session?.startTime || null;
    chrome.storage.local.get(['__diagnostics_events__'], (res) => {
        if (chrome.runtime.lastError) return;
        const arr = Array.isArray(res?.__diagnostics_events__) ? res.__diagnostics_events__ : [];
        let changed = false;
        const next = arr.map((evt) => {
            if (!evt || evt.label !== 'PIPELINE_ERROR') return evt;
            if (sessionId && evt?.meta?.sessionId && evt.meta.sessionId !== sessionId) return evt;
            const name = evt?.meta?.llmName || evt?.platform || evt?.llmName;
            if (llmName && name && name !== llmName) return evt;
            const reason = String(evt?.meta?.message || evt?.details || '').toLowerCase();
            const downgradeReasons = ['hard_timeout', 'soft_timeout', 'stream_start_timeout', 'streaming_incomplete'];
            const matched = downgradeReasons.find((value) => reason.includes(value));
            if (!matched) return evt;
            changed = true;
            return {
                ...evt,
                level: 'warning',
                meta: {
                    ...(evt.meta || {}),
                    degraded: true,
                    degradedReason: evt?.meta?.degradedReason || matched
                }
            };
        });
        if (changed) {
            chrome.storage.local.set({ '__diagnostics_events__': next });
        }
    });
}

function broadcastDiagnostic(llmName, entry = {}) {
    const saved = appendLogEntry(llmName, entry);
    if (saved) {
        sendMessageToResultsTab({
            type: 'LLM_DIAGNOSTIC_EVENT',
            llmName,
            event: saved,
            logs: getLogSnapshot(llmName)
        });
    }
    return saved;
}

// v2.54.24 (2025-12-22 23:14 UTC): Telemetry dispatch + sampling (Purpose: unify storage + sample by session).
const LLM_NAME_ALIASES = {
    chatgpt: 'GPT',
    gpt: 'GPT',
    gemini: 'Gemini',
    claude: 'Claude',
    grok: 'Grok',
    lechat: 'Le Chat',
    mistral: 'Le Chat',
    qwen: 'Qwen',
    deepseek: 'DeepSeek',
    perplexity: 'Perplexity'
};

function resolveLlmName(value) {
    if (!value) return null;
    const raw = String(value).trim();
    const normalized = raw.toLowerCase();
    if (LLM_NAME_ALIASES[normalized]) return LLM_NAME_ALIASES[normalized];
    const match = Object.keys(LLM_TARGETS || {}).find((name) => name.toLowerCase() === normalized);
    return match || raw;
}

function hashTelemetryKey(value = '') {
    let hash = 0;
    const str = String(value);
    for (let i = 0; i < str.length; i += 1) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

function resolveTelemetrySampling(sessionId) {
    if (!sessionId) return Math.random() < TELEMETRY_SAMPLE_RATE;
    if (jobState?.session?.startTime && jobState.session.startTime === sessionId && typeof jobState.session.telemetrySampled === 'boolean') {
        return jobState.session.telemetrySampled;
    }
    const key = String(sessionId);
    if (telemetrySampleCache.has(key)) return telemetrySampleCache.get(key);
    const bucket = hashTelemetryKey(key) % 100;
    const sampled = bucket < (TELEMETRY_SAMPLE_RATE * 100);
    telemetrySampleCache.set(key, sampled);
    return sampled;
}

function isTelemetryEntry(entry = {}) {
    const type = String(entry.type || '').toUpperCase();
    return type === 'TELEMETRY' || type === 'PIPELINE';
}

function normalizeTelemetryEntry(entry = {}, llmName) {
    const meta = { ...(entry.meta || {}) };
    if (llmName && !meta.llmName) meta.llmName = llmName;
    return {
        ts: entry.ts || Date.now(),
        type: entry.type || 'TELEMETRY',
        label: entry.label || meta.event || entry.event || '',
        details: entry.details || '',
        level: entry.level || 'info',
        meta
    };
}

async function persistDiagnosticEvent(llmName, entry = {}, { sender, source } = {}) {
    const normalizedName = resolveLlmName(llmName || entry?.platform || entry?.meta?.platform || entry?.llmName);
    const evt = Object.assign({}, entry || {}, {
        ts: entry?.ts || Date.now(),
        platform: normalizedName || entry?.platform || 'unknown',
        source: entry?.source || source || sender?.url || sender?.tab?.url || null
    });
    const res = await chrome.storage.local.get(['__diagnostics_events__']);
    const arr = Array.isArray(res?.__diagnostics_events__) ? res.__diagnostics_events__ : [];
    let next = [...arr, evt].slice(-200);
    const stringify = () => JSON.stringify(next);
    while (stringify().length > 50000 && next.length > 1) {
        next = next.slice(1);
    }
    await chrome.storage.local.set({ '__diagnostics_events__': next });
    return evt;
}

function dispatchTelemetry(llmName, entry = {}, { sender, source, force = false } = {}) {
    if (!entry) return null;
    const normalized = normalizeTelemetryEntry(entry, llmName);
    const sessionId = normalized.meta?.sessionId || jobState?.session?.startTime || null;
    const sampled = force || normalized.level === 'error' || resolveTelemetrySampling(sessionId);
    if (!sampled) return null;
    if (sessionId && !normalized.meta.sessionId) normalized.meta.sessionId = sessionId;
    normalized.meta.sampled = true;
    normalized.meta.sampleRate = TELEMETRY_SAMPLE_RATE;
    const saved = broadcastDiagnostic(llmName, normalized);
    persistDiagnosticEvent(llmName, saved || normalized, { sender, source }).catch((err) => {
        console.warn('[dispatchTelemetry] store failed', err);
    });
    return saved || normalized;
}

function resolveEventLlmName(message, event, sender) {
    const direct = resolveLlmName(message?.llmName || event?.llmName || event?.meta?.llmName || event?.platform || event?.meta?.platform);
    if (direct) return direct;
    const tabId = sender?.tab?.id;
    const mapped = tabId && TabMapManager?.getNameByTabId ? TabMapManager.getNameByTabId(tabId) : null;
    return resolveLlmName(mapped);
}

function emitTelemetry(llmName, event, { label, details, level = 'info', meta = {}, force = false } = {}) {
    if (!llmName || !event) return null;
    return dispatchTelemetry(llmName, {
        type: 'TELEMETRY',
        label: label || event,
        details: details || '',
        level,
        meta: { event, ...meta }
    }, { force });
}

function recordPlatformRun(llmName, isSuccess) {
    const resolved = resolveLlmName(llmName);
    if (!resolved) return;
    const history = platformRunHistory.get(resolved) || [];
    const now = Date.now();
    history.push({ ts: now, success: !!isSuccess });
    while (history.length > PLATFORM_HISTORY_MAX) {
        history.shift();
    }
    platformRunHistory.set(resolved, history);
    const recentWindow = history.slice(-PLATFORM_DEGRADED_WINDOW);
    if (recentWindow.length >= PLATFORM_DEGRADED_WINDOW) {
        const successCount = recentWindow.filter((entry) => entry.success).length;
        const successRate = successCount / recentWindow.length;
        if (successRate < PLATFORM_DEGRADED_THRESHOLD) {
            const lastAlert = platformDegradedAt.get(resolved) || 0;
            if (now - lastAlert >= PLATFORM_DEGRADED_COOLDOWN_MS) {
                platformDegradedAt.set(resolved, now);
                emitTelemetry(resolved, 'PLATFORM_DEGRADED', {
                    level: 'warning',
                    details: `successRate=${Math.round(successRate * 100)}%`,
                    meta: {
                        successRate,
                        windowSize: recentWindow.length,
                        threshold: PLATFORM_DEGRADED_THRESHOLD
                    }
                });
            }
        }
    }
    const hourlyCutoff = now - 60 * 60 * 1000;
    const hourly = history.filter((entry) => entry.ts >= hourlyCutoff);
    if (hourly.length >= 4) {
        const hourlySuccess = hourly.filter((entry) => entry.success).length;
        const hourlyRate = hourlySuccess / hourly.length;
        if (hourlyRate < PLATFORM_DEGRADED_HOURLY_THRESHOLD) {
            const lastHourlyAlert = platformDegradedHourlyAt.get(resolved) || 0;
            if (now - lastHourlyAlert >= PLATFORM_DEGRADED_HOURLY_COOLDOWN_MS) {
                platformDegradedHourlyAt.set(resolved, now);
                emitTelemetry(resolved, 'PLATFORM_DEGRADED_HOURLY', {
                    level: 'warning',
                    details: `successRate=${Math.round(hourlyRate * 100)}%`,
                    meta: {
                        successRate: hourlyRate,
                        windowSize: hourly.length,
                        threshold: PLATFORM_DEGRADED_HOURLY_THRESHOLD
                    }
                });
            }
        }
    }
}

function stopHumanPresenceLoop() {
    if (humanPresenceLoopTimeout) {
        clearTimeout(humanPresenceLoopTimeout);
        humanPresenceLoopTimeout = null;
    }
    humanPresenceActive = false;
    broadcastHumanVisitStatus();
}

function scheduleHumanPresenceLoop(immediate = false) {
    if (promptDispatchInProgress > 0) return;
    if (humanPresencePaused || humanPresenceManuallyStopped) return;
    if (!hasPendingHumanVisits()) {
        stopHumanPresenceLoop();
        focusResultsTab();
        return;
    }
    if (!browserHasFocus) {
        humanPresenceActive = false;
        broadcastHumanVisitStatus();
        return;
    }
    if (humanPresenceLoopTimeout) {
        clearTimeout(humanPresenceLoopTimeout);
    }
    humanPresenceActive = true;
    const delay = immediate ? 0 : HUMAN_VISIT_INITIAL_DELAY_MS;
    humanPresenceLoopTimeout = setTimeout(() => {
        humanPresenceLoopTimeout = null;
        runHumanPresenceCycle();
    }, delay);
    broadcastHumanVisitStatus();
}

function hasPendingHumanVisits() {
    if (!jobState?.llms) return false;
    return Object.entries(jobState.llms).some(([llmName, entry]) => {
        if (!entry) return false;
        if (entry.status === 'COPY_SUCCESS' || entry.skipHumanLoop) {
            const tabId = entry.tabId || TabMapManager.get(llmName);
            if (tabId) {
                scrollTabToBottom(tabId);
            }
            return false;
        }
        return true;
    });
}

function broadcastHumanVisitStatus() {
    if (!chrome?.runtime?.sendMessage) return;
    const llmEntries = jobState?.llms
        ? Object.entries(jobState.llms).map(([name, entry]) => ({
            name,
            status: entry?.status || 'IDLE',
            visits: entry?.humanVisits || 0,
            stalled: !!entry?.humanStalled,
            skipped: !!entry?.skipHumanLoop,
            enabled: !entry?.skipHumanLoop,
            state: deriveHumanState(entry, name)
        }))
        : [];
    const payload = {
        active: humanPresenceActive,
        paused: humanPresencePaused,
        stopped: humanPresenceManuallyStopped,
        pending: hasPendingHumanVisits(),
        llms: llmEntries
    };
    chrome.runtime.sendMessage({ type: 'HUMAN_VISIT_STATUS', payload }, () => {
        if (chrome.runtime.lastError) {
            // ignore; overlay may not be listening
        }
    });
    TabMapManager.entries().forEach(([, tabId]) => {
        if (!isValidTabId(tabId)) return;
        chrome.tabs.sendMessage(tabId, { type: 'HUMAN_VISIT_STATUS', payload }, () => {
            if (chrome.runtime.lastError) {
                // ignore missing scripts
            }
        });
    });
}


function raiseHumanVisitAlert(llmName, visits) {
    const entry = jobState?.llms?.[llmName];
    if (!entry || entry.humanStalled) return;
    entry.humanStalled = true;
    entry.skipHumanLoop = true;
    broadcastHumanVisitStatus();
    if (!hasPendingHumanVisits()) {
        stopHumanPresenceLoop();
        focusResultsTab();
    }
}

function handleHumanVisitControl(action) {
    if (!action) return;
    if (action === 'pause') {
        humanPresencePaused = true;
        stopHumanPresenceLoop();
    } else if (action === 'continue') {
        humanPresencePaused = false;
        humanPresenceManuallyStopped = false;
        if (hasPendingHumanVisits()) {
            scheduleHumanPresenceLoop(true);
        }
    } else if (action === 'stop') {
        humanPresenceManuallyStopped = true;
        stopHumanPresenceLoop();
    }
    broadcastHumanVisitStatus();
}

function handleHumanVisitModelToggle(llmName, enabled) {
    if (!llmName || !jobState?.llms?.[llmName]) return;
    const entry = jobState.llms[llmName];
    entry.skipHumanLoop = enabled === false ? true : false;
    if (!entry.skipHumanLoop) {
        entry.humanVisits = 0;
        entry.humanStalled = false;
    }
    if (entry.skipHumanLoop && currentHumanVisit?.llmName === llmName) {
        currentHumanVisit.cancel?.();
    }
    broadcastHumanVisitStatus();
    if (entry.skipHumanLoop) {
        if (!hasPendingHumanVisits()) {
            stopHumanPresenceLoop();
            focusResultsTab();
        }
    } else if (!humanPresencePaused && !humanPresenceManuallyStopped) {
        scheduleHumanPresenceLoop(true);
    }
}

function handleBrowserFocusChange(hasFocus) {
    if (browserHasFocus === hasFocus) return;
    browserHasFocus = hasFocus;
    if (!hasFocus) {
        finalizeTabVisit('window_blur');
        if (currentHumanVisit?.cancel) {
            try { currentHumanVisit.cancel(); } catch (_) { /* noop */ }
        }
        stopHumanPresenceLoop();
    } else if (!humanPresencePaused && !humanPresenceManuallyStopped && hasPendingHumanVisits()) {
        scheduleHumanPresenceLoop(true);
    } else {
        broadcastHumanVisitStatus();
    }
    if (hasFocus) {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
            const activeTab = tabs && tabs.length ? tabs[0] : null;
            if (!activeTab) return;
            handleTabActivation(activeTab.id, activeTab.windowId);
        });
    }
}

function handleTabActivation(tabId, _windowId) {
    if (!isValidTabId(tabId)) return;
    const llmName = TabMapManager.getNameByTabId(tabId);
    if (!llmName) {
        finalizeTabVisit('tab_switch');
        return;
    }
    startTabVisit(tabId, llmName, 'user_focus');
}

function startTabVisit(tabId, llmName, source = 'tab_focus') {
    if (!isValidTabId(tabId) || !llmName) return;
    if (tabVisitTracker.tabId === tabId) {
        if (source === 'human_visit' && tabVisitTracker.source !== source) {
            tabVisitTracker.source = source;
        }
        return;
    }
    finalizeTabVisit('tab_switch');
    tabVisitTracker.tabId = tabId;
    tabVisitTracker.llmName = llmName;
    tabVisitTracker.startedAt = Date.now();
    tabVisitTracker.source = source || 'tab_focus';
}

function finalizeTabVisit(reason = 'tab_switch') {
    if (!tabVisitTracker.tabId || !tabVisitTracker.llmName) {
        tabVisitTracker.tabId = null;
        tabVisitTracker.llmName = null;
        tabVisitTracker.startedAt = 0;
        tabVisitTracker.source = null;
        return;
    }
    const endedAt = Date.now();
    const startedAt = tabVisitTracker.startedAt || endedAt;
    const durationMs = Math.max(0, endedAt - startedAt);
    const llmName = tabVisitTracker.llmName;
    const entry = jobState?.llms?.[llmName];
    if (entry) {
        if (!Array.isArray(entry.humanVisitDurations)) entry.humanVisitDurations = [];
        entry.humanVisitDurations.push({
            startedAt,
            endedAt,
            durationMs,
            source: tabVisitTracker.source || 'unknown',
            reason: reason || 'unknown'
        });
        if (entry.humanVisitDurations.length > 50) {
            entry.humanVisitDurations.splice(0, entry.humanVisitDurations.length - 50);
        }
        entry.humanVisitTotalMs = (entry.humanVisitTotalMs || 0) + durationMs;
        saveJobState(jobState);
        broadcastDiagnostic(llmName, {
            type: 'VISIT',
            label: 'TAB_VISIT',
            details: `${durationMs}ms`,
            level: 'info',
            meta: {
                startedAt,
                endedAt,
                durationMs,
                source: tabVisitTracker.source || 'unknown',
                reason: reason || 'unknown'
            }
        });
    }
    tabVisitTracker.tabId = null;
    tabVisitTracker.llmName = null;
    tabVisitTracker.startedAt = 0;
    tabVisitTracker.source = null;
}

async function runHumanPresenceCycle() {
    if (!humanPresenceActive || !jobState?.llms) return;
    const pendingEntries = Object.entries(jobState.llms)
        .filter(([_, entry]) => entry && entry.status !== 'COPY_SUCCESS' && !entry.skipHumanLoop);
    if (!pendingEntries.length) {
        stopHumanPresenceLoop();
        return;
    }
    for (const [llmName, entry] of pendingEntries) {
        if (!humanPresenceActive) break;
        if (!isValidTabId(entry.tabId)) continue;
        const liveEntry = jobState.llms?.[llmName];
        if (!liveEntry || liveEntry.status === 'COPY_SUCCESS' || liveEntry.skipHumanLoop) continue;
        if (!liveEntry.humanVisits) liveEntry.humanVisits = 0;
        liveEntry.humanVisits += 1;
        const visitsCount = liveEntry.humanVisits;
        if (visitsCount >= HUMAN_VISIT_ALERT_THRESHOLD && !liveEntry.humanStalled) {
            raiseHumanVisitAlert(llmName, visitsCount);
            return;
        }
        await visitTabWithHumanity(llmName, liveEntry.tabId);
        broadcastHumanVisitStatus();
    }
    if (humanPresenceActive) {
        humanPresenceLoopTimeout = setTimeout(() => {
            humanPresenceLoopTimeout = null;
            runHumanPresenceCycle();
        }, HUMAN_VISIT_LOOP_PAUSE_MS);
    }
}

function visitTabWithHumanity(llmName, tabId) {
    return new Promise((resolve) => {
        if (!browserHasFocus) {
            resolve();
            return;
        }
        if (!humanPresenceActive || !isValidTabId(tabId)) {
            resolve();
            return;
        }
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError || !tab) {
                resolve();
                return;
            }
            if (!browserHasFocus) {
                resolve();
                return;
            }
            const startTs = Date.now();
            let dwellTimer = null;
            let settled = false;
            const finalizeVisit = () => {
                if (settled) return;
                settled = true;
                if (dwellTimer) {
                    clearTimeout(dwellTimer);
                    dwellTimer = null;
                }
                if (tabVisitTracker.tabId === tabId) {
                    finalizeTabVisit('human_visit_end');
                }
                if (currentHumanVisit && currentHumanVisit.llmName === llmName) {
                    currentHumanVisit = null;
                }
                resolve();
            };
            const focusWindow = () => new Promise((focusResolve) => {
                chrome.windows.update(tab.windowId, { focused: true }, () => {
                    if (chrome.runtime.lastError) {
                        console.warn(`[HUMAN-VISIT] Window focus failed for ${llmName}:`, chrome.runtime.lastError.message);
                    }
                    focusResolve();
                });
            });
            focusWindow().then(() => {
                chrome.tabs.update(tabId, { active: true }, () => {
                    if (chrome.runtime.lastError) {
                        finalizeVisit();
                        return;
                    }
                    startTabVisit(tabId, llmName, 'human_visit');
                    currentHumanVisit = {
                        llmName,
                        cancel: finalizeVisit
                    };
                    performTabHumanSimulation(tabId, llmName).finally(() => {
                        const elapsed = Date.now() - startTs;
                        const remaining = Math.max(0, HUMAN_VISIT_DWELL_MS - elapsed);
                        dwellTimer = setTimeout(finalizeVisit, remaining);
                    });
                });
            });
        });
    });
}

function performTabHumanSimulation(tabId, llmName) {
    return new Promise((resolve) => {
        chrome.scripting.executeScript({
            target: { tabId },
            func: simulateHumanActivityInPage,
            args: [{ scrollDuration: HUMAN_VISIT_SCROLL_DURATION_MS, llmName }]
        }).then(() => resolve()).catch((err) => {
            console.warn(`[HUMAN-VISIT] Activity script failed for ${llmName}:`, err?.message || err);
            resolve();
        });
    });
}


function scrollTabToBottom(tabId) {
    if (!isValidTabId(tabId)) return;
    chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
            try {
                const toolkit = window.__UniversalScrollToolkit || window.ScrollToolkit || window.__codexScrollToolkit;
                if (toolkit?.scrollAllTargets) {
                    return Promise.resolve(toolkit.scrollAllTargets());
                }
                const target = document.scrollingElement || document.documentElement || document.body;
                if (target) {
                    target.scrollTo({ top: target.scrollHeight || 0, behavior: 'smooth' });
                } else {
                    window.scrollTo({ top: document.body?.scrollHeight || 0, behavior: 'smooth' });
                }
            } catch (err) {
                console.warn('[BACKGROUND] scrollTabToBottom fallback', err);
            }
        }
    }, () => {});
}

function clearPostSuccessScrollAudit(llmName) {
    const timers = postSuccessScrollTimers.get(llmName);
    if (timers && timers.length) {
        timers.forEach((timerId) => clearTimeout(timerId));
    }
    postSuccessScrollTimers.delete(llmName);
}

function schedulePostSuccessScrollAudit(llmName, tabId) {
    if (!llmName || !isValidTabId(tabId)) return;
    clearPostSuccessScrollAudit(llmName);
    const timers = POST_SUCCESS_SCROLL_ATTEMPTS_MS.map((delay, idx) => setTimeout(() => {
        scrollTabToBottom(tabId);
        if (idx === POST_SUCCESS_SCROLL_ATTEMPTS_MS.length - 1) {
            postSuccessScrollTimers.delete(llmName);
        }
    }, delay));
    postSuccessScrollTimers.set(llmName, timers);
}

async function simulateHumanActivityInPage(options = {}) {
    if (window.__LLMScrollHardStop || window.__HumanoidSessionState?.state === 'HARD_STOP') {
        return { status: 'skipped', reason: 'hard-stop' };
    }
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const scrollDuration = Number.isFinite(options?.scrollDuration) ? Math.max(1000, options.scrollDuration) : 3500;
    const answerSelectorList = [
        '[data-testid="conversation-turn"]',
        'main article',
        'article',
        '[class*="response"]',
        '.chat-message',
        '.prose',
        '.answer',
        '.assistant-message'
    ];
    const getRecentAnswerElements = () => Array.from(
        document.querySelectorAll(answerSelectorList.join(','))
    )
        .filter((el) => (el.innerText || el.textContent || '').trim().length > 20)
        .slice(-3);
    const ensureScrollToolkit = () => {
        if (window.__codexScrollToolkit) {
            return window.__codexScrollToolkit;
        }
        if (typeof window.__codexBuildScrollToolkit === 'function') {
            window.__codexScrollToolkit = window.__codexBuildScrollToolkit();
            return window.__codexScrollToolkit;
        }
        const buildScrollToolkit = () => {
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const waitForDomStability = (idleMs = 250, windowMs = 1400) => new Promise((resolve) => {
                const target = document.body || document.documentElement;
                if (!target) {
                    resolve();
                    return;
                }
                let timer = null;
                const finish = () => {
                    observer.disconnect();
                    resolve();
                };
                const observer = new MutationObserver(() => {
                    clearTimeout(timer);
                    timer = setTimeout(finish, idleMs);
                });
                observer.observe(target, { subtree: true, childList: true });
                timer = setTimeout(finish, idleMs);
                setTimeout(() => {
                    observer.disconnect();
                    resolve();
                }, windowMs);
            });
            const isScrollable = (node) => {
                if (!node || !(node instanceof Element)) return false;
                const diff = (node.scrollHeight || 0) - (node.clientHeight || 0);
                if (diff <= 24) return false;
                const style = getComputedStyle(node);
                return /(auto|scroll)/.test(style.overflowY || '');
            };
            const collectScrollableNodes = () => {
                const set = new Set();
                const add = (node) => {
                    if (!node) return;
                    if (node === document || node === window) return;
                    if (node === document.body || node === document.documentElement || node === document.scrollingElement) {
                        set.add(document.scrollingElement || document.documentElement);
                        return;
                    }
                    if (isScrollable(node)) set.add(node);
                };
                const scanShadow = (root, depth = 0) => {
                    if (!root || depth > 1) return;
                    const elements = root.querySelectorAll('*');
                    elements.forEach((el, idx) => {
                        if (idx > 200) return;
                        if (isScrollable(el)) add(el);
                        if (el.shadowRoot) scanShadow(el.shadowRoot, depth + 1);
                    });
                };
                const scanDocument = (doc, depth = 0) => {
                    if (!doc || depth > 1) return;
                    add(doc.scrollingElement || doc.documentElement);
                    add(doc.body);
                    const selectors = '[data-scrollable], [data-scroll="true"], main, section, article, div[class*="scroll"], .chat-container, .conversation, .chat-history';
                    doc.querySelectorAll(selectors).forEach((el, idx) => {
                        if (idx > 500) return;
                        add(el);
                        if (el.shadowRoot) scanShadow(el.shadowRoot, depth + 1);
                    });
                    if (depth === 0) {
                        doc.querySelectorAll('iframe').forEach((frame, idx) => {
                            if (idx > 5) return;
                            try {
                                const childDoc = frame.contentWindow?.document;
                                if (childDoc) scanDocument(childDoc, depth + 1);
                            } catch (_) {}
                        });
                    }
                };
                const addAnswerAncestors = () => {
                    const answers = getRecentAnswerElements();
                    answers.forEach((node) => {
                        let current = node;
                        let steps = 0;
                        while (current && steps < 12) {
                            if (isScrollable(current)) set.add(current);
                            current = current.parentElement;
                            steps++;
                        }
                    });
                };
                scanDocument(document);
                addAnswerAncestors();
                return Array.from(set);
            };
            let stickyOffsetCache = new WeakMap();
            const invalidateStickyCache = () => {
                stickyOffsetCache = new WeakMap();
            };
            const computeStickyOffset = (node) => {
                if (!node) return 0;
                if (stickyOffsetCache.has(node)) {
                    return stickyOffsetCache.get(node);
                }
                const threshold = 4;
                let offset = 0;
                if (node === document.scrollingElement) {
                    const sticky = Array.from(document.querySelectorAll('*')).filter((el) => {
                        const style = getComputedStyle(el);
                        if (style.position !== 'fixed' && style.position !== 'sticky') return false;
                        const rect = el.getBoundingClientRect();
                        return rect.height > 0 && rect.bottom >= window.innerHeight - threshold;
                    });
                    if (sticky.length) {
                        offset = Math.max(...sticky.map((el) => el.getBoundingClientRect().height || 0));
                    }
                } else if (node instanceof Element) {
                    const hostRect = node.getBoundingClientRect();
                    const sticky = Array.from(node.querySelectorAll('*')).filter((el) => {
                        const style = getComputedStyle(el);
                        if (style.position !== 'sticky' && style.position !== 'fixed') return false;
                        const rect = el.getBoundingClientRect();
                        return rect.height > 0 && rect.bottom >= hostRect.bottom - threshold && rect.top < hostRect.bottom;
                    });
                    if (sticky.length) {
                        offset = Math.max(...sticky.map((el) => el.getBoundingClientRect().height || 0));
                    }
                }
                stickyOffsetCache.set(node, offset);
                return offset;
            };
            const computeScrollTarget = (node) => Math.max(0, (node.scrollHeight || 0) - (node.clientHeight || 0) + computeStickyOffset(node));
            const getScrollSnapshot = (node, isWindow) => {
                const current = isWindow
                    ? (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0)
                    : (node.scrollTop || 0);
                const target = computeScrollTarget(node);
                return { current, target };
            };
            const isNodeAtBottom = (node) => {
                if (!node) return false;
                const isWindow = node === document.scrollingElement;
                const { current, target } = getScrollSnapshot(node, isWindow);
                return Math.abs(target - current) <= 3;
            };
            const fallbackScrollIntoView = async (node) => {
                if (!node) return;
                const isWindow = node === document.scrollingElement;
                const candidates = isWindow
                    ? getRecentAnswerElements()
                    : Array.from(node.children || []).slice(-3);
                if (!candidates.length && isWindow) {
                    const fallback = document.querySelector('main, section, article');
                    if (fallback) candidates.push(fallback);
                }
                for (const el of candidates) {
                    if (!el || typeof el.scrollIntoView !== 'function') continue;
                    try {
                        el.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'auto' });
                        await new Promise((resolve) => requestAnimationFrame(resolve));
                    } catch (_) {}
                }
                const target = computeScrollTarget(node);
                if (isWindow) {
                    window.scrollTo({ top: target, behavior: 'auto' });
                } else if (typeof node.scrollTo === 'function') {
                    node.scrollTo({ top: target, behavior: 'auto' });
                } else {
                    node.scrollTop = target;
                }
                const fallbackNode = isWindow ? document.body : node;
                fallbackNode.dispatchEvent(new WheelEvent('wheel', { deltaY: 220, bubbles: true, cancelable: true }));
                await sleep(140);
            };
            const enforceScroll = async (node) => {
                if (!node) return;
                const target = computeScrollTarget(node);
                const isWindow = node === document.scrollingElement;
                const getScrollTop = () => {
                    if (isWindow) {
                        return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
                    }
                    return node.scrollTop || 0;
                };
                const scrollToTarget = () => {
                    if (isWindow) {
                        window.scrollTo({ top: target, behavior: 'auto' });
                    } else if (typeof node.scrollTo === 'function') {
                        node.scrollTo({ top: target, behavior: 'auto' });
                    } else {
                        node.scrollTop = target;
                    }
                };
                let stable = 0;
                let prev = getScrollTop();
                const deadline = performance.now() + 2200;
                while (performance.now() < deadline && stable < 5) {
                    scrollToTarget();
                    await new Promise((resolve) => requestAnimationFrame(resolve));
                    const current = getScrollTop();
                    if (Math.abs(current - prev) < 2) {
                        stable++;
                    } else {
                        stable = 0;
                    }
                    prev = current;
                }
                if (stable < 3) {
                    const targetNode = isWindow ? document.body : node;
                    targetNode.dispatchEvent(new WheelEvent('wheel', { deltaY: 140, bubbles: true, cancelable: true }));
                    await sleep(140);
                    scrollToTarget();
                }
            };
            const runRedundantScroll = async (node) => {
                await enforceScroll(node);
                if (!isNodeAtBottom(node)) {
                    await fallbackScrollIntoView(node);
                }
            };
            const detectVirtualScroller = (node) => {
                if (!node || !(node instanceof Element)) return null;
                const methods = ['scrollToIndex', 'scrollToItem', 'scrollToOffset', 'scrollToBottom'].filter((name) => typeof node[name] === 'function');
                const classHint = typeof node.className === 'string' && /\bvirtual|infinite|scroll|feed|list\b/i.test(node.className);
                const datasetHint = node.dataset && Object.values(node.dataset).some((value) => /\bvirtual|infinite|feed\b/i.test(String(value || '')));
                if (!methods.length && !classHint && !datasetHint) return null;
                return { node, methods };
            };
            const tryInvokeVirtualScrollApi = async (descriptor) => {
                if (!descriptor || !descriptor.methods.length) return false;
                for (const method of descriptor.methods) {
                    try {
                        if (method === 'scrollToIndex' || method === 'scrollToItem') {
                            descriptor.node[method](Number.MAX_SAFE_INTEGER);
                        } else if (method === 'scrollToOffset') {
                            descriptor.node[method](Number.MAX_SAFE_INTEGER);
                        } else {
                            descriptor.node[method]();
                        }
                        await sleep(30);
                        return true;
                    } catch (err) {
                        console.warn('[HUMAN-VISIT] virtual scroll API failed:', err);
                    }
                }
                return false;
            };
            const shouldAllowScroll = () => {
                try {
                    return (window.__HumanoidSessionState?.state || '').toUpperCase() !== 'HARD_STOP';
                } catch (_) {
                    return true;
                }
            };
            const forceInstantScrollSequence = async (node) => {
                if (!shouldAllowScroll()) return false;
                if (!node) return false;
                let grew = false;
                let lastHeight = node.scrollHeight || 0;
                let stable = 0;
                for (let i = 0; i < 7; i++) {
                    if (!shouldAllowScroll()) break;
                    if (typeof node.scrollTo === 'function') {
                        node.scrollTo({ top: node.scrollHeight || 0, behavior: 'instant' });
                    } else {
                        node.scrollTop = node.scrollHeight || 0;
                    }
                    await sleep(90);
                    const currentHeight = node.scrollHeight || 0;
                    if (currentHeight - lastHeight > 2) {
                        grew = true;
                        stable = 0;
                    } else {
                        stable++;
                    }
                    lastHeight = currentHeight;
                    if (stable >= 4) break;
                }
                return grew;
            };
            const handleVirtualizedScroll = async (node) => {
                if (!shouldAllowScroll()) return false;
                const descriptor = detectVirtualScroller(node);
                if (!descriptor) return false;
                let actionTaken = false;
                if (descriptor.methods.length) {
                    actionTaken = await tryInvokeVirtualScrollApi(descriptor);
                }
                const grew = await forceInstantScrollSequence(node);
                if (!actionTaken && !grew) {
                    console.warn('[HUMAN-VISIT] virtualized list did not respond to enforced scroll', node);
                }
                return actionTaken || grew;
            };
            const setupScrollObservers = (node) => {
                const context = {
                    sentinelVisible: false,
                    sentinelRequired: false,
                    lastMutation: performance.now(),
                    idleThreshold: 450,
                    cleanupCallbacks: []
                };
                const container = node === document.scrollingElement
                    ? (document.body || document.documentElement)
                    : (node instanceof Element ? node : null);
                let sentinel = null;
                if (container && typeof container.appendChild === 'function') {
                    sentinel = document.createElement('div');
                    sentinel.dataset.scrollSentinel = 'true';
                    sentinel.style.cssText = 'width:1px;height:1px;pointer-events:none;';
                    container.appendChild(sentinel);
                    context.sentinelRequired = true;
                }
                const mutationTarget = container || document.body || document.documentElement;
                if (mutationTarget) {
                    const observer = new MutationObserver(() => {
                        context.lastMutation = performance.now();
                        invalidateStickyCache();
                    });
                    observer.observe(mutationTarget, { childList: true, subtree: true, characterData: true });
                    context.cleanupCallbacks.push(() => observer.disconnect());
                }
                if (sentinel) {
                    const ioOptions = node === document.scrollingElement ? { root: null, threshold: 0.01 } : { root: node, threshold: 0.01 };
                    const intersection = new IntersectionObserver((entries) => {
                        entries.forEach((entry) => {
                            if (entry.target === sentinel) {
                                context.sentinelVisible = entry.isIntersecting;
                                if (!entry.isIntersecting) {
                                    context.lastMutation = performance.now();
                                }
                            }
                        });
                    }, ioOptions);
                    intersection.observe(sentinel);
                    context.cleanupCallbacks.push(() => intersection.disconnect());
                } else {
                    context.sentinelVisible = true;
                }
                context.cleanup = () => {
                    context.cleanupCallbacks.forEach((cb) => {
                        try { cb(); } catch (_) {}
                    });
                    context.cleanupCallbacks.length = 0;
                    if (sentinel?.parentNode) {
                        sentinel.parentNode.removeChild(sentinel);
                    }
                };
                context.isSettled = () => {
                    if (context.sentinelRequired && !context.sentinelVisible) return false;
                    return (performance.now() - context.lastMutation) >= context.idleThreshold;
                };
                return context;
            };
            const driveNodeToBottomWithObservers = async (node) => {
                const context = setupScrollObservers(node);
                const deadline = performance.now() + 8000;
                let lastVirtualAttempt = 0;
                const maxPasses = 3;
                let passes = 0;
                try {
                    while (performance.now() < deadline) {
                        passes += 1;
                        await runRedundantScroll(node);
                        if (context.isSettled() || passes >= maxPasses) break;
                        const now = performance.now();
                        if (now - lastVirtualAttempt > 650) {
                            await handleVirtualizedScroll(node);
                            lastVirtualAttempt = now;
                        }
                        await sleep(180);
                    }
                } finally {
                    context.cleanup();
                }
            };
            const scrollAllTargets = async () => {
                await waitForDomStability();
                const nodes = collectScrollableNodes();
                const targets = nodes.length ? nodes : [document.scrollingElement || document.documentElement || document.body];
                for (const node of targets) {
                    try {
                        await driveNodeToBottomWithObservers(node);
                    } catch (err) {
                        console.warn('[HUMAN-VISIT] scroll target error:', err);
                    }
                }
            };
            return { scrollAllTargets };
        };
        window.__codexBuildScrollToolkit = buildScrollToolkit;
        window.__codexScrollToolkit = buildScrollToolkit();
        return window.__codexScrollToolkit;
    };

    // Pointer visualization disabled (handled via CursorGhost in content if needed)
    const ensurePointer = () => null;
    const movePointer = () => {};

    const runScrollSequence = async () => {
        const start = performance.now();
        while (performance.now() - start < scrollDuration) {
            const delta = window.innerHeight * (0.22 + Math.random() * 0.15);
            const target = Math.max(0, window.scrollY + delta);
            window.scrollTo({ top: target, behavior: 'smooth' });
            await sleep(420 + Math.random() * 260);
        }
    };

    const hoverTargets = [
        'textarea:not([disabled])',
        'div[contenteditable="true"]',
        'input[type="text"]:not([disabled])',
        'input[type="search"]:not([disabled])'
    ];

    const actionTargets = [
        'button:not([disabled])',
        '[role="button"]',
        'a[href]'
    ];

    const simulateHover = async (selectorList) => {
        for (const selector of selectorList) {
            const el = document.querySelector(selector);
            if (el) {
                const rect = el.getBoundingClientRect();
                const clientX = Math.min(window.innerWidth - 5, Math.max(5, rect.left + rect.width / 2 + (Math.random() * 40 - 20)));
                const clientY = Math.min(window.innerHeight - 5, Math.max(5, rect.top + rect.height / 2 + (Math.random() * 40 - 20)));
                const moveEvent = new MouseEvent('mousemove', { bubbles: true, clientX, clientY });
                el.dispatchEvent(moveEvent);
                movePointer(clientX, clientY);
                return el;
            }
        }
        return null;
    };

    try {
        await runScrollSequence();
        const humanoid = window.Humanoid;
        if (humanoid?.readPage) {
            try {
                await humanoid.readPage(600 + Math.random() * 400);
            } catch (_) {}
        }
        const composer = await simulateHover(hoverTargets);
        if (composer) {
            if (humanoid?.moveTo) {
                try { await humanoid.moveTo(composer); } catch (_) {}
            } else {
                composer.dispatchEvent(new Event('focus', { bubbles: true }));
                await sleep(120);
                composer.dispatchEvent(new Event('blur', { bubbles: true }));
            }
        }
        const actionTarget = await simulateHover(actionTargets);
        if (actionTarget && humanoid?.moveTo) {
            try { await humanoid.moveTo(actionTarget); } catch (_) {}
        }
        const centerX = window.innerWidth / 2 + (Math.random() * 60 - 30);
        const centerY = window.innerHeight / 2 + (Math.random() * 60 - 30);
        window.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true,
            clientX: centerX,
            clientY: centerY
        }));
        movePointer(centerX, centerY);
        await sleep(140);
    } catch (err) {
        console.warn('[HUMAN-VISIT] simulateHumanActivityInPage error:', err);
    }

    try {
        await ensureScrollToolkit().scrollAllTargets();
    } catch (err) {
        console.warn('[HUMAN-VISIT] final scroll error:', err);
    }
}

//-- 11.1. Сохранение и загрузка jobState из storage --//
async function saveJobState(state) {
    try {
        const persisted = (() => {
            if (!state) return state;
            const copy = { ...state };
            if (Array.isArray(state.attachments)) {
                copy.attachments = state.attachments.map((f) => ({
                    name: f?.name,
                    size: f?.size,
                    type: f?.type
                }));
            }
            return copy;
        })();
        await chrome.storage.local.set({ jobState: persisted });
        console.log('[BACKGROUND] Job state saved to storage');
    } catch (e) {
        console.error('[BACKGROUND] Failed to save job state:', e);
    }
}

async function loadJobState() {
    try {
        const { jobState: saved } = await chrome.storage.local.get('jobState');
        if (saved) {
            jobState = saved;
            console.log('[BACKGROUND] Job state loaded from storage');
            if (hasPendingHumanVisits()) {
                scheduleHumanPresenceLoop();
            }
            broadcastHumanVisitStatus();
        }
    } catch (e) {
        console.error('[BACKGROUND] Failed to load job state:', e);
    }
}

// Функция для сохранения карты вкладок в постоянное хранилище
const saveTabMapToStorage = async (map = llmTabMap) => {
    await chrome.storage.local.set({ llmTabMap: map });
    console.log('[BACKGROUND] Карта вкладок сохранена в storage:', map);
};

// Функция для загрузки карты вкладок из хранилища при запуске
const loadTabMapFromStorage = async () => {
    const data = await chrome.storage.local.get('llmTabMap');
    Object.keys(llmTabMap).forEach((key) => delete llmTabMap[key]);
    if (data.llmTabMap) {
        Object.assign(llmTabMap, data.llmTabMap);
    }
    console.log('[BACKGROUND] Карта вкладок загружена из storage:', llmTabMap);
};

const TabMapManager = (() => {
    let mutex = Promise.resolve();

    const withLock = (fn) => {
        mutex = mutex.then(() => Promise.resolve(fn())).catch((err) => {
            console.warn('[TabMapManager] lock fn failed', err);
        });
        return mutex;
    };

    const setTab = (llmName, tabId) => withLock(async () => {
        if (!llmName) return;
        if (!isValidTabId(tabId)) {
            delete llmTabMap[llmName];
        } else {
            llmTabMap[llmName] = tabId;
        }
        await saveTabMapToStorage();
    });

    const removeByName = (llmName) => withLock(async () => {
        if (!llmName || !(llmName in llmTabMap)) return;
        delete llmTabMap[llmName];
        await saveTabMapToStorage();
    });

    const removeByTabId = (tabId) => withLock(async () => {
        const name = getNameByTabId(tabId);
        if (name) {
            delete llmTabMap[name];
            await saveTabMapToStorage();
        }
    });

    const clear = () => withLock(async () => {
        Object.keys(llmTabMap).forEach((key) => delete llmTabMap[key]);
        await saveTabMapToStorage();
    });

    const load = () => withLock(async () => {
        await loadTabMapFromStorage();
    });

    const entries = () => Object.entries(llmTabMap);
    const get = (llmName) => llmTabMap[llmName] || null;
    const getNameByTabId = (tabId) => {
        for (const [name, mappedId] of Object.entries(llmTabMap)) {
            if (mappedId === tabId) return name;
        }
        return null;
    };

    return {
        withLock,
        setTab,
        removeByName,
        removeByTabId,
        clear,
        load,
        entries,
        get,
        getNameByTabId
    };
})();

const loadResolutionMetrics = async () => {
    try {
        const stored = await chrome.storage.local.get([
            'selectorResolutionMetrics',
            SELECTOR_HEALTH_FAILURES_KEY,
            SELECTOR_HEALTH_META_KEY,
            SELECTOR_HEALTH_CHECKS_KEY
        ]);
        if (stored.selectorResolutionMetrics) {
            Object.assign(selectorResolutionMetrics, stored.selectorResolutionMetrics);
            console.log('[BACKGROUND] Resolution metrics loaded:', selectorResolutionMetrics);
        }
        if (stored[SELECTOR_HEALTH_FAILURES_KEY]) {
            Object.assign(selectorFailureMetrics, stored[SELECTOR_HEALTH_FAILURES_KEY]);
        }
        if (stored[SELECTOR_HEALTH_META_KEY]) {
            selectorHealthMeta.updatedAt = stored[SELECTOR_HEALTH_META_KEY].updatedAt || null;
            selectorHealthMeta.perKey = stored[SELECTOR_HEALTH_META_KEY].perKey || {};
        }
        if (stored[SELECTOR_HEALTH_CHECKS_KEY]) {
            Object.assign(selectorHealthChecks, stored[SELECTOR_HEALTH_CHECKS_KEY]);
        }
    } catch (e) {
        console.warn('[BACKGROUND] Failed to load resolution metrics:', e);
    }
};

const persistResolutionMetrics = async () => {
    try {
        await chrome.storage.local.set({
            selectorResolutionMetrics,
            [SELECTOR_HEALTH_FAILURES_KEY]: selectorFailureMetrics,
            [SELECTOR_HEALTH_META_KEY]: selectorHealthMeta,
            [SELECTOR_HEALTH_CHECKS_KEY]: selectorHealthChecks
        });
    } catch (e) {
        console.warn('[BACKGROUND] Failed to persist resolution metrics:', e);
    }
};

const scheduleSelectorMetricsFlush = () => {
    if (selectorMetricsFlushTimer) return;
    selectorMetricsFlushTimer = setTimeout(() => {
        flushSelectorMetrics(false);
    }, SELECTOR_METRICS_FLUSH_MS);
};

const markSelectorMetricsDirty = () => {
    selectorMetricsDirty = true;
    scheduleSelectorMetricsFlush();
};

const flushSelectorMetrics = async (force = false) => {
    if (!force && !selectorMetricsDirty) return;
    if (selectorMetricsFlushInFlight) return;
    if (selectorMetricsFlushTimer) {
        clearTimeout(selectorMetricsFlushTimer);
        selectorMetricsFlushTimer = null;
    }
    selectorMetricsDirty = false;
    selectorMetricsFlushInFlight = true;
    try {
        await persistResolutionMetrics();
    } finally {
        selectorMetricsFlushInFlight = false;
    }
};

const buildSelectorHealthKey = (modelName, elementType) => `${modelName}::${elementType}`;

const touchSelectorHealthMeta = (modelName, elementType, ts = Date.now()) => {
    selectorHealthMeta.updatedAt = ts;
    if (!selectorHealthMeta.perKey || typeof selectorHealthMeta.perKey !== 'object') {
        selectorHealthMeta.perKey = {};
    }
    if (modelName && elementType) {
        const key = buildSelectorHealthKey(modelName, elementType);
        selectorHealthMeta.perKey[key] = ts;
    }
    return ts;
};

const recordResolutionMetric = async ({ modelName, elementType, layer }) => {
    if (!modelName || !elementType || !layer) return;
    const level = RESOLUTION_LAYER_MAP[layer] || layer;
    const key = `${modelName}_${elementType}_${level}`;
    selectorResolutionMetrics[key] = (selectorResolutionMetrics[key] || 0) + 1;
    touchSelectorHealthMeta(modelName, elementType);
    appendLogEntry(modelName, {
        type: 'SELECTOR',
        label: `${elementType}: слой ${level}`,
        details: '',
        level: level === 'L4' ? 'warning' : 'info',
        meta: { elementType, layer: level }
    });
    markSelectorMetricsDirty();
};

const recordSelectorFailureMetric = async ({ modelName, elementType, event }) => {
    if (!modelName || !elementType || !event) return;
    const status = event === 'selector_search_error' ? 'error' : 'fail';
    const key = `${modelName}_${elementType}_${status}`;
    selectorFailureMetrics[key] = (selectorFailureMetrics[key] || 0) + 1;
    touchSelectorHealthMeta(modelName, elementType);
    markSelectorMetricsDirty();
};

const updateSelectorHealthChecks = async (modelName, report = []) => {
    if (!modelName || !Array.isArray(report) || !report.length) return;
    const ts = Date.now();
    report.forEach((entry) => {
        if (!entry?.elementType) return;
        const key = buildSelectorHealthKey(modelName, entry.elementType);
        selectorHealthChecks[key] = {
            ts,
            success: !!entry.success,
            layer: entry.layer || null,
            selector: entry.selector || null,
            error: entry.error || null
        };
        touchSelectorHealthMeta(modelName, entry.elementType, ts);
    });
    markSelectorMetricsDirty();
};

const parseSelectorMetricKey = (key) => {
    const parts = String(key || '').split('_');
    if (parts.length < 3) return null;
    const suffix = parts.pop();
    const elementType = parts.pop();
    const modelName = parts.join('_') || 'unknown';
    return { modelName, elementType, suffix };
};

const parseSelectorHealthKey = (key) => {
    const [modelName = 'unknown', elementType = 'unknown'] = String(key || '').split('::');
    return { modelName, elementType };
};

const ensureSelectorHealthEntry = (map, modelName, elementType) => {
    const key = buildSelectorHealthKey(modelName, elementType);
    if (map.has(key)) return map.get(key);
    const entry = {
        modelName,
        elementType,
        counts: { L1: 0, L2: 0, L3: 0, L4: 0, fail: 0, error: 0, total: 0 },
        lastOverride: null,
        lastHealthCheck: null,
        activeUiVersion: null,
        activeTabId: null,
        lastUpdatedAt: null
    };
    map.set(key, entry);
    return entry;
};

const detectActiveUiVersionOnTab = async (modelName, tabId) => {
    try {
        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (model) => {
                if (!window.SelectorConfig || typeof window.SelectorConfig.detectUIVersion !== 'function') {
                    return { ok: false, error: 'SelectorConfig unavailable' };
                }
                const version = window.SelectorConfig.detectUIVersion(model, document) || 'unknown';
                return { ok: true, version };
            },
            args: [modelName]
        });
        if (result?.result?.ok) {
            return { ok: true, modelName, tabId, version: result.result.version || 'unknown' };
        }
        return { ok: false, modelName, tabId, error: result?.result?.error || 'active_version_failed' };
    } catch (err) {
        return { ok: false, modelName, tabId, error: err?.message || 'active_version_failed' };
    }
};

const fetchActiveUiVersions = async () => {
    const pairs = TabMapManager.entries();
    if (!pairs.length) return {};
    const results = await Promise.all(pairs.map(([modelName, tabId]) => detectActiveUiVersionOnTab(modelName, tabId)));
    const map = {};
    results.forEach((entry) => {
        if (entry?.ok) {
            map[entry.modelName] = { version: entry.version, tabId: entry.tabId };
        }
    });
    return map;
};

const buildSelectorHealthSummary = async ({ includeActiveVersions = false } = {}) => {
    const summaryMap = new Map();
    let latestOverrideTs = 0;
    let latestHealthCheckTs = 0;

    Object.entries(selectorResolutionMetrics).forEach(([key, count]) => {
        const parsed = parseSelectorMetricKey(key);
        if (!parsed) return;
        const entry = ensureSelectorHealthEntry(summaryMap, parsed.modelName, parsed.elementType);
        if (['L1', 'L2', 'L3', 'L4'].includes(parsed.suffix)) {
            entry.counts[parsed.suffix] += Number(count || 0);
        }
    });

    Object.entries(selectorFailureMetrics).forEach(([key, count]) => {
        const parsed = parseSelectorMetricKey(key);
        if (!parsed) return;
        if (parsed.suffix !== 'fail' && parsed.suffix !== 'error') return;
        const entry = ensureSelectorHealthEntry(summaryMap, parsed.modelName, parsed.elementType);
        entry.counts[parsed.suffix] += Number(count || 0);
    });

    const overrides = await readSelectorOverrideAudit(SELECTOR_OVERRIDE_AUDIT_LIMIT);
    overrides.forEach((entry) => {
        const modelName = entry.modelName || 'unknown';
        const elementType = entry.elementType || 'unknown';
        const summaryEntry = ensureSelectorHealthEntry(summaryMap, modelName, elementType);
        if (!summaryEntry.lastOverride) {
            summaryEntry.lastOverride = {
                ts: entry.ts || null,
                reason: entry.reason || '',
                selector: entry.selector || ''
            };
        }
        if (entry.ts) latestOverrideTs = Math.max(latestOverrideTs, entry.ts);
    });

    Object.entries(selectorHealthChecks).forEach(([key, entry]) => {
        const parsed = parseSelectorHealthKey(key);
        const summaryEntry = ensureSelectorHealthEntry(summaryMap, parsed.modelName, parsed.elementType);
        summaryEntry.lastHealthCheck = {
            ts: entry?.ts || null,
            success: !!entry?.success,
            layer: entry?.layer || null,
            error: entry?.error || null
        };
        if (entry?.ts) latestHealthCheckTs = Math.max(latestHealthCheckTs, entry.ts);
    });

    const activeVersions = includeActiveVersions ? await fetchActiveUiVersions() : {};
    summaryMap.forEach((entry) => {
        const activeMeta = activeVersions[entry.modelName];
        if (activeMeta) {
            entry.activeUiVersion = activeMeta.version || 'unknown';
            entry.activeTabId = activeMeta.tabId || null;
        }
        const key = buildSelectorHealthKey(entry.modelName, entry.elementType);
        entry.lastUpdatedAt = selectorHealthMeta.perKey?.[key] || null;
        entry.counts.total = entry.counts.L1 + entry.counts.L2 + entry.counts.L3 + entry.counts.L4 + entry.counts.fail + entry.counts.error;
    });

    const rows = Array.from(summaryMap.values()).sort((a, b) => {
        const byModel = a.modelName.localeCompare(b.modelName);
        if (byModel !== 0) return byModel;
        const order = { composer: 1, sendButton: 2, response: 3 };
        return (order[a.elementType] || 99) - (order[b.elementType] || 99);
    });
    const totalSamples = rows.reduce((acc, row) => acc + (row.counts.total || 0), 0);
    const updatedAt = Math.max(selectorHealthMeta.updatedAt || 0, latestOverrideTs, latestHealthCheckTs) || null;
    return { updatedAt, totalSamples, rows };
};

let initialStatePromise = null;
let initialStateReady = false;

function ensureInitialState() {
    if (!initialStatePromise) {
        initialStatePromise = (async () => {
            await Promise.all([loadJobState(), loadTabMapFromStorage()]);
            await loadResolutionMetrics();
            await loadCircuitBreakerState();
            initialStateReady = true;
        })().catch((err) => {
            initialStateReady = false;
            initialStatePromise = null;
            throw err;
        });
    }
    return initialStatePromise;
}

function isInitialStateReady() {
    return initialStateReady;
}

ensureInitialState().catch((err) => {
    console.error('[BACKGROUND] Failed to preload initial state:', err);
});


let evaluatorTabId = null;

const getStoredVersionStatus = async () => {
    try {
        const { selectors_version_status } = await chrome.storage.local.get('selectors_version_status');
        return selectors_version_status || null;
    } catch (err) {
        console.warn('[BACKGROUND] Failed to read version status snapshot', err);
        return null;
    }
};

const updateVersionStatusSnapshot = async () => {
    if (!self.SelectorConfig?.getAllVersionStatuses) {
        console.warn('[BACKGROUND] SelectorConfig not ready for version snapshot');
        return null;
    }
    const snapshot = {
        updatedAt: Date.now(),
        data: self.SelectorConfig.getAllVersionStatuses()
    };
    try {
        await chrome.storage.local.set({ selectors_version_status: snapshot });
    } catch (err) {
        console.warn('[BACKGROUND] Failed to persist version status snapshot', err);
    }
    return snapshot;
};

const primeVersionStatusAudit = async () => {
    await updateVersionStatusSnapshot();
    chrome.alarms.create(VERSION_STATUS_ALARM, { periodInMinutes: VERSION_STATUS_REFRESH_MINUTES });
};

const clearSelectorCache = async () => {
    try {
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all).filter((key) => key.startsWith('selector_cache'));
        if (keys.length) {
            await chrome.storage.local.remove(keys);
        }
        return keys.length;
    } catch (err) {
        console.warn('[BACKGROUND] Failed to clear selector cache', err);
        throw err;
    }
};

const runSelectorHealthCheckForTab = async (llmName, tabId) => {
    try {
        const [injectionResult] = await chrome.scripting.executeScript({
            target: { tabId },
            func: async (model) => {
                if (!window.SelectorFinder || typeof window.SelectorFinder.healthCheck !== 'function') {
                    return { ok: false, error: 'SelectorFinder.healthCheck unavailable' };
                }
                const report = await window.SelectorFinder.healthCheck({ modelName: model });
                return { ok: true, report };
            },
            args: [llmName]
        });
        return { llmName, tabId, ...(injectionResult?.result || { ok: false, error: 'No result' }) };
    } catch (err) {
        return { llmName, tabId, ok: false, error: err?.message || 'Execution failed' };
    }
};

const saveManualSelectorOverride = async (modelName, elementType, selector) => {
    if (!modelName || !elementType || !selector) {
        throw new Error('Invalid override payload');
    }
    const trimmedSelector = selector.trim();
    if (!trimmedSelector) {
        throw new Error('Selector is empty');
    }
    const { selectors_remote_override } = await chrome.storage.local.get('selectors_remote_override');
    const payload = selectors_remote_override || {};
    const manualOverrides = payload.manualOverrides || {};
    manualOverrides[modelName] = manualOverrides[modelName] || {};
    const bucket = Array.isArray(manualOverrides[modelName][elementType])
        ? manualOverrides[modelName][elementType]
        : [];
    if (!bucket.includes(trimmedSelector)) {
        bucket.unshift(trimmedSelector);
    }
    manualOverrides[modelName][elementType] = bucket.slice(0, 10);
    payload.manualOverrides = manualOverrides;
    await chrome.storage.local.set({ selectors_remote_override: payload });
    return manualOverrides;
};

const appendSelectorOverrideAudit = async (entry = {}) => {
    const payload = {
        ts: entry.ts || Date.now(),
        modelName: entry.modelName || 'unknown',
        elementType: entry.elementType || 'unknown',
        selector: entry.selector || '',
        reason: entry.reason || '',
        extVersion: entry.extVersion || chrome.runtime.getManifest()?.version || '',
        source: entry.source || 'devtools'
    };
    const res = await chrome.storage.local.get(SELECTOR_OVERRIDE_AUDIT_KEY);
    const list = Array.isArray(res?.[SELECTOR_OVERRIDE_AUDIT_KEY]) ? res[SELECTOR_OVERRIDE_AUDIT_KEY] : [];
    const next = [...list, payload].slice(-SELECTOR_OVERRIDE_AUDIT_LIMIT);
    await chrome.storage.local.set({ [SELECTOR_OVERRIDE_AUDIT_KEY]: next });
    return next;
};

const readSelectorOverrideAudit = async (limit = SELECTOR_OVERRIDE_AUDIT_LIMIT) => {
    const res = await chrome.storage.local.get(SELECTOR_OVERRIDE_AUDIT_KEY);
    const list = Array.isArray(res?.[SELECTOR_OVERRIDE_AUDIT_KEY]) ? res[SELECTOR_OVERRIDE_AUDIT_KEY] : [];
    if (limit && Number.isFinite(limit)) {
        return list.slice(-limit).reverse();
    }
    return list.slice().reverse();
};

const validateSelectorsOnTab = async (tabId, selectors = []) => {
    const list = Array.isArray(selectors) ? selectors.filter(Boolean) : [];
    if (!tabId || !list.length) return { ok: false, error: 'invalid_payload' };
    try {
        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (items) => {
                const safeText = (value, limit = 120) => {
                    const text = String(value || '').replace(/\s+/g, ' ').trim();
                    return text.length > limit ? `${text.slice(0, limit)}…` : text;
                };
                const results = (items || []).map((selector) => {
                    if (!selector || typeof selector !== 'string') {
                        return { selector, matches: 0, error: 'invalid_selector' };
                    }
                    try {
                        const nodes = Array.from(document.querySelectorAll(selector));
                        const sample = nodes[0];
                        return {
                            selector,
                            matches: nodes.length,
                            sample: sample
                                ? { tag: sample.tagName || '', text: safeText(sample.textContent || sample.innerText || '') }
                                : null
                        };
                    } catch (err) {
                        return { selector, matches: 0, error: err?.message || 'query_failed' };
                    }
                });
                return { ok: true, results };
            },
            args: [list]
        });
        return result?.result || { ok: false, error: 'no_result' };
    } catch (err) {
        return { ok: false, error: err?.message || 'execution_failed' };
    }
};

// --- V2.0 START: Health Check System ---
// NOTE: Health-check is advisory; it must never stop active jobs.
// Tabs can be temporarily unresponsive during navigation/throttling.
const HEALTH_CHECK_TIMEOUT_MS = 15000;   // 15 секунд
const HEALTH_CHECK_FAILURE_THRESHOLD = 3;
const HEALTH_CHECK_ERROR_COOLDOWN_MS = 30000;
const pendingPings = new Map();
const pendingPingByTabId = new Map();
const healthCheckFailuresByTabId = new Map();
const lastHealthCheckReportAtByTabId = new Map();

// Terminal statuses that indicate a session has completed (success or failure)
// Terminal statuses split into SUCCESS and FAILURE categories
const SUCCESS_STATUSES = ['COPY_SUCCESS', 'SUCCESS', 'DONE', 'PARTIAL', 'STREAM_TIMEOUT_HIDDEN'];
const FAILURE_STATUSES = [
    'ERROR',
    'CRITICAL_ERROR',
    'UNRESPONSIVE',
    'CIRCUIT_OPEN',
    'API_FAILED',
    'NO_SEND',
    'EXTRACT_FAILED',
    'STREAM_TIMEOUT'
];
const TERMINAL_STATUSES = [...SUCCESS_STATUSES, ...FAILURE_STATUSES];

function runHealthChecks() {
    const activeTabs = TabMapManager.entries();
    if (!activeTabs.length) {
        return;
    }

    // Avoid false alarms during active prompt dispatch (focus changes, navigation, CPU spikes).
    if (typeof promptDispatchInProgress === 'number' && promptDispatchInProgress > 0) {
        return;
    }

    console.log('[HEALTH-CHECK] Running checks for active tabs.');
    activeTabs.forEach(async ([llmName, tabId]) => {
        const entry = jobState?.llms?.[llmName];
        // Avoid false alarms before we even dispatch a prompt.
        if (entry && !entry.messageSent && !entry.dispatchInFlight) {
            return;
        }

        // Skip tabs that have already completed their session
        const sessionStatus = jobState?.llms?.[llmName]?.status;
        if (TERMINAL_STATUSES.includes(sessionStatus)) {
            console.log(`[HEALTH-CHECK] Skipping ${llmName} - session in terminal state: ${sessionStatus}`);
            return;
        }

        const hardStopped = await getHardStoppedTabs();
        if (hardStopped.has(tabId)) return;
        if (pendingPingByTabId.has(tabId)) return;
        const pingId = `${llmName}-${Date.now()}`;
        pendingPings.set(pingId, { llmName, tabId });
        pendingPingByTabId.set(tabId, pingId);

        chrome.tabs.sendMessage(tabId, { type: 'HEALTH_CHECK_PING', pingId: pingId }, (response) => {
            if (chrome.runtime.lastError) {
                console.error(`[HEALTH-CHECK] Immediate error pinging ${llmName} (tab ${tabId}).`, chrome.runtime.lastError.message);
                // No receiver / navigation / permission issues: clear pending ping to avoid counting a timeout.
                pendingPings.delete(pingId);
                if (pendingPingByTabId.get(tabId) === pingId) pendingPingByTabId.delete(tabId);
                return;
            }
            // Handle PONG response from content script's sendResponse
            if (response?.type === 'HEALTH_CHECK_PONG' && response?.pingId === pingId) {
                console.log(`[HEALTH-CHECK] PONG received from ${llmName} (via callback)`);
                pendingPings.delete(pingId);
                if (pendingPingByTabId.get(tabId) === pingId) pendingPingByTabId.delete(tabId);
                healthCheckFailuresByTabId.set(tabId, 0);
            }
        });

        setTimeout(() => {
            if (pendingPings.has(pingId)) {
                console.error(`[HEALTH-CHECK] Timeout: No PONG received from ${llmName} (tab ${tabId}).`);
                pendingPings.delete(pingId);
                if (pendingPingByTabId.get(tabId) === pingId) pendingPingByTabId.delete(tabId);

                // Skip counting failures while we're actively dispatching prompts.
                if (typeof promptDispatchInProgress === 'number' && promptDispatchInProgress > 0) {
                    return;
                }

                // Advisory only: never STOP_AND_CLEANUP all tabs from a single missed pong.
                const failures = (healthCheckFailuresByTabId.get(tabId) || 0) + 1;
                healthCheckFailuresByTabId.set(tabId, failures);

                if (failures >= HEALTH_CHECK_FAILURE_THRESHOLD) {
                    const now = Date.now();
                    const lastReportAt = lastHealthCheckReportAtByTabId.get(tabId) || 0;
                    if (now - lastReportAt >= HEALTH_CHECK_ERROR_COOLDOWN_MS) {
                        lastHealthCheckReportAtByTabId.set(tabId, now);
                        updateModelState(llmName, 'UNRESPONSIVE', {
                            message: `Tab for ${llmName} is unresponsive (${failures}× missed).`,
                            failures
                        });
                    }
                }
            }
        }, HEALTH_CHECK_TIMEOUT_MS);
    });
}
// --- V2.0 END: Health Check System ---

//-- 14.1. Heartbeat система для отслеживания активности content scripts --//
const HEARTBEAT_INTERVAL = 5000; // 5 секунд
const HEARTBEAT_TIMEOUT = 15000; // 15 секунд

let heartbeatTimer = null;

function startHeartbeatMonitor() {
    if (heartbeatTimer) return;
    
    console.log('[HEARTBEAT] Starting monitor...');
    heartbeatTimer = setInterval(async () => {
        const entries = TabMapManager.entries();
        if (!entries.length) {
            pendingPings.clear();
            stopHeartbeatMonitor();
            return;
        }

        // Filter to only active (non-terminal) sessions
        const activeEntries = entries.filter(([llmName]) => {
            const status = jobState?.llms?.[llmName]?.status;
            return !TERMINAL_STATUSES.includes(status);
        });

        if (!activeEntries.length) {
            console.log('[HEARTBEAT] All sessions in terminal state, stopping monitor');
            pendingPings.clear();
            stopHeartbeatMonitor();
            return;
        }

        runHealthChecks();
    }, HEARTBEAT_INTERVAL);
}

function stopHeartbeatMonitor() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        console.log('[HEARTBEAT] Monitor stopped');
    }
}

function clearPingState() {
    Object.keys(pingWindowByTabId).forEach((tabId) => delete pingWindowByTabId[tabId]);
    Object.keys(pingStartByTabId).forEach((tabId) => delete pingStartByTabId[tabId]);
}

function isRateLimited(llmName) {
    const until = rateLimitState.get(llmName);
    return typeof until === 'number' && until > Date.now();
}

function setRateLimit(llmName, ms = 60000, message = '') {
    const until = Date.now() + ms;
    rateLimitState.set(llmName, until);
    updateModelState(llmName, 'RATE_LIMIT', { message: message || `Rate limited until ${new Date(until).toLocaleTimeString()}` });
    broadcastGlobalState();
}

function scheduleAfterRateLimit(llmName, fn) {
    const until = rateLimitState.get(llmName);
    if (!until || until <= Date.now()) {
        rateLimitState.delete(llmName);
        fn();
        return;
    }
    if (rateLimitTimers.has(llmName)) return;
    const delay = Math.max(500, until - Date.now());
    const timerId = setTimeout(() => {
        rateLimitTimers.delete(llmName);
        rateLimitState.delete(llmName);
        fn();
    }, delay);
    rateLimitTimers.set(llmName, timerId);
}

function buildGlobalStateSnapshot() {
    const llms = {};
    Object.entries(jobState?.llms || {}).forEach(([name, entry]) => {
        const mappedTabId = TabMapManager.get(name);
        llms[name] = {
            status: entry?.status || 'UNKNOWN',
            hasAnswer: !!entry?.answer,
            tabId: entry?.tabId || mappedTabId || null,
            humanVisits: entry?.humanVisits || 0,
            messageSent: !!entry?.messageSent
        };
    });
    const tabsMap = {};
    TabMapManager.entries().forEach(([name, tabId]) => { tabsMap[name] = tabId; });
    return {
        llms,
        tabs: { map: tabsMap },
        ui: { resultsTabId },
        timestamp: Date.now()
    };
}

function broadcastGlobalState() {
    const state = buildGlobalStateSnapshot();
    TabMapManager.entries().forEach(([llmName, tabId]) => {
        if (!isValidTabId(tabId)) return;
        chrome.tabs.sendMessage(tabId, { type: 'GLOBAL_STATE_BROADCAST', state }).catch(() => {});
    });
    if (isValidTabId(resultsTabId)) {
        chrome.tabs.sendMessage(resultsTabId, { type: 'GLOBAL_STATE_BROADCAST', state }).catch(() => {});
    }
}

function stopAllProcesses(reason = 'unspecified', { closeTabs = false } = {}) {
    console.log(`[BACKGROUND] stopAllProcesses: reason=${reason}, closeTabs=${closeTabs}`);
    stopHumanPresenceLoop();
    stopHeartbeatMonitor();
    pendingPings.clear();
    pendingPingByTabId.clear();
    healthCheckFailuresByTabId.clear();
    lastHealthCheckReportAtByTabId.clear();

    const tabsToClose = [];
    TabMapManager.entries().forEach(([llmName, tabId]) => {
        if (!isValidTabId(tabId)) return;
        try {
            chrome.tabs.sendMessage(tabId, { type: 'STOP_AND_CLEANUP', reason }).catch(() => {});
        } catch (_) {}
        closePingWindowForTab(tabId);
        delete llmActivityMap[tabId];
        if (closeTabs) tabsToClose.push(tabId);
        if (jobState?.llms?.[llmName]) {
            jobState.llms[llmName].status = 'STOPPED';
        }
    });

    if (isValidTabId(evaluatorTabId)) {
        try {
            chrome.tabs.sendMessage(evaluatorTabId, { type: 'STOP_AND_CLEANUP', reason }).catch(() => {});
        } catch (_) {}
        if (closeTabs) tabsToClose.push(evaluatorTabId);
    }

    if (closeTabs && tabsToClose.length) {
        chrome.tabs.remove(tabsToClose, () => chrome.runtime.lastError);
    }

    clearActiveListeners();
    clearPingState();

    jobMetadata.clear();
    Object.keys(llmRequestMap).forEach((key) => delete llmRequestMap[key]);
    TabMapManager.clear();

    const timers = Array.from(postSuccessScrollTimers.values());
    postSuccessScrollTimers.clear();
    timers.forEach((id) => clearTimeout(id));

    Object.keys(deferredAnswerTimers).forEach((key) => {
        clearTimeout(deferredAnswerTimers[key]);
        delete deferredAnswerTimers[key];
    });

    rateLimitState.clear();
    rateLimitTimers.forEach((id) => clearTimeout(id));
    rateLimitTimers.clear();

    if (jobState && Object.keys(jobState).length) {
        try {
            chrome.storage.local.remove(['jobState']);
        } catch (_) {}
    }
    jobState = {};
    broadcastGlobalState();
}

// --- V2.0 START: API Fallback Config ---
const API_CONNECTION_TIMEOUT_MS = 2000;
const API_RESPONSE_TIMEOUT_MS = 5000;

const apiFallbackConfig = {
    'GPT': {
        endpoint: 'https://api.openai.com/v1/chat/completions',
        model: 'gpt-4-turbo-preview',
        storageKey: 'apiKey_openai',
        buildRequest: buildOpenAICompatibleRequest,
        parseResponse: parseOpenAICompatibleResponse,
        maxTokens: 4096
    },
    'Claude': {
        endpoint: 'https://api.anthropic.com/v1/messages',
        model: 'claude-3-opus-20240229',
        storageKey: 'apiKey_anthropic',
        maxTokens: 4096,
        buildRequest: buildAnthropicRequest,
        parseResponse: parseAnthropicResponse
    },
    'Gemini': {
        endpoints: [
            {
                url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent',
                model: 'gemini-1.5-flash-latest'
            },
            {
                url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent',
                model: 'gemini-1.5-pro-latest'
            },
            {
                url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
                model: 'gemini-pro'
            }
        ],
        model: 'gemini-1.5-flash-latest',
        storageKey: 'apiKey_google',
        buildRequest: buildGeminiRequest,
        parseResponse: parseGeminiResponse
    },
    'Grok': {
        endpoint: 'https://api.x.ai/v1/chat/completions',
        model: 'grok-beta',
        storageKey: 'apiKey_grok',
        buildRequest: buildOpenAICompatibleRequest,
        parseResponse: parseOpenAICompatibleResponse,
        maxTokens: 4096
    },
    'Le Chat': {
        endpoint: 'https://api.mistral.ai/v1/chat/completions',
        model: 'mistral-large-latest',
        storageKey: 'apiKey_lechat',
        buildRequest: buildOpenAICompatibleRequest,
        parseResponse: parseOpenAICompatibleResponse,
        maxTokens: 4096,
        extraHeaders: { 'Accept': 'application/json' }
    },
    'Qwen': {
        endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        model: 'qwen-turbo',
        storageKey: 'apiKey_qwen',
        buildRequest: buildOpenAICompatibleRequest,
        parseResponse: parseOpenAICompatibleResponse,
        maxTokens: 4096
    },
    'DeepSeek': {
        endpoint: 'https://api.deepseek.com/v1/chat/completions',
        model: 'deepseek-chat',
        storageKey: 'apiKey_deepseek',
        buildRequest: buildOpenAICompatibleRequest,
        parseResponse: parseOpenAICompatibleResponse,
        maxTokens: 4096
    },
    'Perplexity': {
        endpoint: 'https://api.perplexity.ai/chat/completions',
        model: 'sonar-small-online',
        storageKey: 'apiKey_perplexity',
        buildRequest: buildOpenAICompatibleRequest,
        parseResponse: parseOpenAICompatibleResponse,
        maxTokens: 4096
    }
};

function getApiEndpointMeta(config) {
    if (!config) return null;
    if (Array.isArray(config.endpoints) && config.endpoints.length) {
        const idx = Math.min(config._activeEndpointIndex || 0, config.endpoints.length - 1);
        const entry = config.endpoints[idx] || config.endpoints[0];
        return {
            endpoint: entry?.url || config.endpoint,
            model: entry?.model || config.model,
            index: idx,
            hasNext: idx < config.endpoints.length - 1
        };
    }
    return {
        endpoint: config.endpoint,
        model: config.model,
        index: null,
        hasNext: false
    };
}

function advanceApiEndpoint(config) {
    if (!config || !Array.isArray(config.endpoints) || !config.endpoints.length) return false;
    const idx = config._activeEndpointIndex || 0;
    if (idx >= config.endpoints.length - 1) {
        return false;
    }
    config._activeEndpointIndex = idx + 1;
    return true;
}

function buildOpenAICompatibleRequest(prompt, apiKey, config = {}) {
    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(config.extraHeaders || {})
    };
    const body = {
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        ...(config.extraBody || {})
    };
    if (config.maxTokens) {
        body.max_tokens = config.maxTokens;
    }
    return {
        url: config.endpoint,
        method: 'POST',
        headers,
        body
    };
}

function parseOpenAICompatibleResponse(data = {}) {
    if (!data) return '';
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (!choice) return '';
    if (choice.message?.content) {
        return choice.message.content;
    }
    if (typeof choice.text === 'string') {
        return choice.text;
    }
    return '';
}

function buildAnthropicRequest(prompt, apiKey, config = {}) {
    return {
        url: config.endpoint,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: {
            model: config.model,
            max_tokens: config.maxTokens || 1024,
            messages: [{ role: 'user', content: prompt }]
        }
    };
}

function parseAnthropicResponse(data = {}) {
    if (Array.isArray(data.content)) {
        return data.content
            .map(part => part?.text || '')
            .filter(Boolean)
            .join('\n');
    }
    if (typeof data?.content?.text === 'string') {
        return data.content.text;
    }
    return data?.content?.[0]?.text || '';
}

function buildGeminiRequest(prompt, apiKey, config = {}) {
    return {
        url: `${config.endpoint}?key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
            contents: [{ parts: [{ text: prompt }] }]
        }
    };
}

function parseGeminiResponse(data = {}) {
    const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
    if (!candidate) return '';
    const parts = candidate.content?.parts || candidate.parts || [];
    if (Array.isArray(parts)) {
        return parts.map(part => part?.text || '').filter(Boolean).join('\n');
    }
    return '';
}

function formatApiDetails(config, meta = null) {
    const endpoint = meta?.endpoint || config?.endpoint || '';
    if (!endpoint) return '';
    return `Endpoint: ${endpoint} | Timeouts ${API_CONNECTION_TIMEOUT_MS}ms/${API_RESPONSE_TIMEOUT_MS}ms`;
}

function buildApiStatusData(config, overrides = {}, meta = null) {
    return {
        endpoint: meta?.endpoint || config?.endpoint || '',
        connectionTimeout: API_CONNECTION_TIMEOUT_MS,
        responseTimeout: API_RESPONSE_TIMEOUT_MS,
        ...overrides
    };
}

function logApiEvent(llmName, label, level, config, extraDetails = '', meta = null) {
    const baseDetails = formatApiDetails(config, meta);
    const details = extraDetails ? `${baseDetails} – ${extraDetails}` : baseDetails;
    broadcastDiagnostic(llmName, {
        type: 'API',
        label,
        details,
        level: level || 'info'
    });
}

function handleApiFailureNotice(llmName, config, reason, silentOnFailure, meta = null) {
    logApiEvent(llmName, 'APi error, use WEB', 'api-error', config, reason || '', meta);
    updateModelState(llmName, 'API_FAILED', buildApiStatusData(config, {
        apiStatus: 'idle',
        message: 'APi error, use WEB',
        details: reason || ''
    }, meta));
    if (!silentOnFailure) {
        handleLLMResponse(
            llmName,
            `Error during API fallback: ${reason || 'API failure'}`,
            { type: 'fallback_failed' }
        );
    }
}
// --- V2.0 END: API Fallback Config ---

// --- V2.0 START: Circuit Breaker State ---
let circuitBreakerState = {};
const FAILURE_THRESHOLD = 3;
const COOLDOWN_PERIOD_MS = 5 * 60 * 1000; // 5 минут
const CIRCUIT_BREAKER_STORAGE_KEY = 'circuitBreakerState';

async function loadCircuitBreakerState() {
    try {
        const stored = await chrome.storage.local.get(CIRCUIT_BREAKER_STORAGE_KEY);
        if (stored[CIRCUIT_BREAKER_STORAGE_KEY]) {
            circuitBreakerState = stored[CIRCUIT_BREAKER_STORAGE_KEY];
            console.log('[BACKGROUND] Circuit breaker state restored from storage');
        }
    } catch (err) {
        console.warn('[BACKGROUND] Failed to load circuit breaker state:', err);
    }
}

async function persistCircuitBreakerState() {
    try {
        await chrome.storage.local.set({ [CIRCUIT_BREAKER_STORAGE_KEY]: circuitBreakerState });
    } catch (err) {
        console.warn('[BACKGROUND] Failed to persist circuit breaker state:', err);
    }
}

function initializeCircuitBreakers(llmNames) {
    llmNames.forEach(name => {
        if (!circuitBreakerState[name]) {
            circuitBreakerState[name] = { failures: 0, state: 'CLOSED', reopensAt: null };
        }
    });
    persistCircuitBreakerState();
}

function allowCircuitHalfOpenForNewRun(llmNames) {
    if (!Array.isArray(llmNames) || !llmNames.length) return;
    let changed = false;
    llmNames.forEach((name) => {
        const breaker = circuitBreakerState?.[name];
        if (!breaker) return;
        if (breaker.state === 'OPEN') {
            breaker.state = 'HALF_OPEN';
            breaker.failures = Math.max(0, FAILURE_THRESHOLD - 1);
            breaker.reopensAt = null;
            changed = true;
        }
    });
    if (changed) {
        console.log('[CIRCUIT-BREAKER] Reset OPEN circuits to HALF_OPEN for new run.');
        persistCircuitBreakerState();
    }
}

function updateCircuitBreaker(llmName, isSuccess) {
    if (!circuitBreakerState[llmName]) return;

    const breaker = circuitBreakerState[llmName];
    if (isSuccess) {
        if (breaker.state !== 'CLOSED') {
            console.log(`[CIRCUIT-BREAKER] ${llmName} recovered. State: CLOSED.`);
        }
        breaker.failures = 0;
        breaker.state = 'CLOSED';
        breaker.reopensAt = null;
    } else {
        breaker.failures++;
        console.log(`[CIRCUIT-BREAKER] ${llmName} failed. Failure count: ${breaker.failures}`);
        if (breaker.failures >= FAILURE_THRESHOLD) {
            breaker.state = 'OPEN';
            breaker.reopensAt = Date.now() + COOLDOWN_PERIOD_MS;
            console.error(`[CIRCUIT-BREAKER] ${llmName} is now OPEN. Will reopen at ${new Date(breaker.reopensAt).toLocaleTimeString()}`);
            updateModelState(llmName, 'CIRCUIT_OPEN', { message: 'Model temporarily disabled due to repeated failures.' });
        }
    }
    persistCircuitBreakerState();
}
// --- V2.0 END: Circuit Breaker State ---

async function broadcastCommandToLlmTabs(command) {
    if (!command) return { sent: 0 };
    try {
        const tabs = await chrome.tabs.query({ url: LLM_URL_PATTERNS, audible: false });
        const targets = tabs.filter((t) => t?.id);
        await Promise.all(targets.map((tab) =>
            chrome.tabs.sendMessage(tab.id, { type: 'EXECUTE_COMMAND', command }).catch(() => {})
        ));
        return { sent: targets.length };
    } catch (err) {
        console.warn('[COMMAND] broadcast failed', err);
        return { sent: 0, error: err?.message || String(err) };
    }
}

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    console.log(`[BACKGROUND] Вкладка ${tabId} была закрыта.`);
    closePingWindowForTab(tabId);
    removeActiveListenerForTab(tabId);
    delete llmActivityMap[tabId];
    if (pendingPings.size) {
        Array.from(pendingPings.entries()).forEach(([pingId, meta]) => {
            if (meta?.tabId === tabId) {
                pendingPings.delete(pingId);
            }
        });
    }
    pendingPingByTabId.delete(tabId);
    healthCheckFailuresByTabId.delete(tabId);
    lastHealthCheckReportAtByTabId.delete(tabId);
    let cleanupReason = null;
    let llmTabClosed = false;
    
    //-- 4.4. Cleanup при закрытии вкладок --//
    const closedLlmName = TabMapManager.getNameByTabId(tabId);
    if (closedLlmName) {
        console.log(`[BACKGROUND] LLM вкладка ${closedLlmName} закрыта, отправляем cleanup...`);
        emitTelemetry(closedLlmName, 'TAB_CLOSED', {
            details: 'llm_tab_closed',
            level: 'warning',
            meta: {
                tabId,
                windowId: removeInfo?.windowId ?? null,
                isWindowClosing: !!removeInfo?.isWindowClosing,
                reason: 'tab_removed'
            }
        });
        clearDeferredAnswerTimer(closedLlmName);
        llmTabClosed = true;
        if (jobState?.llms?.[closedLlmName]) {
            const status = jobState.llms[closedLlmName].status;
            const alreadyFinished = status === 'COPY_SUCCESS' || status === 'ERROR';
            if (!alreadyFinished) {
                handleLLMResponse(closedLlmName, 'Error: Tab closed during generation', {
                    type: 'tab_closed_prematurely'
                });
            }
            jobState.llms[closedLlmName].tabId = null;
            jobState.llms[closedLlmName].messageSent = false;
        }
        chrome.tabs.sendMessage(tabId, { type: 'STOP_AND_CLEANUP' }).catch(() => {});
        TabMapManager.removeByName(closedLlmName);
    }
    
    // Проверяем evaluator tab
    if (evaluatorTabId === tabId) {
        console.log(`[BACKGROUND] Evaluator tab закрыта.`);
        chrome.tabs.sendMessage(tabId, { type: 'STOP_AND_CLEANUP' }).catch(() => {});
        evaluatorTabId = null;
        cleanupReason = cleanupReason || 'evaluator_tab_closed';
    }
    
    // Проверяем results tab
    if (resultsTabId === tabId) {
        console.log(`[BACKGROUND] Results tab закрыта, очищаем все LLM сессии...`);
        TabMapManager.entries().forEach(([, llmTabId]) => {
            chrome.tabs.sendMessage(llmTabId, { type: 'STOP_AND_CLEANUP' }).catch(() => {});
        });
        resultsTabId = null;
        cleanupReason = cleanupReason || 'results_tab_closed';
    }

    const remainingLlms = Math.max(0, TabMapManager.entries().length - (llmTabClosed ? 1 : 0));
    if (!remainingLlms) {
        cleanupReason = cleanupReason || 'no_llm_tabs';
    }

    if (cleanupReason) {
        // Никогда не закрываем LLM-вкладки автоматически при закрытии results,
        // оставляем только очистку состояния.
        stopAllProcesses(cleanupReason, { closeTabs: false });
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("[BACKGROUND] Received message:", message);
    if (message?.type === 'NOTES_CMD' || message?.type === 'NOTES_EVENT') {
        return false;
    }

    const processMessage = () => {
        switch (message.type) {
            case 'START_FULLPAGE_PROCESS': {
                const forceNewTabs = message.forceNewTabs !== undefined ? message.forceNewTabs : true;
                const useApiFallback = message.useApiFallback !== undefined ? message.useApiFallback : cachedApiMode;
                startProcess(message.prompt, message.selectedLLMs, sender.tab.id, {
                    forceNewTabs,
                    useApiFallback,
                    attachments: Array.isArray(message.attachments) ? message.attachments : []
                });
                sendResponse({ status: 'process_started' });
                break;
            }
                
            case 'COLLECT_RESPONSES':
                collectResponses();
                sendResponse({ status: 'collecting_responses' });
                break;

            case 'SESSION_TABS_GET': {
                Promise.resolve().then(async () => {
                    const tabs = await getTrackedSessionTabs();
                    sendResponse({ status: 'ok', tabs });
                });
                return true;
            }

            case 'SESSION_TABS_OPEN': {
                const rawUrls = Array.isArray(message.urls) ? message.urls : [];
                const urls = rawUrls
                    .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url));
                Promise.resolve().then(async () => {
                    if (!urls.length) {
                        sendResponse({ status: 'empty', tabs: [] });
                        return;
                    }
                    const created = [];
                    for (const url of urls) {
                        const tab = await new Promise((resolve) => {
                            chrome.tabs.create({ url, active: false }, (newTab) => {
                                if (chrome.runtime.lastError || !newTab) {
                                    resolve(null);
                                    return;
                                }
                                resolve(newTab);
                            });
                        });
                        if (tab?.id) {
                            trackSessionTab(tab.id);
                            created.push({ tabId: tab.id, url: tab.url || url });
                        }
                    }
                    sendResponse({ status: 'opened', tabs: created });
                });
                return true;
            }
                
            case 'START_EVALUATION_WITH_PROMPT': {
                const shouldFocusEvaluator = message.openEvaluatorTab !== false;
                startEvaluation(
                    message.evaluationPrompt,
                    message.evaluatorLLM,
                    { openEvaluatorTab: shouldFocusEvaluator }
                );
                sendResponse({ status: 'evaluation_started_with_prompt' });
                break;
            }

            case 'LLM_RESPONSE':
                handleLLMResponse(
                    message.llmName,
                    message.answer,
                    message.error || null,
                    message.meta || null,
                    message.answerHtml || message.html || ''
                );
                sendResponse({ status: 'response_handled' });
                break;

            // Some content-scripts can emit FINAL_LLM_RESPONSE (e.g. evaluator flows).
            // Treat it the same as a regular LLM response to avoid "silent" drops.
            case 'FINAL_LLM_RESPONSE':
                handleLLMResponse(
                    message.llmName,
                    message.answer,
                    message.error || null,
                    message.meta || null,
                    message.answerHtml || message.html || ''
                );
                sendResponse({ status: 'final_response_handled' });
                break;

            case 'PROMPT_SUBMITTED': {
                const llmName = message.llmName;
                if (llmName && jobState?.llms?.[llmName]) {
                    const entry = jobState.llms[llmName];
                    const now = Date.now();

                    const incomingMeta = message?.meta && typeof message.meta === 'object' ? message.meta : null;
                    const expectedSessionId = Number(jobState?.session?.startTime || 0) || null;
                    const incomingSessionId = incomingMeta?.sessionId ? Number(incomingMeta.sessionId) : null;
                    const incomingDispatchId = typeof incomingMeta?.dispatchId === 'string' ? incomingMeta.dispatchId : null;
                    const recentDispatchIds = Array.isArray(entry?.recentDispatchIds) ? entry.recentDispatchIds : [];
                    const hasCorrelationMeta = !!(incomingSessionId || incomingDispatchId);

                    // If the content-script echoes dispatch meta, enforce matching to avoid cross-run pollution.
                    const metaMismatch = (() => {
                        if (!incomingMeta) return false;
                        if (expectedSessionId && incomingSessionId && incomingSessionId !== expectedSessionId) return true;
                        if (incomingDispatchId && recentDispatchIds.length && !recentDispatchIds.includes(incomingDispatchId)) return true;
                        return false;
                    })();

                    if (metaMismatch) {
                        emitTelemetry(llmName, 'PROMPT_SUBMITTED_REJECTED', {
                            details: 'meta_mismatch',
                            level: 'warning',
                            meta: {
                                dispatchId: incomingDispatchId || null,
                                sessionId: incomingSessionId || null,
                                expectedSessionId,
                                reason: 'meta_mismatch'
                            }
                        });
                        broadcastDiagnostic(llmName, {
                            type: 'DISPATCH',
                            label: 'PROMPT_SUBMITTED проигнорирован (не совпадает dispatch)',
                            details: `dispatchId=${incomingDispatchId || 'n/a'} sessionId=${incomingSessionId || 'n/a'} expectedSessionId=${expectedSessionId || 'n/a'}`,
                            level: 'warning'
                        });
                        sendResponse({ status: 'prompt_submitted_ack' });
                        break;
                    }

                    // Guard against late/stale PROMPT_SUBMITTED from an old run:
                    // only accept if we actually dispatched something recently.
                    const lastDispatchAt = Number(entry?.lastDispatchAt || 0);
                    const attempts = Number(entry?.dispatchAttempts || 0);
                    const ageMs = lastDispatchAt ? (now - lastDispatchAt) : null;
                    const inFlight = !!entry?.dispatchInFlight;
                    const stale = !inFlight && (attempts <= 0 || !lastDispatchAt || (typeof ageMs === 'number' && ageMs > 5 * 60 * 1000));
                    const confirmedFlag = typeof incomingMeta?.confirmed === 'boolean' ? incomingMeta.confirmed : null;

                    if (confirmedFlag === false) {
                        emitTelemetry(llmName, 'PROMPT_SUBMITTED_UNCONFIRMED', {
                            level: 'warning',
                            details: `attempts=${attempts} lastDispatchAgeMs=${ageMs ?? 'n/a'}`,
                            meta: {
                                dispatchId: incomingDispatchId || null,
                                sessionId: incomingSessionId || expectedSessionId || null,
                                confirmed: false
                            }
                        });
                        broadcastDiagnostic(llmName, {
                            type: 'DISPATCH',
                            label: 'Сигнал отправки без подтверждения',
                            details: `dispatchId=${incomingDispatchId || 'n/a'} sessionId=${incomingSessionId || 'n/a'}`,
                            level: 'warning'
                        });
                        sendResponse({ status: 'prompt_submitted_ack' });
                        break;
                    }

                    if (!entry.messageSent && (!stale || hasCorrelationMeta)) {
                        entry.promptSubmittedAt = now;
                        entry.messageSent = true;
                        entry.dispatchInFlight = false;
                        entry.csBusyUntil = 0;
                        entry.confirmedDispatchId = incomingDispatchId || entry?.lastDispatchMeta?.dispatchId || null;
                        saveJobState(jobState);
                        emitTelemetry(llmName, 'PROMPT_SUBMITTED_ACCEPTED', {
                            meta: {
                                dispatchId: entry.confirmedDispatchId,
                                sessionId: incomingSessionId || expectedSessionId || null,
                                confirmed: confirmedFlag !== false
                            }
                        });
                        broadcastDiagnostic(llmName, {
                            type: 'DISPATCH',
                            label: 'Сигнал подтверждения отправки из контента',
                            level: 'success'
                        });
                        resolvePromptSubmitted(llmName, { ok: true, ts: entry.promptSubmittedAt, meta: incomingMeta, dispatchId: entry.confirmedDispatchId });
                    } else if (stale) {
                        emitTelemetry(llmName, 'PROMPT_SUBMITTED_STALE', {
                            details: `attempts=${attempts} lastDispatchAgeMs=${ageMs ?? 'n/a'} inFlight=${inFlight}`,
                            level: 'warning',
                            meta: { reason: 'stale', dispatchId: incomingDispatchId || null }
                        });
                        broadcastDiagnostic(llmName, {
                            type: 'DISPATCH',
                            label: 'PROMPT_SUBMITTED проигнорирован (устарел)',
                            details: `attempts=${attempts} lastDispatchAgeMs=${ageMs ?? 'n/a'} inFlight=${inFlight}`,
                            level: 'warning'
                        });
                    }
                }
                sendResponse({ status: 'prompt_submitted_ack' });
                break;
            }

            // v2.54 (2025-12-19 19:36): Handle early ready signals from content scripts
            case 'SCRIPT_READY_EARLY': {
                const llmName = message.llmName;
                if (llmName) {
                    console.log(`[BACKGROUND] Early ready signal received from ${llmName}`);
                    resolveEarlyReadySignal(llmName);
                    sendResponse({ status: 'early_ready_ack' });
                } else {
                    sendResponse({ status: 'early_ready_ignored' });
                }
                break;
            }

            case 'HUMANOID_EVENT': {
                const event = message.event;
                const detail = message.detail || {};
                const source = detail.source || '';

                // Extract LLM name from source (e.g., "lechat:inject" -> "Le Chat")
                const llmName = (() => {
                    if (source.includes('lechat')) return 'Le Chat';
                    if (source.includes('claude')) return 'Claude';
                    if (source.includes('grok')) return 'Grok';
                    if (source.includes('chatgpt')) return 'ChatGPT';
                    if (source.includes('gemini')) return 'Gemini';
                    if (source.includes('deepseek')) return 'DeepSeek';
                    if (source.includes('qwen')) return 'Qwen';
                    if (source.includes('perplexity')) return 'Perplexity';
                    return null;
                })();

                if (!llmName) {
                    sendResponse({ status: 'humanoid_event_ignored' });
                    break;
                }

                // Handle different event types
                if (event === 'activity:heartbeat') {
                    const phase = detail.phase || '';
                    const status = (() => {
                        switch (phase) {
                            case 'composer-search':
                                return 'INITIALIZING';
                            case 'composer-ready':
                                return 'PROMPT_READY';
                            case 'typing':
                                return 'INJECTING';
                            case 'send-dispatched':
                                return 'SENDING';
                            case 'waiting-response':
                            case 'pipeline':
                                return 'RECEIVING';
                            case 'response-processed':
                                return 'COMPLETE';
                            default:
                                return null;
                        }
                    })();

                    if (status) {
                        updateModelState(llmName, status, {
                            phase,
                            progress: detail.progress || 0,
                            message: `Phase: ${phase}`
                        });
                    }
                } else if (event === 'activity:start') {
                    updateModelState(llmName, 'INITIALIZING', {
                        message: 'Starting activity...'
                    });
                } else if (event === 'activity:stop') {
                    // Don't change status - let handleLLMResponse set the final status
                    // Just log the lifecycle event
                    appendLogEntry(llmName, {
                        type: 'LIFECYCLE',
                        label: 'Activity lifecycle completed',
                        details: detail.answerLength ? `Answer received, length: ${detail.answerLength}` : '',
                        level: 'info'
                    });
                } else if (event === 'activity:error') {
                    // Only update status indicator for FATAL errors (selector not found, injection failed)
                    // Timeouts and pipeline errors are handled by handleLLMResponse
                    if (detail.fatal) {
                        updateModelState(llmName, 'CRITICAL_ERROR', {
                            message: detail.error || 'Critical error occurred'
                        });
                    }
                }

                sendResponse({ status: 'humanoid_event_processed' });
                break;
            }

            case 'CONTENT_CLEANING_STATS':
                console.log(`[BACKGROUND] Cleaning stats from ${message.llmName}:`, message.stats);
                sendResponse({ status: 'stats_received' });
                break;

            case 'METRICS_REPORT':
                console.log(`[BACKGROUND] Metrics report from ${message.llmName}:`, message.metrics);
                sendResponse({ status: 'metrics_received' });
                break;

            case 'SELECTOR_METRIC': {
                const event = message.event;
                const payload = message.payload || {};
                if (event === 'selector_search_failed' || event === 'selector_search_error') {
                    recordSelectorFailureMetric({
                        modelName: payload.modelName,
                        elementType: payload.elementType,
                        event
                    }).then(() => {
                        sendResponse({ status: 'metric_recorded' });
                    }).catch((err) => {
                        console.warn('[BACKGROUND] Failed to record selector metric', err);
                        sendResponse({ status: 'metric_error', error: err?.message });
                    });
                    return true;
                }
                sendResponse({ status: 'metric_ignored' });
                break;
            }

            case 'METRIC_EVENT':
                if (message.event === 'selector_resolution') {
                    recordResolutionMetric(message)
                        .then(() => sendResponse({ status: 'metric_recorded' }))
                        .catch((err) => {
                            console.warn('[BACKGROUND] Failed to record metric event', err);
                            sendResponse({ status: 'metric_error', error: err?.message });
                        });
                    return true;
                }
                sendResponse({ status: 'metric_ignored' });
                break;

            case 'STORE_TAB_STATE': {
                const tabId = sender?.tab?.id;
                if (!tabId || !message.state) {
                    sendResponse({ status: 'ignored' });
                    break;
                }
                const key = `state_${tabId}`;
                chrome.storage.local.set({ [key]: message.state }, () => {
                    sendResponse({ status: 'stored', key });
                });
                return true;
            }

            case 'GET_ALL_STATES': {
                chrome.storage.local.get(null, (all) => {
                    const raw = Object.entries(all || {}).filter(([k]) => k.startsWith('state_'));
                    const best = new Map();
                    raw.forEach(([key, value]) => {
                        const sid = value?.sessionId || key.replace('state_', '');
                        const platform = value?.platform || 'unknown';
                        const composite = `${platform}::${sid}`;
                        const existing = best.get(composite);
                        const score = key.includes(`${platform}_`) ? 2 : 1; // prefer platform-specific key
                        const existingScore = existing ? (existing.__score || 0) : 0;
                        if (!existing || score > existingScore || (score === existingScore && (value?.updatedAt || 0) > (existing.updatedAt || 0))) {
                            if (value) {
                                value.__score = score;
                                best.set(composite, value);
                            }
                        }
                    });
                    let states = Array.from(best.values())
                        .map((v) => { const { __score, ...rest } = v || {}; return rest; })
                        .sort((a, b) => (b?.updatedAt || 0) - (a?.updatedAt || 0));
                    const runFilter = message?.runId || message?.sessionId || null;
                    if (runFilter) {
                        states = states.filter((s) => s?.sessionId === runFilter);
                    }
                    sendResponse({ success: true, states });
                });
                return true;
            }

            case 'SUBMIT_PROMPT': {
                (async () => {
                    const commandId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                    const baseCommand = {
                        id: commandId,
                        action: 'submit_prompt',
                        payload: { prompt: message.prompt, platforms: message.platforms },
                        createdAt: Date.now()
                    };
                    const delivery = await broadcastCommandToLlmTabs(baseCommand);
                    const targetPlatforms = Array.isArray(message.platforms) && message.platforms.length
                        ? message.platforms
                        : Object.keys(LLM_TARGETS || {});
                    const pendingEntries = {};
                    targetPlatforms.forEach((platform) => {
                        const scopedCommand = Object.assign({}, baseCommand, {
                            payload: Object.assign({}, baseCommand.payload, { platforms: [platform] }),
                            targetPlatform: platform
                        });
                        pendingEntries[`pending_command_${platform}`] = scopedCommand;
                    });
                    try {
                        const targetStore = chrome.storage?.session || chrome.storage.local;
                        await targetStore.set(Object.assign({}, pendingEntries, { pending_command: baseCommand }));
                    } catch (_) {
                        await chrome.storage.local.set(Object.assign({}, pendingEntries, { pending_command: baseCommand }));
                    }
                    sendResponse({ success: true, commandId, delivered: delivery.sent, platforms: targetPlatforms });
                })();
                return true;
            }

            case 'STOP_ALL': {
                (async () => {
                    const cmd = { action: 'STOP_ALL', timestamp: Date.now(), platforms: message.platforms };
                    await chrome.storage.local.set({ global_command: cmd });
                    stopAllProcesses('stop_all_command', { closeTabs: false });
                    sendResponse({ success: true });
                })();
                return true;
            }

            case 'COLLECT_RESPONSES': {
                (async () => {
                    try {
                        const responses = await collectResponsesStaged?.();
                        sendResponse({ success: true, responses });
                    } catch (err) {
                        sendResponse({ success: false, error: err?.message || String(err) });
                    }
                })();
                return true;
            }

            case 'COMMAND_ACK': {
                (async () => {
                    try {
                        const { commandId, ack } = message || {};
                        const platformKey = ack?.platform ? `pending_command_${ack.platform}` : null;
                        const stores = [chrome.storage?.session, chrome.storage?.local].filter(Boolean);
                        await Promise.all(stores.map(async (store) => {
                            try {
                                const data = await store.get(null);
                                const keysToRemove = [];
                                if (platformKey) keysToRemove.push(platformKey);
                                // если не осталось других pending_command_ — убираем alias
                                const pendingKeys = Object.keys(data || {}).filter((k) => k.startsWith('pending_command_'));
                                if (pendingKeys.length <= 1) {
                                    keysToRemove.push('pending_command');
                                }
                                if (keysToRemove.length) await store.remove(keysToRemove);
                            } catch (_) {}
                        }));
                        sendResponse({ success: true });
                    } catch (err) {
                        sendResponse({ success: false, error: err?.message || String(err) });
                    }
                })();
                return true;
            }

            case 'SET_SETTINGS': {
                (async () => {
                    try {
                        const next = Object.assign({}, message.settings || {});
                        await chrome.storage.local.set({ settings: next });
                        try {
                            chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', settings: next });
                        } catch (_) {}
                        sendResponse({ success: true, settings: next });
                    } catch (err) {
                        sendResponse({ success: false, error: err?.message || String(err) });
                    }
                })();
                return true;
            }

            case 'GET_SETTINGS': {
                (async () => {
                    try {
                        const res = await chrome.storage.local.get(['settings']);
                        sendResponse({ success: true, settings: res?.settings || {} });
                    } catch (err) {
                        sendResponse({ success: false, error: err?.message || String(err) });
                    }
                })();
                return true;
            }

            case 'DIAG_EVENT': {
                (async () => {
                    try {
                        const evt = Object.assign({}, message.event || {}, {
                            ts: Date.now(),
                            platform: message.event?.platform || message.platform || null,
                            traceId: message.event?.traceId || null,
                            sessionId: message.event?.sessionId || null,
                            source: message.event?.source || sender?.url || sender?.tab?.url || null
                        });
                        const res = await chrome.storage.local.get(['__diagnostics_events__']);
                        const arr = Array.isArray(res?.__diagnostics_events__) ? res.__diagnostics_events__ : [];
                        let next = [...arr, evt].slice(-200); // первичное ограничение по количеству
                        // Дополнительный guard по размеру: если >50KB, отрезаем старые
                        const stringify = () => JSON.stringify(next);
                        while (stringify().length > 50000 && next.length > 1) {
                            next = next.slice(1);
                        }
                        await chrome.storage.local.set({ '__diagnostics_events__': next });
                        sendResponse({ success: true });
                    } catch (err) {
                        console.warn('[DIAG_EVENT] store failed', err);
                        sendResponse({ success: false, error: err?.message || String(err) });
                    }
                })();
                return true;
            }

            case 'GET_DIAG_EVENTS': {
                (async () => {
                    try {
                        const { platforms, limit } = message || {};
                        const res = await chrome.storage.local.get(['__diagnostics_events__']);
                        let arr = Array.isArray(res?.__diagnostics_events__) ? res.__diagnostics_events__ : [];
                        if (Array.isArray(platforms) && platforms.length) {
                            const set = new Set(platforms.map((p) => String(p).toLowerCase()));
                            arr = arr.filter((e) => set.has(String(e?.platform || 'unknown').toLowerCase()));
                        }
                        const capped = (limit && Number.isFinite(limit)) ? arr.slice(-limit) : arr.slice(-200);
                        sendResponse({ success: true, events: capped });
                    } catch (err) {
                        sendResponse({ success: false, error: err?.message || String(err) });
                    }
                })();
                return true;
            }

            case 'CLEAR_DIAG_EVENTS': {
                chrome.storage.local.set({ '__diagnostics_events__': [] }, () => {
                    sendResponse({ success: true });
                });
                return true;
            }

            case 'SMOKE_CHECK': {
                (async () => {
                    try {
                        const platform = message?.platform;
                        const tabId = message?.tabId;
                        const targetTabId = tabId || (await new Promise((resolve) => {
                            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs?.[0]?.id));
                        }));
                        if (!targetTabId) {
                            sendResponse({ success: false, error: 'no_tab' });
                            return;
                        }
                        const resp = await new Promise((resolve) => {
                            let settled = false;
                            const timer = setTimeout(() => {
                                if (settled) return;
                                settled = true;
                                resolve({ success: false, error: 'timeout' });
                            }, 5000);
                            try {
                                chrome.tabs.sendMessage(targetTabId, { type: 'SMOKE_CHECK', platform }, (r) => {
                                    if (settled) return;
                                    settled = true;
                                    clearTimeout(timer);
                                    resolve(r || { success: false, error: chrome.runtime.lastError?.message || 'no_response' });
                                });
                            } catch (err) {
                                if (settled) return;
                                settled = true;
                                clearTimeout(timer);
                                resolve({ success: false, error: err?.message || 'send_error' });
                            }
                        });
                        try {
                            const event = {
                                type: 'smoke_check',
                                platform: platform || null,
                                ts: Date.now(),
                                status: resp?.success ? 'ok' : 'fail',
                                details: resp?.error || `${(resp?.report || []).length || 0} selectors checked`,
                                report: resp?.report || null
                            };
                            const res = await chrome.storage.local.get(['__diagnostics_events__']);
                            const arr = Array.isArray(res?.__diagnostics_events__) ? res.__diagnostics_events__ : [];
                            const next = [...arr, event].slice(-200);
                            await chrome.storage.local.set({ '__diagnostics_events__': next });
                        } catch (_) {}
                        sendResponse(resp || { success: false, error: 'unknown' });
                    } catch (err) {
                        sendResponse({ success: false, error: err?.message || String(err) });
                    }
                })();
                return true;
            }

            case 'GET_COMMAND_STATUS': {
                (async () => {
                    try {
                        const sessionAll = (chrome.storage?.session && await chrome.storage.session.get(null)) || {};
                        const localAll = await chrome.storage.local.get(null);
                        const merged = Object.assign({}, localAll || {}, sessionAll || {});
                        const pendingList = Object.entries(merged)
                            .filter(([k]) => k.startsWith('pending_command_'))
                            .map(([, v]) => v)
                            .filter(Boolean)
                            .sort((a, b) => (b?.createdAt || 0) - (a?.createdAt || 0));
                        const pending = pendingList[0] || merged?.pending_command || null;
                        const platforms = Array.isArray(message.platforms) ? message.platforms : null;
                        const acks = Object.entries(merged || {})
                            .filter(([k]) => k.startsWith('cmd_ack_'))
                            .map(([, v]) => v)
                            .filter((v) => {
                                if (!platforms) return true;
                                return platforms.includes(v?.platform);
                            })
                            .sort((a, b) => (b?.executedAt || 0) - (a?.executedAt || 0))
                            .slice(0, 20);
                        const filteredPending = (!platforms || (pending && platforms.includes(pending?.payload?.platform))) ? pending : null;
                        sendResponse({ success: true, pending: filteredPending, acks });
                    } catch (err) {
                        sendResponse({ success: false, error: err?.message || String(err) });
                    }
                })();
                return true;
            }

            case 'EVALUATOR_RESPONSE':
                handleEvaluatorResponse(message.answer);
                sendResponse({ status: 'evaluator_response_handled' });
                break;
                
            case 'REGISTER_RESULTS_TAB':
                resultsTabId = sender.tab.id;
                console.log("[BACKGROUND] Registered results tab:", resultsTabId);
                sendResponse({ status: 'registered' });
                break;
            
            case 'REQUEST_SELECTOR_VERSION_STATUS': {
                (async () => {
                    let snapshot = null;
                    if (message.forceRefresh) {
                        snapshot = await updateVersionStatusSnapshot();
                    }
                    if (!snapshot) {
                        snapshot = await getStoredVersionStatus();
                    }
                    sendResponse({ status: 'ok', snapshot });
                })();
                return true;
            }

            case 'REQUEST_SELECTOR_HEALTH_SUMMARY': {
                (async () => {
                    try {
                        const summary = await buildSelectorHealthSummary({
                            includeActiveVersions: !!message.includeActiveVersions
                        });
                        sendResponse({ status: 'ok', summary });
                    } catch (err) {
                        sendResponse({ status: 'error', error: err?.message || 'health_summary_failed' });
                    }
                })();
                return true;
            }
            
            case 'REQUEST_SELECTOR_TELEMETRY':
                sendResponse({ status: 'ok', metrics: selectorResolutionMetrics });
                break;
            
            case 'REQUEST_SELECTOR_MODELS': {
                const models = Object.keys(self.SelectorConfig?.models || {});
                sendResponse({ status: 'ok', models });
                break;
            }

            case 'REQUEST_SELECTOR_DEFINITIONS': {
                const modelName = message.modelName;
                const cfg = self.SelectorConfig;
                if (!modelName || !cfg?.getModelConfig) {
                    sendResponse({ status: 'error', error: 'Unknown model' });
                    break;
                }
                const modelConfig = cfg.getModelConfig(modelName);
                if (!modelConfig) {
                    sendResponse({ status: 'error', error: 'Unknown model' });
                    break;
                }
                const versions = (modelConfig.versions || []).map((version) => {
                    const selectors = {};
                    SELECTOR_ELEMENT_TYPES.forEach((elementType) => {
                        selectors[elementType] = cfg.getSelectorsFor(modelName, version.version, elementType) || [];
                    });
                    return {
                        version: version.version,
                        uiRevision: version.uiRevision || '',
                        description: version.description || '',
                        selectors
                    };
                });
                sendResponse({ status: 'ok', modelName, versions });
                break;
            }

            case 'REQUEST_SELECTOR_ACTIVE_VERSION': {
                (async () => {
                    const modelName = message.modelName;
                    if (!modelName) {
                        sendResponse({ status: 'error', error: 'Missing model' });
                        return;
                    }
                    const tabId = await resolveTabForLlmNameAsync(modelName);
                    if (!tabId) {
                        sendResponse({ status: 'no_tab' });
                        return;
                    }
                    try {
                        const [result] = await chrome.scripting.executeScript({
                            target: { tabId },
                            func: (model, elementTypes) => {
                                if (!window.SelectorConfig || typeof window.SelectorConfig.detectUIVersion !== 'function') {
                                    return { ok: false, error: 'SelectorConfig unavailable' };
                                }
                                const version = window.SelectorConfig.detectUIVersion(model, document) || 'unknown';
                                const selectors = {};
                                elementTypes.forEach((elementType) => {
                                    selectors[elementType] = window.SelectorConfig.getSelectorsFor(model, version, elementType) || [];
                                });
                                return { ok: true, version, selectors };
                            },
                            args: [modelName, SELECTOR_ELEMENT_TYPES]
                        });
                        if (result?.result?.ok) {
                            sendResponse({ status: 'ok', tabId, version: result.result.version, selectors: result.result.selectors });
                        } else {
                            sendResponse({ status: 'error', error: result?.result?.error || 'active_version_failed' });
                        }
                    } catch (err) {
                        sendResponse({ status: 'error', error: err?.message || 'active_version_failed' });
                    }
                })();
                return true;
            }

            case 'VALIDATE_SELECTORS': {
                (async () => {
                    const modelName = message.modelName;
                    const selectors = Array.isArray(message.selectors) ? message.selectors : [];
                    if (!modelName || !selectors.length) {
                        sendResponse({ status: 'error', error: 'Missing selectors' });
                        return;
                    }
                    const tabId = await resolveTabForLlmNameAsync(modelName);
                    if (!tabId) {
                        sendResponse({ status: 'no_tab' });
                        return;
                    }
                    const result = await validateSelectorsOnTab(tabId, selectors);
                    if (result?.ok) {
                        sendResponse({ status: 'ok', results: result.results || [], tabId });
                    } else {
                        sendResponse({ status: 'error', error: result?.error || 'validation_failed' });
                    }
                })();
                return true;
            }

            case 'REQUEST_SELECTOR_OVERRIDE_AUDIT': {
                (async () => {
                    try {
                        const limit = Number.isFinite(message.limit) ? message.limit : SELECTOR_OVERRIDE_AUDIT_LIMIT;
                        const entries = await readSelectorOverrideAudit(limit);
                        sendResponse({ status: 'ok', entries });
                    } catch (err) {
                        sendResponse({ status: 'error', error: err?.message || 'audit_failed' });
                    }
                })();
                return true;
            }
            
            case 'SAVE_SELECTOR_OVERRIDE': {
                (async () => {
                    try {
                        const overrides = await saveManualSelectorOverride(message.modelName, message.elementType, message.selector);
                        await appendSelectorOverrideAudit({
                            modelName: message.modelName,
                            elementType: message.elementType,
                            selector: message.selector,
                            reason: message.reason || '',
                            source: 'devtools'
                        });
                        sendResponse({ status: 'ok', overrides: overrides[message.modelName] || {} });
                    } catch (err) {
                        sendResponse({ status: 'error', error: err?.message || 'Failed to save override' });
                    }
                })();
                return true;
            }

            case 'PICK_SELECTOR_START': {
                (async () => {
                    const { modelName, elementType, mode } = message;
                    if (!modelName) {
                        sendResponse({ status: 'error', error: 'Missing model' });
                        return;
                    }
                    const tabId = await resolveTabForLlmNameAsync(modelName);
                    if (!tabId) {
                        sendResponse({ status: 'error', error: 'Model tab not active' });
                        return;
                    }
                    const requestId = `pick-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
                    pickerRequests.set(requestId, { modelName, elementType, startedAt: Date.now() });
                    chrome.tabs.sendMessage(
                        tabId,
                        { type: 'PICKER_START', mode: mode || 'selector', requestId, elementType },
                        (response) => {
                            if (chrome.runtime.lastError) {
                                pickerRequests.delete(requestId);
                                sendResponse({ status: 'error', error: chrome.runtime.lastError.message });
                                return;
                            }
                            if (response && response.ok === false) {
                                pickerRequests.delete(requestId);
                                sendResponse({ status: 'error', error: response.error || 'Picker unavailable' });
                                return;
                            }
                            sendResponse({ status: 'ok', requestId });
                        }
                    );
                })();
                return true;
            }

            case 'PICKER_CANCEL': {
                (async () => {
                    const requestId = message.requestId || null;
                    const requestMeta = requestId ? pickerRequests.get(requestId) : null;
                    const modelName = message.modelName || requestMeta?.modelName || null;
                    if (requestId) pickerRequests.delete(requestId);
                    const tabId = modelName ? await resolveTabForLlmNameAsync(modelName) : null;
                    if (!tabId) {
                        sendResponse({ status: 'error', error: 'Model tab not active' });
                        return;
                    }
                    chrome.tabs.sendMessage(tabId, { type: 'PICKER_CANCEL', requestId }, () => {
                        if (chrome.runtime.lastError) {
                            sendResponse({ status: 'error', error: chrome.runtime.lastError.message });
                            return;
                        }
                        sendResponse({ status: 'ok' });
                    });
                })();
                return true;
            }

            case 'HIGHLIGHT_SELECTOR': {
                const { modelName, selector } = message;
                (async () => {
                    const tabId = await resolveTabForLlmNameAsync(modelName);
                    if (!tabId) {
                        sendResponse({ status: 'error', error: 'Model tab not active' });
                        return;
                    }
                    chrome.scripting.executeScript({
                        target: { tabId },
                        func: (cssSelector) => {
                            if (!window.SelectorFinder || typeof window.SelectorFinder.previewSelector !== 'function') {
                                return { ok: false, error: 'Preview unavailable' };
                            }
                            const success = window.SelectorFinder.previewSelector(cssSelector);
                            return { ok: success };
                        },
                        args: [selector]
                    }).then(([result]) => {
                        if (result?.result?.ok) {
                            sendResponse({ status: 'ok' });
                        } else {
                            sendResponse({ status: 'error', error: result?.result?.error || 'No response' });
                        }
                    }).catch((err) => {
                        sendResponse({ status: 'error', error: err?.message || 'Highlight failed' });
                    });
                })();
                return true;
            }

            case 'PICKER_RESULT': {
                const requestId = message.requestId || null;
                const requestMeta = requestId ? pickerRequests.get(requestId) : null;
                if (requestId) pickerRequests.delete(requestId);
                sendMessageToResultsTab({
                    type: 'PICKER_RESULT',
                    requestId,
                    payload: message.payload || null,
                    modelName: requestMeta?.modelName || null,
                    elementType: requestMeta?.elementType || null
                });
                sendResponse({ status: 'ok' });
                break;
            }

            case 'PICKER_CANCELLED': {
                const requestId = message.requestId || null;
                if (requestId) pickerRequests.delete(requestId);
                sendMessageToResultsTab({
                    type: 'PICKER_CANCELLED',
                    requestId,
                    reason: message.reason || null
                });
                sendResponse({ status: 'ok' });
                break;
            }

        case 'HUMAN_VISIT_CONTROL':
            handleHumanVisitControl(message.action);
            sendResponse({ status: 'ok' });
            break;

        case 'HUMAN_VISIT_MODEL_TOGGLE':
            handleHumanVisitModelToggle(message.llmName, message.enabled);
            sendResponse({ status: 'ok' });
            break;

        case 'REQUEST_HUMAN_VISIT_STATUS':
            sendResponse({ status: 'ok', payload: {
                active: humanPresenceActive,
                paused: humanPresencePaused,
                stopped: humanPresenceManuallyStopped,
                pending: hasPendingHumanVisits(),
                llms: jobState?.llms
                    ? Object.entries(jobState.llms).map(([name, entry]) => ({
                        name,
                        status: entry?.status || 'IDLE',
                        visits: entry?.humanVisits || 0,
                        stalled: !!entry?.humanStalled,
                        skipped: !!entry?.skipHumanLoop
                    }))
                    : []
            }});
            break;

            case 'CLEAR_SELECTOR_CACHE': {
                (async () => {
                    try {
                        const removed = await clearSelectorCache();
                        sendResponse({ status: 'ok', removed });
                    } catch (err) {
                        sendResponse({ status: 'error', error: err?.message || 'Failed to clear cache' });
                    }
                })();
                return true;
            }

            case 'RUN_SELECTOR_HEALTHCHECK': {
                (async () => {
                    const pairs = TabMapManager.entries();
                    if (!pairs.length) {
                        sendResponse({ status: 'error', error: 'Нет активных LLM-вкладок для проверки' });
                        return;
                    }
                    const results = await Promise.all(pairs.map(([llmName, tabId]) => runSelectorHealthCheckForTab(llmName, tabId)));
                    await Promise.all(results.map((entry) => {
                        if (entry?.ok && Array.isArray(entry.report)) {
                            return updateSelectorHealthChecks(entry.llmName, entry.report);
                        }
                        return Promise.resolve();
                    }));
                    results.forEach((entry) => {
                        appendLogEntry(entry.llmName, {
                            type: 'SELECTOR_HEALTH',
                            label: entry.ok ? 'Health-check success' : 'Health-check failed',
                            details: entry.ok ? '' : entry.error,
                            level: entry.ok ? 'info' : 'warning'
                        });
                    });
                    sendResponse({ status: 'ok', results });
                })();
                return true;
            }

            case 'HEALTH_CHECK_PONG':
                if (pendingPings.has(message.pingId)) {
                    const meta = pendingPings.get(message.pingId);
                    console.log(`[HEALTH-CHECK] PONG received from ${meta.llmName}`);
                    pendingPings.delete(message.pingId);
                    if (meta?.tabId && pendingPingByTabId.get(meta.tabId) === message.pingId) {
                        pendingPingByTabId.delete(meta.tabId);
                        healthCheckFailuresByTabId.delete(meta.tabId);
                        lastHealthCheckReportAtByTabId.delete(meta.tabId);
                    }
                }
                sendResponse({ status: 'pong_received' });
                break;

            case 'CLOSE_ALL_SESSIONS':
                closeAllSessions();
                sendResponse({ status: 'sessions_closed' });
                break;
                
            //-- 4.5. Ручная команда cleanup из UI --//
        case 'CLEAR_ALL_SESSIONS':
            TabMapManager.entries().forEach(([llmName, tabId]) => {
                chrome.tabs.sendMessage(tabId, { type: 'STOP_AND_CLEANUP' }).catch(() => {});
            });
            TabMapManager.clear();
            jobState = {};
            clearAllDeferredAnswerTimers();
            stopHumanPresenceLoop();
            finalizeTabVisit('session_cleared');
            humanPresencePaused = false;
            humanPresenceManuallyStopped = false;
            Object.keys(llmActivityMap).forEach((tabId) => delete llmActivityMap[tabId]);
            clearActiveListeners();
            broadcastGlobalState();
            sendResponse({ status: 'all_sessions_cleared' });
            break;

            case 'MANUAL_RESPONSE_PING': {
                const result = handleManualResponsePing(message.llmName);
                sendResponse(result);
                break;
            }

            case 'LLM_DIAGNOSTIC_EVENT': {
                const event = message.event || {};
                const resolvedName = resolveEventLlmName(message, event, sender);
                if (!resolvedName) {
                    sendResponse({ status: 'diagnostic_missing_llm' });
                    break;
                }
                if (isTelemetryEntry(event)) {
                    const saved = dispatchTelemetry(resolvedName, event, { sender, source: event?.source });
                    sendResponse({ status: 'diagnostic_logged', stored: !!saved, sampled: !!saved });
                    break;
                }
                const saved = broadcastDiagnostic(resolvedName, event);
                updateTypingStateFromDiagnostic(resolvedName, saved || event);
                (async () => {
                    try {
                        await persistDiagnosticEvent(resolvedName, saved || event, { sender, source: event?.source });
                        sendResponse({ status: 'diagnostic_logged', stored: true });
                    } catch (err) {
                        console.warn('[LLM_DIAGNOSTIC_EVENT] store failed', err);
                        sendResponse({ status: 'diagnostic_logged', stored: false, error: err?.message || String(err) });
                    }
                })();
                return true;
            }

            case 'PIPELINE_EVENT': {
                const event = message.event || {};
                const resolvedName = resolveEventLlmName(message, event, sender);
                const payload = {
                    ...event,
                    type: event.type || 'PIPELINE',
                    label: event.label || event.event || event?.meta?.event || 'PIPELINE'
                };
                const force = ['PIPELINE_COMPLETE', 'FINALIZATION_DONE', 'STREAMING_DONE'].includes(payload.label);
                const saved = dispatchTelemetry(resolvedName, payload, { sender, source: event?.source, force });
                sendResponse({ status: 'pipeline_logged', stored: !!saved, sampled: !!saved });
                break;
            }

            case 'TELEMETRY_EVENT': {
                const event = message.event || {};
                const resolvedName = resolveEventLlmName(message, event, sender);
                const label = event.phase || event.event || 'TELEMETRY_EVENT';
                const payload = {
                    type: 'TELEMETRY',
                    label,
                    details: event.reason || event.message || '',
                    level: event.level || 'info',
                    meta: { ...event, event: label }
                };
                const saved = dispatchTelemetry(resolvedName, payload, { sender, source: event?.source });
                sendResponse({ status: 'telemetry_logged', stored: !!saved, sampled: !!saved });
                break;
            }
            case 'REFRESH_SELECTOR_OVERRIDES': {
                if (!remoteSelectorsAllowed) {
                    const result = { success: false, error: 'remote_overrides_disabled' };
                    sendMessageToResultsTab({ type: 'SELECTOR_OVERRIDE_REFRESH_RESULT', result });
                    sendResponse({ status: 'rejected', reason: 'remote_overrides_disabled' });
                    break;
                }
                fetchRemoteSelectors()
                    .then((result) => {
                        sendMessageToResultsTab({ type: 'SELECTOR_OVERRIDE_REFRESH_RESULT', result });
                    })
                    .catch((err) => {
                        sendMessageToResultsTab({
                            type: 'SELECTOR_OVERRIDE_REFRESH_RESULT',
                            result: { success: false, error: err?.message || 'refresh failed' }
                        });
                    });
                sendResponse({ status: 'accepted' });
                break;
            }
            case 'CLEAR_SELECTOR_OVERRIDES_AND_CACHE': {
                clearSelectorOverridesAndCache()
                    .then((result) => {
                        sendMessageToResultsTab({
                            type: 'SELECTOR_OVERRIDE_CLEARED',
                            success: true,
                            removed: result.removed || []
                        });
                    })
                    .catch((err) => {
                        sendMessageToResultsTab({
                            type: 'SELECTOR_OVERRIDE_CLEARED',
                            success: false,
                            error: err?.message || 'cleanup failed'
                        });
                    });
                sendResponse({ status: 'accepted' });
                break;
            }
            case 'MANUAL_RESEND_REQUEST': {
                console.log('[BACKGROUND] Manual resend handler invoked for', message.llmName);
                Promise.resolve().then(() => {
                    let result;
                    try {
                        result = handleManualResendRequest(message.llmName);
                    } catch (err) {
                        console.error('[BACKGROUND] Manual resend handler crashed:', err);
                        result = {
                            status: 'manual_resend_failed',
                            error: err?.message || 'Unexpected manual resend error'
                        };
                    }
                    console.log('[BACKGROUND] Manual resend handler replying', result);
                    try {
                        sendResponse(result);
                    } catch (err) {
                        console.error('[BACKGROUND] Failed to send manual resend response:', err);
                    }
                });
                return true;
            }
            case 'MANUAL_PING_RESULT': {
                if (message.llmName && message.status === 'failed') {
                    broadcastDiagnostic(message.llmName, {
                        type: 'PING_ERROR',
                        label: 'Ручной ping завершился ошибкой',
                        details: message.error || 'unknown',
                        level: 'error'
                    });
                }
                sendMessageToResultsTab(message);
                sendResponse({ status: 'manual_ping_notified' });
                break;
            }
            default:
                sendResponse({ status: 'unknown_message' });
                break;
        }
        return false;
    };

    const runSafely = () => {
        try {
            return processMessage();
        } catch (err) {
            console.error('[BACKGROUND] Failed to process runtime message:', err);
            try {
                sendResponse({ status: 'error', error: err?.message || 'internal_error' });
            } catch (responseErr) {
                console.error('[BACKGROUND] Failed to respond with error:', responseErr);
            }
            return false;
        }
    };

    if (!isInitialStateReady()) {
        ensureInitialState()
            .then(runSafely)
            .catch((err) => {
                console.error('[BACKGROUND] Failed to initialize state before handling message:', err);
                try {
                    sendResponse({ status: 'error', error: err?.message || 'initialization_failed' });
                } catch (responseErr) {
                    console.error('[BACKGROUND] Failed to respond with initialization error:', responseErr);
                }
            });
        return true;
    }

    return runSafely();
});

function removeActiveListenerForTab(tabId) {
    const entry = activeListeners.get(tabId);
    if (!entry) return;
    try {
        chrome.tabs.onUpdated.removeListener(entry.listener);
        console.log(`[BACKGROUND] Removed listener for tab ${tabId}`);
    } catch (e) {
        console.warn(`[BACKGROUND] Error removing listener for tab ${tabId}:`, e);
    }
    if (entry.timeoutId) {
        clearTimeout(entry.timeoutId);
    }
    activeListeners.delete(tabId);
}

function clearActiveListeners() {
    Array.from(activeListeners.keys()).forEach(removeActiveListenerForTab);
}

function startProcess(prompt, selectedLLMs, resultsTab, options = {}) {
    const forceNewTabs = options.forceNewTabs !== undefined ? options.forceNewTabs : true;
    const useApiFallback = options.useApiFallback !== undefined ? options.useApiFallback : true;
    const attachments = Array.isArray(options.attachments) ? options.attachments : [];
    console.log(`[BACKGROUND] Starting process. Force new tabs: ${forceNewTabs}. Use API: ${useApiFallback}. LLMs:`, selectedLLMs);
    resultsTabId = resultsTab;
    jobMetadata.clear();
    Object.keys(llmRequestMap).forEach((key) => delete llmRequestMap[key]);
    stopHumanPresenceLoop();

    //-- 11.2. Инициализация jobState с сохранением --//
    // v2.54.24 (2025-12-22 23:14 UTC): Sample telemetry once per run (Purpose: keep consistent sampling for the session).
    const sessionStartTime = Date.now();
    const telemetrySampled = resolveTelemetrySampling(sessionStartTime);
    jobState = {
        prompt: prompt,
        llms: {},
        responsesCollected: 0,
        evaluationStarted: false,
        useApiFallback,
        session: {
            startTime: sessionStartTime,
            totalModels: selectedLLMs.length,
            completed: 0,
            failed: 0,
            telemetrySampled,
            telemetrySampleRate: TELEMETRY_SAMPLE_RATE
        },
        attachments
    };
    humanPresencePaused = false;
    humanPresenceManuallyStopped = false;
    saveJobState(jobState);

    initializeCircuitBreakers(selectedLLMs);
    // New run should always attempt at least once, even if a previous run tripped the breaker.
    allowCircuitHalfOpenForNewRun(selectedLLMs);
    //-- 14.2. Запуск heartbeat мониторинга --//
    startHeartbeatMonitor();
    broadcastGlobalState();

    selectedLLMs.forEach(llmName => {
        jobState.llms[llmName] = {
            ...(LLM_TARGETS[llmName] || {}),
            tabId: null,
            answer: null,
            messageSent: false,
            dispatchInFlight: false,
            csBusyUntil: 0,
            dispatchAttempts: 0,
            lastDispatchAt: 0,
            lastDispatchMeta: null,
            recentDispatchIds: [],
            confirmedDispatchId: null,
            status: 'IDLE',
            logs: [],
            humanVisits: 0,
            humanStalled: false,
            skipHumanLoop: false,
            humanVisitDurations: [],
            humanVisitTotalMs: 0,
            typingActive: false,
            typingStartedAt: null,
            typingEndedAt: null,
            typingGuardUntil: 0,
            typingGuardReason: null
        };
        updateModelState(llmName, 'IDLE', { apiStatus: 'idle' });
        emitTelemetry(llmName, 'RUN_START', {
            details: `models=${selectedLLMs.length}`,
            meta: {
                sessionId: jobState.session.startTime,
                totalModels: selectedLLMs.length,
                selectedModels: selectedLLMs,
                forceNewTabs,
                useApiFallback,
                source: 'start_process'
            }
        });
    });
    broadcastHumanVisitStatus();

    selectedLLMs.forEach(llmName => {
        startModelForLLM(llmName, prompt, forceNewTabs, attachments);
    });
    schedulePromptDispatchSupervisor();
}

function startModelForLLM(llmName, prompt, forceNewTabs, attachments = []) {
    const chain = llmStartChains[llmName] || Promise.resolve();
    llmStartChains[llmName] = chain.then(async () => {
        if (isRateLimited(llmName)) {
            console.log(`[RATE-LIMIT] ${llmName} is rate limited, scheduling retry`);
            scheduleAfterRateLimit(llmName, () => startModelForLLM(llmName, prompt, forceNewTabs, attachments));
            return;
        }
        const breaker = circuitBreakerState[llmName];
        if (breaker && breaker.state === 'OPEN') {
            if (Date.now() > breaker.reopensAt) {
                console.log(`[CIRCUIT-BREAKER] ${llmName} cooldown ended. Moving to HALF_OPEN.`);
                breaker.state = 'HALF_OPEN';
                breaker.failures = FAILURE_THRESHOLD - 1;
            } else {
                const remainingTime = Math.round((breaker.reopensAt - Date.now()) / 1000);
                console.log(`[CIRCUIT-BREAKER] Skipping ${llmName} as its circuit is OPEN. Retrying in ${remainingTime}s.`);
                const errorMsg = `Model is temporarily disabled due to repeated failures. Retrying in ${remainingTime}s.`;
                handleLLMResponse(llmName, `Error: ${errorMsg}`, { type: 'circuit_open' });
                updateModelState(llmName, 'CIRCUIT_OPEN', { message: errorMsg });
                return;
            }
        }

        let apiUsed = false;
        if (jobState.useApiFallback !== false) {
            apiUsed = await tryApiDirect(llmName, prompt);
            if (apiUsed) {
                return;
            }
        }

        runModelThroughTabs(llmName, prompt, forceNewTabs, attachments);
    }).catch((err) => {
        console.error(`[BACKGROUND] Failed to start ${llmName}:`, err);
    });
}

async function tryApiDirect(llmName, prompt) {
    const config = apiFallbackConfig[llmName];
    if (!config) return false;
    if (!jobState?.llms?.[llmName]) return false;
    if (jobState?.useApiFallback === false) return false;
    try {
        const storedData = await chrome.storage.local.get(config.storageKey);
        const apiKey = storedData?.[config.storageKey];
        if (!apiKey) {
            logApiEvent(llmName, 'API key missing, using web', 'warning', config, '', getApiEndpointMeta(config));
            return false;
        }
        initRequestMetadata(llmName, null, 'API');
        jobState.llms[llmName].messageSent = true;
        logApiEvent(llmName, 'API request initiated', 'info', config, '', getApiEndpointMeta(config));
        const success = await executeApiFallback(llmName, prompt, {
            silentOnFailure: true,
            apiKeyOverride: apiKey
        });
        return success;
    } catch (err) {
        console.warn(`[API] Could not read API key for ${llmName}:`, err?.message || err);
        return false;
    }
}

function runModelThroughTabs(llmName, prompt, forceNewTabs, attachments = []) {
    if (forceNewTabs) {
        detachExistingTab(llmName);
        createNewLlmTab(llmName, prompt, attachments);
        return;
    }

    const tabId = TabMapManager.get(llmName);
    if (tabId) {
        chrome.tabs.get(tabId, async (tab) => {
            if (chrome.runtime.lastError) {
                console.log(`[BACKGROUND] Tab for ${llmName} was closed. Creating a new one.`);
                emitTelemetry(llmName, 'TAB_REUSE_MISSING', {
                    details: chrome.runtime.lastError?.message || 'tab not found',
                    level: 'warning',
                    meta: { reason: 'reuse_tab', tabId }
                });
                TabMapManager.removeByName(llmName);
                broadcastGlobalState();
                tryAttachExistingTab(llmName, prompt, attachments).then(attached => {
                    if (!attached) {
                        createNewLlmTab(llmName, prompt, attachments);
                    }
                });
            } else {
                console.log(`[BACKGROUND] Reusing tab ${tabId} for ${llmName}.`);

                try {
                    emitTelemetry(llmName, 'TAB_REUSE_CANDIDATE', {
                        details: tab?.url || '',
                        meta: { snapshot: buildTabSnapshot(tab), reason: 'reuse_tab' }
                    });
                    const readiness = await ensureTabReadyForDispatch(tabId, llmName, { reason: 'reuse_tab' });
                    if (!readiness.ok) {
                        emitTelemetry(llmName, 'TAB_REUSE_REJECTED', {
                            details: readiness.reason || 'unknown',
                            level: 'warning',
                            meta: { snapshot: readiness.snapshot || null, reason: 'reuse_tab' }
                        });
                        broadcastDiagnostic(llmName, {
                            type: 'DISPATCH',
                            label: 'Сохраненная вкладка не готова для reuse',
                            details: readiness.reason || 'unknown',
                            level: 'warning',
                            meta: { snapshot: readiness.snapshot || null, dispatchReason: 'reuse_tab' }
                        });
                        TabMapManager.removeByName(llmName);
                        if (jobState?.llms?.[llmName]) {
                            jobState.llms[llmName].tabId = null;
                        }
                        broadcastGlobalState();
                        tryAttachExistingTab(llmName, prompt, attachments).then(attached => {
                            if (!attached) {
                                createNewLlmTab(llmName, prompt, attachments);
                            }
                        });
                        return;
                    }
                    await prepareTabForUse(tabId, llmName);

                    initRequestMetadata(llmName, tabId, readiness.tab?.url || tab?.url || (LLM_TARGETS[llmName]?.url) || '');
                    jobState.llms[llmName].tabId = tabId;
                    dispatchPromptToTab(llmName, tabId, prompt, attachments, 'reuse_tab');
                } catch (err) {
                    console.error(`[BACKGROUND] Failed to prepare tab for ${llmName}:`, err);
                    TabMapManager.removeByName(llmName);
                    broadcastGlobalState();
                    tryAttachExistingTab(llmName, prompt, attachments).then(attached => {
                        if (!attached) {
                            createNewLlmTab(llmName, prompt, attachments);
                        }
                    });
                }
            }
        });
    } else {
        console.log(`[BACKGROUND] No saved tab for ${llmName}. Looking for existing tabs...`);
        tryAttachExistingTab(llmName, prompt, attachments).then(attached => {
            if (!attached) {
                console.log(`[BACKGROUND] Existing tab not found. Creating new tab for ${llmName}.`);
                createNewLlmTab(llmName, prompt, attachments);
            }
        });
    }
}

function detachExistingTab(llmName) {
    const tabId = TabMapManager.get(llmName);
    if (!tabId) return;
    console.log(`[BACKGROUND] Detaching existing tab ${tabId} for ${llmName}`);
    chrome.tabs.sendMessage(tabId, { type: 'STOP_AND_CLEANUP' }).catch(() => {});
    removeActiveListenerForTab(tabId);
    closePingWindowForTab(tabId);
    TabMapManager.removeByName(llmName);
    broadcastGlobalState();
}

async function fetchRemoteSelectors() {
    if (!remoteSelectorsAllowed) {
        console.info('[REMOTE-SELECTORS] Skipped: remote overrides disabled');
        return { success: false, error: 'remote_overrides_disabled' };
    }
    if (!REMOTE_SELECTORS_URL) {
        return { success: false, error: 'REMOTE_SELECTORS_URL not configured' };
    }
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REMOTE_SELECTORS_FETCH_TIMEOUT_MS);
        const response = await fetch(REMOTE_SELECTORS_URL, {
            signal: controller.signal,
            cache: 'no-store'
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const payloadText = await response.text();
        if (REMOTE_SELECTORS_EXPECTED_SHA256) {
            const hash = await computeSha256Base64(payloadText);
            if (!hash) {
                throw new Error('Hash verification unavailable');
            }
            if (hash !== REMOTE_SELECTORS_EXPECTED_SHA256) {
                throw new Error('Override payload hash mismatch');
            }
        }
        const data = JSON.parse(payloadText);
        if (!data || typeof data !== 'object') {
            throw new Error('Invalid selectors override payload');
        }
        await chrome.storage.local.set({
            selectors_remote_override: data,
            selectors_remote_fetched_at: Date.now()
        });
        console.info('[REMOTE-SELECTORS] Override stored successfully');
        return { success: true };
    } catch (error) {
        console.warn('[REMOTE-SELECTORS] Fetch failed:', error?.message || error);
        return { success: false, error: error?.message || 'fetch failed' };
    }
}

async function computeSha256Base64(input) {
    try {
        const encoder = new TextEncoder();
        const data = encoder.encode(input);
        const digest = await crypto.subtle.digest('SHA-256', data);
        const bytes = Array.from(new Uint8Array(digest));
        return btoa(String.fromCharCode(...bytes));
    } catch (err) {
        console.warn('[REMOTE-SELECTORS] SHA-256 unavailable:', err?.message || err);
        return null;
    }
}

async function clearSelectorOverridesAndCache() {
    const all = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(all).filter((key) => {
        return key === 'selectors_remote_override' ||
            key === 'selectors_remote_fetched_at' ||
            key.startsWith('selector_cache_');
    });
    if (keysToRemove.length) {
        await chrome.storage.local.remove(keysToRemove);
    }
    console.info('[REMOTE-SELECTORS] Overrides/cache cleared:', keysToRemove);
    return { success: true, removed: keysToRemove };
}

if (remoteSelectorsAllowed) {
    fetchRemoteSelectors();
}

const generateRequestId = () => `llm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function initRequestMetadata(llmName, tabId, initialUrl = '') {
    if (!llmName) return null;
    const existingId = jobState?.llms?.[llmName]?.requestId || llmRequestMap[llmName];
    if (existingId) {
        return persistRequestMetadata(llmName, {
            tabId: tabId || null,
            url: initialUrl || '',
            requestId: existingId
        });
    }
    const requestId = generateRequestId();
    llmRequestMap[llmName] = requestId;
    if (jobState?.llms?.[llmName]) {
        jobState.llms[llmName].requestId = requestId;
    }
    const snapshot = {
        requestId,
        llmName,
        tabId: tabId || null,
        createdAt: Date.now(),
        url: initialUrl || '',
        completedAt: null
    };
    jobMetadata.set(requestId, snapshot);
    sendMessageToResultsTab({
        type: 'LLM_JOB_CREATED',
        requestId,
        llmName,
        metadata: {
            url: snapshot.url,
            createdAt: snapshot.createdAt,
            completedAt: snapshot.completedAt
        }
    });
    return snapshot;
}

function persistRequestMetadata(llmName, updates = {}) {
    if (!llmName) return null;
    let requestId = jobState?.llms?.[llmName]?.requestId || llmRequestMap[llmName];
    if (!requestId) {
        const fallback = initRequestMetadata(llmName, TabMapManager.get(llmName), updates.url || '');
        requestId = fallback?.requestId;
    }
    if (!requestId) return null;
    const existing = jobMetadata.get(requestId) || { requestId, llmName };
    const merged = { ...existing };
    merged.llmName = llmName;
    Object.entries(updates || {}).forEach(([key, value]) => {
        if (typeof value === 'undefined' || value === null) {
            return;
        }
        merged[key] = value;
    });
    jobMetadata.set(requestId, merged);
    return merged;
}

//-- ИСПРАВЛЕНО: Функция создания вкладки с условной инъекцией --//
function createNewLlmTab(llmName, prompt, attachments = []) {
    const llmConfig = jobState.llms[llmName];
    if (!llmConfig) return;

    chrome.tabs.create({ url: llmConfig.url, active: !!autoFocusNewTabsEnabled }, (tab) => {
        TabMapManager.setTab(llmName, tab.id);
        jobState.llms[llmName].tabId = tab.id;
        trackSessionTab(tab.id);
        console.log(`[BACKGROUND] Создана и сохранена вкладка для ${llmName}: ${tab.id}`);
        broadcastGlobalState();
        emitTelemetry(llmName, 'TAB_CREATED', {
            details: tab?.url || llmConfig.url || '',
            meta: {
                snapshot: buildTabSnapshot(tab),
                reason: 'create_new',
                autoFocus: !!autoFocusNewTabsEnabled
            }
        });

        initRequestMetadata(llmName, tab.id, tab.url || llmConfig.url || '');
        broadcastHumanVisitStatus();
        schedulePromptDispatchSupervisor();

        const listener = (tabId, changeInfo) => {
            if (tabId === tab.id && changeInfo.status === 'complete') {
                if (!jobState.llms[llmName].messageSent) {
                    console.log(`[BACKGROUND] Вкладка ${llmName} загружена, ставим в очередь отправку промпта.`);
                    dispatchPromptToTab(llmName, tab.id, prompt, attachments, 'tab_loaded');
                }
                removeActiveListenerForTab(tab.id);
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
        const timeoutId = setTimeout(() => {
            if (!activeListeners.has(tab.id)) {
                return;
            }
            removeActiveListenerForTab(tab.id);
        }, TAB_LOAD_TIMEOUT_MS);
        activeListeners.set(tab.id, { listener, timeoutId });
    });
}

function sendMessageSafely(tabId, llmName, message, attempt = 1) {
    console.log(`[BACKGROUND] Safely sending message to ${llmName} (tab ${tabId}), attempt ${attempt}`);
    if (attempt === 1) {
        updateModelState(llmName, 'GENERATING');
    }
    appendLogEntry(llmName, {
        type: 'COMMAND',
        label: `Отправка ${message?.type || 'команды'}`,
        details: `Попытка ${attempt}`,
        level: 'info',
        meta: { attempt, messageType: message?.type || 'UNKNOWN' }
    });
    const mappedTabId = TabMapManager.get(llmName);
    if (mappedTabId && mappedTabId !== tabId) {
        if (isValidTabId(mappedTabId)) {
            console.log(`[BACKGROUND] Tab mapping for ${llmName} changed (${tabId} -> ${mappedTabId}), rerouting command`);
            sendMessageSafely(mappedTabId, llmName, message, attempt);
        } else {
            console.warn(`[BACKGROUND] Tab mapping for ${llmName} is invalid (${mappedTabId}), aborting send`);
            handleLLMResponse(llmName, `Error: Tab reference for ${llmName} is invalid.`);
        }
        return;
    }
    extendPingWindowForTab(tabId, AUTO_PING_WINDOW_MS);

    if (!isValidTabId(tabId)) {
        console.error(`[BACKGROUND] Invalid tab id for ${llmName}:`, tabId);
        handleLLMResponse(llmName, `Error: Tab reference for ${llmName} is invalid.`);
        return;
    }

    chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
            console.error(`[BACKGROUND] Tab ${tabId} for ${llmName} not found.`, chrome.runtime.lastError?.message);
            appendLogEntry(llmName, {
                type: 'COMMAND',
                label: 'Вкладка недоступна',
                details: chrome.runtime.lastError?.message || 'Tab not found',
                level: 'error',
                meta: { messageType: message?.type || 'UNKNOWN' }
            });
            handleLLMResponse(llmName, `Error: Tab for ${llmName} was closed or could not be accessed.`);
            return;
        }

        console.log(`[BACKGROUND] Sending message to ${llmName}:`, message);
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
                const errMsg = chrome.runtime.lastError.message || '';
                console.error(`[BACKGROUND] Error sending message to ${llmName} on tab ${tabId}:`, errMsg);
                if (errMsg.includes('Could not establish connection') && attempt < 3) {
                    // v2.54 (2025-12-19 19:32): Optimized connection retry delays
                    // v2.54.2 (2025-12-19 20:00): Use conservative delays for bot-sensitive models
                    // Old: [2000, 4000, 6000] - Aggressive: [500, 1500, 3000]
                    // Conservative models (Grok) revert to old delays to avoid bot detection
                    const delays = getConnectionRetryDelaysForModel(llmName);
                    const retryDelay = delays[attempt - 1] || 3000;
                    console.warn(`[BACKGROUND] Retrying message to ${llmName} in ${retryDelay}ms (attempt ${attempt + 1})`);
                    setTimeout(() => {
                        const currentTabId = TabMapManager.get(llmName);
                        if (currentTabId !== tabId) {
                            console.log(`[BACKGROUND] Tab for ${llmName} changed (${tabId} -> ${currentTabId}), aborting retry`);
                            return;
                        }
                        sendMessageSafely(tabId, llmName, message, attempt + 1);
                    }, retryDelay);
                    return;
                }
                appendLogEntry(llmName, {
                    type: 'COMMAND',
                    label: 'Ошибка отправки команды',
                    details: errMsg,
                    level: 'error',
                    meta: { messageType: message?.type || 'UNKNOWN' }
                });
                handleLLMResponse(llmName, `Error: Could not establish connection with the ${llmName} tab. It might be unresponsive or still loading.`);
            } else {
                console.log(`[BACKGROUND] Message sent to ${llmName} successfully, response:`, response);
                appendLogEntry(llmName, {
                    type: 'COMMAND',
                    label: 'Команда доставлена',
                    details: message?.type || 'UNKNOWN',
                    level: 'success',
                    meta: { messageType: message?.type || 'UNKNOWN' }
                });
            }
        });
    });
}

function sendPassiveMessageWithRetries(tabId, llmName, message, {
    attempt = 1,
    maxAttempts = 3,
    baseDelay = 2000,
    onSuccess,
    onError
} = {}) {
    chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
            const errMsg = chrome.runtime.lastError?.message || 'Tab not found';
            console.warn(`[BACKGROUND] Passive message: tab ${tabId} for ${llmName} unavailable: ${errMsg}`);
            onError?.(errMsg);
            return;
        }

        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
                const errMsg = chrome.runtime.lastError.message || 'Unknown error';
                console.warn(`[BACKGROUND] Passive message error for ${llmName}:`, errMsg);
                if (errMsg.includes('Could not establish connection') && attempt < maxAttempts) {
                    const nextDelay = baseDelay * attempt;
                    console.log(`[BACKGROUND] Passive retry for ${llmName} in ${nextDelay}ms (attempt ${attempt + 1})`);
                    setTimeout(() => {
                        sendPassiveMessageWithRetries(tabId, llmName, message, {
                            attempt: attempt + 1,
                            maxAttempts,
                            baseDelay,
                            onSuccess,
                            onError
                        });
                    }, nextDelay);
                    return;
                }
                onError?.(errMsg);
            } else {
                onSuccess?.(response);
            }
        });
    });
}

function getQueryPatternsForLLM(llmName) {
    const entry = LLM_TARGETS[llmName];
    if (!entry || !entry.queryPatterns) return null;
    return Array.isArray(entry.queryPatterns) ? entry.queryPatterns : [entry.queryPatterns];
}

function tryAttachExistingTab(llmName, prompt, attachments = []) {
    return new Promise((resolve) => {
        const patterns = getQueryPatternsForLLM(llmName);
        if (!patterns || !patterns.length) {
            resolve(false);
            return;
        }
        chrome.tabs.query({ url: patterns, audible: false }, async (tabs) => {
            if (chrome.runtime.lastError || !tabs || !tabs.length) {
                resolve(false);
                return;
            }
            const eligibleTabs = tabs.filter((tab) => isEligibleTabForLlm(llmName, tab));
            if (!eligibleTabs.length) {
                emitTelemetry(llmName, 'ATTACH_REJECTED', {
                    details: `no eligible tabs (matched=${tabs.length})`,
                    level: 'warning',
                    meta: { reason: 'no_eligible_tabs', matchedCount: tabs.length }
                });
                resolve(false);
                return;
            }
            eligibleTabs.sort((a, b) => {
                const aTime = typeof a.lastAccessed === 'number' ? a.lastAccessed : 0;
                const bTime = typeof b.lastAccessed === 'number' ? b.lastAccessed : 0;
                return bTime - aTime;
            });
            const candidate = eligibleTabs[0];
            try {
                const candidateSnapshot = await captureTabSnapshot(candidate.id);
                emitTelemetry(llmName, 'ATTACH_CANDIDATE', {
                    details: candidate?.url || '',
                    meta: { snapshot: candidateSnapshot || null, reason: 'attach_existing' }
                });
                const readiness = await ensureTabReadyForDispatch(candidate.id, llmName, { reason: 'attach_existing' });
                if (!readiness.ok) {
                    emitTelemetry(llmName, 'ATTACH_REJECTED', {
                        details: readiness.reason || 'unknown',
                        level: 'warning',
                        meta: { snapshot: readiness.snapshot || null, reason: 'attach_existing' }
                    });
                    resolve(false);
                    return;
                }
                await prepareTabForUse(candidate.id, llmName);
                TabMapManager.setTab(llmName, candidate.id);
                initRequestMetadata(llmName, candidate.id, readiness.tab?.url || candidate?.url || (LLM_TARGETS[llmName]?.url) || '');
                jobState.llms[llmName].tabId = candidate.id;
                emitTelemetry(llmName, 'TAB_ATTACHED', {
                    details: readiness.tab?.url || candidate?.url || '',
                    meta: { snapshot: readiness.snapshot || candidateSnapshot || null, reason: 'attach_existing' }
                });
                dispatchPromptToTab(llmName, candidate.id, prompt, attachments, 'attach_existing');
                broadcastHumanVisitStatus();
                resolve(true);
            } catch (err) {
                console.warn(`[BACKGROUND] Unable to reuse existing tab for ${llmName}:`, err?.message || err);
                emitTelemetry(llmName, 'ATTACH_ERROR', {
                    details: err?.message || 'attach_existing failed',
                    level: 'error',
                    meta: { reason: 'attach_existing_error' }
                });
                resolve(false);
            }
        });
    });
}

function collectResponses() {
    console.log('[BACKGROUND] Collecting responses');
    Object.keys(jobState.llms).forEach(llmName => {
        if (jobState.llms[llmName].tabId && !jobState.llms[llmName].messageSent) {
            dispatchPromptToTab(llmName, jobState.llms[llmName].tabId, jobState.prompt, jobState.attachments || [], 'collect_responses');
        }
    });
    broadcastHumanVisitStatus();
    if (hasPendingHumanVisits()) {
        scheduleHumanPresenceLoop(true);
    }
}

// Staged collection helper for Embedded Pragmatist v2.0 (foreground-first, background parallel)
async function collectResponsesStaged() {
    try {
        const tabs = await chrome.tabs.query({ url: [
            'https://chat.openai.com/*', 'https://chatgpt.com/*', 'https://claude.ai/*',
            'https://gemini.google.com/*', 'https://grok.com/*', 'https://chat.deepseek.com/*',
            'https://www.perplexity.ai/*', 'https://chat.qwen.ai/*', 'https://chat.mistral.ai/*'
        ], audible: false });
        const active = await chrome.tabs.query({ active: true, currentWindow: true });
        const activeId = active?.[0]?.id;
        const foreground = tabs.filter(t => t.id === activeId);
        const background = tabs.filter(t => t.id !== activeId);

        const results = [];
        const collectOne = (tabId, timeout) => new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ tabId, platform: 'unknown', text: '', error: 'timeout' }), timeout);
            chrome.tabs.sendMessage(tabId, { action: 'get_response' }, (resp) => {
                clearTimeout(timer);
                if (chrome.runtime.lastError || !resp) {
                    resolve({ tabId, platform: 'unknown', text: '', error: chrome.runtime.lastError?.message || 'no response' });
                } else {
                    resolve({ tabId, platform: resp.platform, sessionId: resp.sessionId, text: resp.text });
                }
            });
        });

        for (const t of foreground) {
            if (t.id) results.push(await collectOne(t.id, 500));
        }
        const bgPromises = background.filter(t => t.id).map(t => collectOne(t.id, 3000));
        const bgResults = await Promise.all(bgPromises);
        results.push(...bgResults);
        return results;
    } catch (err) {
        console.warn('[BACKGROUND] collectResponsesStaged failed', err);
        return [];
    }
}

function handleManualResponsePing(llmName) {
    if (!llmName) {
        return { status: 'manual_ping_failed', error: 'LLM name missing' };
    }
    const tabId = TabMapManager.get(llmName);
    if (!tabId) {
        broadcastDiagnostic(llmName, {
            type: 'PING',
            label: 'Ручной ping невозможен',
            details: 'Вкладка не найдена',
            level: 'error'
        });
        return { status: 'manual_ping_failed', error: 'Tab not found' };
    }
    broadcastDiagnostic(llmName, {
        type: 'PING',
        label: 'Ручной ping инициирован',
        details: 'UI button',
        level: 'info'
    });
    extendPingWindowForLLM(llmName, MANUAL_PING_WINDOW_MS);
    sendPassiveMessageWithRetries(tabId, llmName, { action: 'getResponses', meta: { source: 'manual_ping' } }, {
        onSuccess: (response) => {
            broadcastDiagnostic(llmName, {
                type: 'PING',
                label: 'Команда getResponses отправлена',
                details: response?.status ? `CS status: ${response.status}` : '',
                level: 'success'
            });
        },
        onError: (errMsg) => {
            broadcastDiagnostic(llmName, {
                type: 'PING_ERROR',
                label: 'Ошибка отправки команды',
                details: errMsg,
                level: 'error'
            });
            chrome.runtime.sendMessage({ type: 'MANUAL_PING_RESULT', llmName, status: 'failed', error: errMsg });
        }
    });
    return { status: 'manual_ping_sent' };
}

function handleManualResendRequest(llmName) {
    if (!llmName) {
        return { status: 'manual_resend_failed', error: 'LLM name missing' };
    }
    const llmEntry = jobState?.llms?.[llmName];
    if (!llmEntry) {
        return { status: 'manual_resend_failed', error: 'LLM not active' };
    }
    const tabId = llmEntry.tabId;
    if (!tabId) {
        return { status: 'manual_resend_failed', error: 'Tab not found' };
    }
    const prompt = jobState?.prompt;
    if (!prompt) {
        return { status: 'manual_resend_failed', error: 'Prompt unavailable' };
    }
    llmEntry.manualResendActive = true;
    llmEntry.manualResendStartedAt = Date.now();
    llmEntry.manualResendAttempts = (llmEntry.manualResendAttempts || 0) + 1;
    broadcastDiagnostic(llmName, {
        type: 'RESEND',
        label: 'Ручная повторная отправка инициирована',
        level: 'info'
    });
    llmEntry.messageSent = false;
    llmEntry.dispatchInFlight = false;
    dispatchPromptToTab(llmName, tabId, prompt, jobState.attachments || [], 'manual_resend');
    return { status: 'manual_resend_dispatched' };
}

//-- 4.1. Команда завершения работы content script --//
function sendCleanupCommand(llmName) {
    const tabId = TabMapManager.get(llmName);
    if (!tabId) return;
    
    chrome.tabs.sendMessage(tabId, { type: 'STOP_AND_CLEANUP' }, (response) => {
        if (chrome.runtime.lastError) {
            console.warn(`[BACKGROUND] Cleanup command failed for ${llmName}:`, chrome.runtime.lastError.message);
        } else {
            console.log(`[BACKGROUND] Cleanup command sent to ${llmName}, response:`, response);
        }
    });
}

function handleLLMResponse(llmName, answer, error = null, meta = null, answerHtml = '') {
    if (!jobState?.llms || typeof llmName !== 'string') {
        console.error('[BACKGROUND] Invalid state for response:', llmName);
        return;
    }
    const resolvedName = (() => {
        if (jobState.llms[llmName]) return llmName;
        const trimmed = llmName.trim();
        if (jobState.llms[trimmed]) return trimmed;
        const lower = trimmed.toLowerCase();
        const match = Object.keys(jobState.llms).find((key) => key && key.toLowerCase() === lower);
        return match || llmName;
    })();
    if (resolvedName !== llmName) {
        console.warn(`[BACKGROUND] Normalized llmName "${llmName}" -> "${resolvedName}"`);
    }
    llmName = resolvedName;

    const entry = jobState.llms?.[llmName];
    const metaObj = meta && typeof meta === 'object' ? meta : null;
    if (entry && metaObj) {
        const expectedSessionId = Number(jobState?.session?.startTime || 0) || null;
        const incomingSessionId = metaObj?.sessionId ? Number(metaObj.sessionId) : null;
        const incomingDispatchId = typeof metaObj?.dispatchId === 'string' ? metaObj.dispatchId : null;
        const recentDispatchIds = Array.isArray(entry?.recentDispatchIds) ? entry.recentDispatchIds : [];

        if (expectedSessionId && incomingSessionId && incomingSessionId !== expectedSessionId) {
            appendLogEntry(llmName, {
                type: 'RESPONSE',
                label: 'Ответ проигнорирован (устарел)',
                details: `sessionId=${incomingSessionId} expectedSessionId=${expectedSessionId}`,
                level: 'warning'
            });
            return;
        }
        if (incomingDispatchId && recentDispatchIds.length && !recentDispatchIds.includes(incomingDispatchId)) {
            appendLogEntry(llmName, {
                type: 'RESPONSE',
                label: 'Ответ проигнорирован (неизвестный dispatchId)',
                details: incomingDispatchId,
                level: 'warning'
            });
            return;
        }
    }

    const responseMeta = (() => {
        if (!metaObj || typeof metaObj !== 'object') return {};
        const merged = {};
        const candidates = [
            metaObj.response,
            metaObj.responseMeta,
            metaObj.answerMeta,
            metaObj.pipelineMeta
        ];
        candidates.forEach((candidate) => {
            if (candidate && typeof candidate === 'object') {
                Object.assign(merged, candidate);
            }
        });
        return merged;
    })();
    const answerMeta = responseMeta?.answer && typeof responseMeta.answer === 'object' ? responseMeta.answer : null;
    const sanityWarnings = Array.isArray(responseMeta?.sanityWarnings) ? responseMeta.sanityWarnings : [];
    const sanityConfidence = typeof responseMeta?.sanityConfidence === 'number' ? responseMeta.sanityConfidence : null;
    const completionReasonRaw = responseMeta?.completionReason || responseMeta?.answerReason || answerMeta?.reason || null;
    const completionReason = completionReasonRaw ? String(completionReasonRaw).toLowerCase() : null;
    const hardStopReason = responseMeta?.hardStopReason || answerMeta?.hardStopReason || null;
    const sendConfirmed = typeof responseMeta?.sendConfirmed === 'boolean'
        ? responseMeta.sendConfirmed
        : (typeof responseMeta?.confirmed === 'boolean' ? responseMeta.confirmed : null);
    const sendMethod = responseMeta?.sendMethod || responseMeta?.method || null;
    const responseSource = responseMeta?.source || responseMeta?.answerSource || null;

    // Le Chat (and some other UIs) can reject duplicate GET_ANSWER while a previous inject is still running.
    // Treat it as a "busy" signal: do not mark ERROR, do not count as a response, and stop retry storms.
    if (error?.type === 'concurrent_request') {
        const now = Date.now();
        const busyForMs = 60000;
        if (entry) {
            entry.csBusyUntil = now + busyForMs;
            saveJobState(jobState);
        }
        appendLogEntry(llmName, {
            type: 'RESPONSE',
            label: 'Запрос уже выполняется (content)',
            details: error?.message || String(answer || ''),
            level: 'warning'
        });
        broadcastDiagnostic(llmName, {
            type: 'DISPATCH',
            label: 'Запрос уже выполняется (content)',
            details: `${busyForMs}ms`,
            level: 'warning'
        });
        // Unblock any in-flight "wait for prompt submitted" so the dispatch lock doesn't stall.
        resolvePromptSubmitted(llmName, { ok: false, busy: true, ts: now, meta: metaObj });
        return;
    }

    // --- V2.0: API Fallback Trigger ---
    if (error && (error.type === 'rate_limit' || error.type === 'captcha_detected')) {
        console.log(`[API-FALLBACK] Triggered for ${llmName} due to error: ${error.type}`);
        if (error.type === 'rate_limit') {
            setRateLimit(llmName, 60000, error?.message);
        }
        executeApiFallback(llmName, jobState.prompt)
            .then((started) => {
                if (!started) {
                    handleLLMResponse(
                        llmName,
                        answer || `Error: ${error?.message || 'API fallback unavailable'}`,
                        { type: 'fallback_unavailable' },
                        meta
                    );
                }
            })
            .catch((fallbackError) => {
                console.error('[API-FALLBACK] Failed to execute fallback:', fallbackError);
                handleLLMResponse(llmName, `Error: ${fallbackError?.message || 'API fallback failed'}`, { type: 'fallback_failed' }, meta);
            });
        return;
    }
    closePingWindowForLLM(llmName);
    clearPostSuccessScrollAudit(llmName);
    let normalizedAnswer = '';
    let normalizedHtml = '';
    if (answer && typeof answer === 'object') {
        normalizedAnswer = String(answer.text || answer.answer || '');
        normalizedHtml = String(answer.html || answer.answerHtml || answerHtml || '');
    } else {
        normalizedAnswer = typeof answer === 'string' ? answer : (answer ?? '');
        normalizedHtml = typeof answerHtml === 'string' ? answerHtml : '';
    }
    const trimmedAnswer = String(normalizedAnswer || '').trim();
    if (!error && !trimmedAnswer) {
        error = { type: 'empty_answer', message: 'Empty answer received from content script' };
        normalizedAnswer = 'Error: Empty answer received';
    }
    const isSuccess = !error && !!String(normalizedAnswer || '').trim() && !normalizedAnswer.startsWith('Error:');
    if (!isSuccess) {
        normalizedHtml = '';
    }
    const partialSignals = new Set(['hard_timeout', 'soft_timeout', 'stream_start_timeout', 'streaming_incomplete']);
    const hasPartialWarnings = sanityWarnings.some((warning) =>
        ['streaming_active', 'content_growing', 'hard_timeout'].includes(String(warning || '').toLowerCase())
    );
    const isPartial = Boolean(
        responseMeta?.partial
        || responseMeta?.degraded
        || (completionReason && partialSignals.has(completionReason))
        || hasPartialWarnings
        || (typeof sanityConfidence === 'number' && sanityConfidence < 0.7)
    );
    const streamTimeoutHidden = completionReason === 'hard_timeout' && hardStopReason === 'hidden';
    let finalStatus = 'ERROR';
    let finalReason = null;
    if (isSuccess) {
        finalStatus = isPartial ? (streamTimeoutHidden ? 'STREAM_TIMEOUT_HIDDEN' : 'PARTIAL') : 'SUCCESS';
        finalReason = completionReason || (isPartial ? 'partial' : 'ok');
    } else if (error?.type === 'send_failed' || error?.type === 'no_send' || sendConfirmed === false) {
        finalStatus = 'NO_SEND';
        finalReason = error?.type || 'no_send';
    } else if (error?.type === 'extract_failed' || error?.type === 'empty_answer' || error?.type === 'answer_element_missing') {
        finalStatus = 'EXTRACT_FAILED';
        finalReason = error?.type || 'extract_failed';
    } else if (error?.type === 'stream_start_timeout') {
        finalStatus = 'STREAM_TIMEOUT';
        finalReason = error?.type || 'stream_start_timeout';
    } else {
        finalStatus = 'ERROR';
        finalReason = error?.type || error?.message || 'error';
    }
    console.log(`[BACKGROUND] Handling response from ${llmName}. Success: ${isSuccess}`);
    appendLogEntry(llmName, {
        type: 'RESPONSE',
        label: isSuccess ? (isPartial ? 'Ответ получен (частично)' : 'Ответ получен') : 'Ошибка ответа',
        details: isSuccess ? '' : (error?.message || normalizedAnswer),
        level: isSuccess ? (isPartial ? 'warning' : 'success') : 'error',
        meta: {
            finalStatus,
            finalReason,
            completionReason,
            sendConfirmed,
            sendMethod,
            responseSource
        }
    });

    // Don't let internal concurrency guards ("another request in progress") trip the circuit breaker.
    // These errors are typically caused by background retries while a previous inject is still running.
    const ignoreForCircuitBreaker = error?.type === 'concurrent_request';
    if (!ignoreForCircuitBreaker) {
        updateCircuitBreaker(llmName, isSuccess);
    } else {
        console.warn(`[CIRCUIT-BREAKER] Ignoring failure for ${llmName} (concurrent_request)`);
    }
    if (isSuccess) {
        downgradePipelineHardTimeoutLogs(llmName);
        downgradePipelineHardTimeoutStorage(llmName);
        const tabId = jobState.llms?.[llmName]?.tabId;
        if (tabId) {
            scrollTabToBottom(tabId);
            scheduleDeferredAnswerVisit(llmName, tabId);
            schedulePostSuccessScrollAudit(llmName, tabId);
        }
        jobState.llms[llmName].skipHumanLoop = true;
        jobState.llms[llmName].humanStalled = false;
    }

    if (!jobState.llms || !jobState.llms[llmName]) {
        console.error(`[BACKGROUND] Invalid state for ${llmName}`);
        return;
    }

    const llmEntry = jobState.llms[llmName];
    const isFirstResponse = llmEntry.answer === null;

    if (!isFirstResponse) {
        console.log(`[BACKGROUND] Updating existing response for ${llmName} (manual refresh/resend).`);
    }

    let status = 'ERROR';
    const dataPayload = {};

    if (error?.type === 'circuit_open') {
        status = 'CIRCUIT_OPEN';
        dataPayload.message = normalizedAnswer;
    } else if (error?.type === 'health_check_failed') {
        status = 'UNRESPONSIVE';
        dataPayload.message = normalizedAnswer;
    } else if (isSuccess) {
        status = finalStatus === 'SUCCESS' ? 'COPY_SUCCESS' : finalStatus;
    } else {
        status = finalStatus;
        dataPayload.message = normalizedAnswer;
    }

    dataPayload.finalStatus = finalStatus;
    dataPayload.finalReason = finalReason;
    dataPayload.completionReason = completionReason || null;
    dataPayload.sendConfirmed = sendConfirmed;
    dataPayload.sendMethod = sendMethod;
    dataPayload.responseSource = responseSource;
    dataPayload.sanityConfidence = sanityConfidence;
    dataPayload.criteriaStatus = responseMeta?.criteriaStatus || answerMeta?.metrics?.criteriaStatus || null;

    updateModelState(llmName, status, dataPayload);

    jobState.llms[llmName].answer = normalizedAnswer;
    jobState.llms[llmName].answerHtml = normalizedHtml;
    jobState.llms[llmName].finalStatus = finalStatus;
    jobState.llms[llmName].finalReason = finalReason;
    jobState.llms[llmName].finalMeta = {
        completionReason: completionReason || null,
        sendConfirmed,
        sendMethod,
        responseSource,
        partial: isPartial,
        degraded: Boolean(responseMeta?.degraded),
        sanityConfidence
    };
    if (!jobState.llms[llmName].messageSent) {
        jobState.llms[llmName].messageSent = true;
        jobState.llms[llmName].promptSubmittedAt = jobState.llms[llmName].promptSubmittedAt || Date.now();
        if (sendConfirmed === false) {
            appendLogEntry(llmName, {
                type: 'DISPATCH',
                label: 'Ответ получен без подтверждения отправки',
                details: sendMethod ? `method=${sendMethod}` : '',
                level: 'warning'
            });
        }
    }
    if (isFirstResponse) {
        emitTelemetry(llmName, 'RUN_END', {
            level: isSuccess ? 'success' : 'error',
            meta: {
                status,
                isSuccess,
                answerLength: trimmedAnswer.length,
                errorType: error?.type || null,
                finalStatus,
                finalReason,
                completionReason: completionReason || null,
                partial: isPartial,
                degraded: Boolean(responseMeta?.degraded),
                sendConfirmed,
                sendMethod,
                responseSource,
                sanityConfidence
            },
            force: true
        });
        recordPlatformRun(llmName, isSuccess);
    }
    if (isFirstResponse) {
        jobState.responsesCollected++;
        console.log(`[BACKGROUND] Recorded response from ${llmName}. Total: ${jobState.responsesCollected}/${Object.keys(jobState.llms).length}`);
        if (jobState.session && jobState.responsesCollected >= (jobState.session.totalModels || 0)) {
            focusResultsTab();
        }
    }
    broadcastHumanVisitStatus();
    llmEntry.manualResendActive = false;
    if (llmEntry.typingActive || llmEntry.typingGuardUntil) {
        llmEntry.typingActive = false;
        llmEntry.typingEndedAt = Date.now();
        llmEntry.typingGuardUntil = 0;
        llmEntry.typingGuardReason = null;
    }

    //-- 11.3. Сохранение обновленного состояния --//
    saveJobState(jobState);
    if (hasPendingHumanVisits()) {
        if (!humanPresenceActive) {
            scheduleHumanPresenceLoop();
        }
    } else {
        stopHumanPresenceLoop();
    }

    const logsSnapshot = getLogSnapshot(llmName);
    const tabId = TabMapManager.get(llmName);
    const completedAt = Date.now();
    const dispatchWithMetadata = (resolvedUrl) => {
        const updates = { tabId, completedAt };
        if (resolvedUrl) {
            updates.url = resolvedUrl;
        }
        const snapshot = persistRequestMetadata(llmName, updates);
        sendMessageToResultsTab({
            type: 'LLM_PARTIAL_RESPONSE',
            llmName,
            requestId: snapshot?.requestId || jobState?.llms?.[llmName]?.requestId,
            answer: normalizedAnswer,
            answerHtml: normalizedHtml,
            metadata: snapshot
                ? {
                    url: snapshot.url || '',
                    createdAt: snapshot.createdAt || snapshot.timestamp || null,
                    completedAt: snapshot.completedAt || completedAt
                }
                : null,
            logs: logsSnapshot
        });
    };

    if (tabId) {
        chrome.tabs.get(tabId, (tab) => {
            const resolvedUrl = (!chrome.runtime.lastError && tab) ? tab.url : null;
            dispatchWithMetadata(resolvedUrl);
        });
    } else {
        dispatchWithMetadata(null);
    }
}

function sendMessageToResultsTab(message) {
    const isNoReceiverError = (errorMessage = '') =>
        errorMessage.toLowerCase().includes('receiving end does not exist');

    const fallbackToRuntime = () => {
        chrome.runtime.sendMessage(message, () => {
            if (chrome.runtime.lastError) {
                const { message: errorMessage } = chrome.runtime.lastError;
                if (isNoReceiverError(errorMessage)) {
                    console.warn('[BACKGROUND] Runtime broadcast skipped - no active results view:', message.type);
                } else {
                    console.error('[BACKGROUND] Runtime broadcast to results failed:', errorMessage);
                }
            } else {
                console.log('[BACKGROUND] Message broadcast via runtime:', message.type);
            }
        });
    };

    if (!resultsTabId) {
        console.warn('[BACKGROUND] Results tab ID not set, using runtime broadcast');
        fallbackToRuntime();
        return;
    }

    chrome.tabs.sendMessage(resultsTabId, message, () => {
        if (chrome.runtime.lastError) {
            console.warn('[BACKGROUND] tabs.sendMessage to results failed:', chrome.runtime.lastError.message);
            // сбрасываем ID, чтобы не пытаться повторно в ту же вкладку
            resultsTabId = null;
            fallbackToRuntime();
        } else {
            console.log('[BACKGROUND] Message sent to results tab:', message.type);
        }
    });
}

function focusResultsTab() {
    if (!isValidTabId(resultsTabId)) return;
    chrome.tabs.get(resultsTabId, (tab) => {
        if (chrome.runtime.lastError || !tab) return;
        chrome.windows.update(tab.windowId, { focused: true }, () => {
            if (chrome.runtime.lastError) {
                console.warn('[BACKGROUND] Failed to focus results window:', chrome.runtime.lastError.message);
            }
            chrome.tabs.update(resultsTabId, { active: true });
        });
    });
}

function clearDeferredAnswerTimer(llmName) {
    if (!llmName) return;
    const entry = deferredAnswerTimers[llmName];
    if (entry?.handle) {
        clearTimeout(entry.handle);
    }
    delete deferredAnswerTimers[llmName];
}

function clearAllDeferredAnswerTimers() {
    Object.keys(deferredAnswerTimers).forEach((llm) => clearDeferredAnswerTimer(llm));
}

function scheduleDeferredAnswerVisit(llmName, tabId, delays = DEFERRED_VISIT_DELAYS_MS) {
    if (!llmName || !isValidTabId(tabId) || !Array.isArray(delays) || !delays.length) return;
    clearDeferredAnswerTimer(llmName);
    const [nextDelay, ...rest] = delays;
    const handle = setTimeout(() => {
        runDeferredAnswerVisit(llmName, tabId);
        if (rest.length) {
            scheduleDeferredAnswerVisit(llmName, tabId, rest);
        } else {
            delete deferredAnswerTimers[llmName];
        }
    }, nextDelay);
    deferredAnswerTimers[llmName] = { handle, remaining: rest, tabId };
}

function runDeferredAnswerVisit(llmName, tabId) {
    if (!isValidTabId(tabId)) return;
    chrome.scripting.executeScript({
        target: { tabId },
        func: (modelName) => {
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const clickLatestAnswer = async () => {
                const selectors = [
                    '[data-testid="conversation-turn"]',
                    'main article',
                    'article',
                    '[class*="response"]',
                    '.chat-message',
                    '.prose',
                    '.answer, .assistant-message'
                ];
                const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
                const target = nodes.filter((el) => (el.innerText || el.textContent || '').trim().length > 20).pop();
                if (!target) return false;
                target.scrollIntoView({ behavior: 'smooth', block: 'end' });
                await sleep(220);
                target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                await sleep(140);
                window.scrollBy({ top: window.innerHeight * 0.25, behavior: 'smooth' });
                return true;
            };
            clickLatestAnswer().then((ok) => {
                if (!ok) {
                    window.scrollTo({ top: document.body?.scrollHeight || 0, behavior: 'smooth' });
                }
            }).catch((err) => console.warn('[HUMAN-VISIT] deferred visit error', modelName, err));
        },
        args: [llmName]
    }).catch((err) => {
        console.warn('[HUMAN-VISIT] deferred visit failed:', err?.message || err);
    });
}

function updateModelState(llmName, status, data = {}) {
    if (!llmName || !status) return;
    const normalizedStatus = (status || '').toString().toUpperCase();

    // Don't overwrite terminal statuses with non-terminal ones
    // Don't overwrite SUCCESS statuses with FAILURE statuses
    if (jobState?.llms?.[llmName]) {
        const currentStatus = jobState.llms[llmName].status;
        
        // Block non-terminal from overwriting terminal
        if (TERMINAL_STATUSES.includes(currentStatus) && !TERMINAL_STATUSES.includes(normalizedStatus)) {
            console.log(`[State Update] Skipping ${llmName}: ${normalizedStatus} (current: ${currentStatus} is terminal)`);
            return;
        }
        
        // Block FAILURE from overwriting SUCCESS
        if (SUCCESS_STATUSES.includes(currentStatus) && FAILURE_STATUSES.includes(normalizedStatus)) {
            console.log(`[State Update] Blocking ${llmName}: Cannot overwrite SUCCESS (${currentStatus}) with FAILURE (${normalizedStatus})`);
            return;
        }

        jobState.llms[llmName].status = normalizedStatus;
        jobState.llms[llmName].statusData = data;
    }
    const severity = (() => {
        if (['CRITICAL_ERROR', 'API_FAILED', 'NO_SEND', 'EXTRACT_FAILED', 'STREAM_TIMEOUT'].includes(normalizedStatus)) return 'error';
        if (['RECOVERABLE_ERROR', 'ERROR', 'UNRESPONSIVE', 'CIRCUIT_OPEN', 'PARTIAL', 'STREAM_TIMEOUT_HIDDEN'].includes(normalizedStatus)) return 'warning';
        return 'info';
    })();
    appendLogEntry(llmName, {
        type: 'STATUS',
        label: `Статус: ${normalizedStatus}`,
        details: data?.message || '',
        level: severity,
        meta: { status: normalizedStatus }
    });
    console.log(`[State Update] ${llmName} -> ${normalizedStatus}`);
    sendMessageToResultsTab({
        type: 'STATUS_UPDATE',
        llmName,
        status: normalizedStatus,
        data,
        logs: getLogSnapshot(llmName)
    });
    broadcastGlobalState();
}

function startEvaluation(evalPrompt, evaluatorName = 'Claude', options = {}) {
    const { openEvaluatorTab = true } = options;
    console.log(
        `[BACKGROUND] Starting evaluation in a ${openEvaluatorTab ? 'foreground' : 'background'} tab using ${evaluatorName}.`
    );

    if (!evalPrompt) {
        evalPrompt = `Compare ${Object.keys(jobState.llms).length} responses to the question: "${jobState.prompt}".\n\n`;
        Object.keys(jobState.llms).forEach((llmName, index) => {
            evalPrompt += `Response ${index + 1} (${llmName}):\n${jobState.llms[llmName].answer}\n\n`;
        });
        evalPrompt += `Select the best response, briefly explain why, and present the result as a bulleted list.`;
        evaluatorName = 'GPT';
    }

    const evaluatorUrls = {
        'GPT': 'https://chat.openai.com/',
        'Gemini': 'https://gemini.google.com/',
        'Claude': 'https://claude.ai/chat/new',
        'Grok': 'https://grok.com/',
        'Le Chat': 'https://chat.mistral.ai/chat/',
        'Qwen': 'https://chat.qwen.ai/',
        'DeepSeek': 'https://chat.deepseek.com/',
        'Perplexity': 'https://www.perplexity.ai/'
    };

    const url = evaluatorUrls[evaluatorName];
    if (!url) {
        const errorMsg = `Error: Unknown evaluator '${evaluatorName}'. Cannot open tab.`;
        console.error(`[BACKGROUND] ${errorMsg}`);
        sendMessageToResultsTab({
            type: 'PROCESS_COMPLETE',
            finalAnswer: errorMsg
        });
        return;
    }

    console.log(`[BACKGROUND] Creating new tab for ${evaluatorName} at ${url}`);
    chrome.tabs.create({ url: url, active: openEvaluatorTab }, (tab) => {
        evaluatorTabId = tab.id;
        trackSessionTab(tab.id);
        console.log(`[BACKGROUND] Created evaluation tab ${tab.id} for ${evaluatorName}.`);

        const listener = (tabId, changeInfo) => {
            if (tabId === tab.id && changeInfo.status === 'complete') {
                console.log(`[BACKGROUND] Evaluation tab ${tabId} loaded.`);
                
                const delay = evaluatorName === 'Claude' ? 10000 : 5000;
                setTimeout(() => {
                    console.log(`[BACKGROUND] Sending evaluation prompt to tab ${tab.id}.`);
                    chrome.tabs.sendMessage(tab.id, { 
                        type: 'GET_ANSWER', 
                        prompt: evalPrompt,
                        isEvaluator: true,
                        isFireAndForget: false
                    }, (response) => {
                        if (chrome.runtime.lastError) {
                            console.error(`[BACKGROUND] Error delivering evaluation prompt:`, chrome.runtime.lastError.message);
                            sendMessageToResultsTab({
                                type: 'PROCESS_COMPLETE',
                                finalAnswer: `Error: Failed to deliver evaluation prompt (${chrome.runtime.lastError.message})`
                            });
                        } else {
                            console.log('[BACKGROUND] Evaluation prompt delivered successfully.');
                            sendMessageToResultsTab({ type: 'STARTING_EVALUATION' });
                        }
                    });
                }, delay);

                chrome.tabs.onUpdated.removeListener(listener);
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
    });
}

function handleEvaluatorResponse(finalAnswer) {
    console.log(`[BACKGROUND] Received evaluator response:`, finalAnswer.substring(0, 100) + '...');

    sendMessageToResultsTab({
        type: 'PROCESS_COMPLETE',
        finalAnswer: finalAnswer
    });
}

//-- 4.2. Cleanup перед закрытием вкладок --//
function closeAllSessions() {
    console.log('[BACKGROUND] Closing all active LLM tabs with cleanup...');
    stopHumanPresenceLoop();
    finalizeTabVisit('session_closed');
    humanPresencePaused = false;
    humanPresenceManuallyStopped = false;
    
    // Сначала отправляем команду cleanup во все вкладки
    TabMapManager.entries().forEach(([llmName, tabId]) => {
        chrome.tabs.sendMessage(tabId, { type: 'STOP_AND_CLEANUP' }, () => {
            if (chrome.runtime.lastError) {
                console.warn(`[BACKGROUND] Cleanup message failed for ${llmName}:`, chrome.runtime.lastError.message);
            }
        });
    });
    
    if (evaluatorTabId) {
        chrome.tabs.sendMessage(evaluatorTabId, { type: 'STOP_AND_CLEANUP' }, () => {
            if (chrome.runtime.lastError) {
                console.warn('[BACKGROUND] Cleanup message failed for evaluator');
            }
        });
    }
    
    // Даем 500мс на cleanup, затем закрываем вкладки
    setTimeout(() => {
        const tabIdsToClose = TabMapManager.entries().map(([, id]) => id);

        if (evaluatorTabId) {
            tabIdsToClose.push(evaluatorTabId);
        }

        if (tabIdsToClose.length > 0) {
            chrome.tabs.remove(tabIdsToClose, () => {
                if (chrome.runtime.lastError) {
                    console.error('[BACKGROUND] Error closing tabs:', chrome.runtime.lastError.message);
                } else {
                    console.log('[BACKGROUND] All LLM tabs have been closed.');
                }
            });
        }

        TabMapManager.clear();
        evaluatorTabId = null;
        Object.keys(pingWindowByTabId).forEach(tabId => delete pingWindowByTabId[tabId]);
        Object.keys(llmActivityMap).forEach((tabId) => delete llmActivityMap[tabId]);
        clearActiveListeners();
        broadcastHumanVisitStatus();
    }, 500);
}
//-- НОВОЕ: Система принудительной переинъекции для cleanup --//

// Карта скриптов
const SCRIPT_MAP = {
    'GPT': 'content-scripts/content-chatgpt.js',
    'Gemini': 'content-scripts/content-gemini.js',
    'Claude': 'content-scripts/content-claude.js',
    'Grok': 'content-scripts/content-grok.js',
    'Le Chat': 'content-scripts/content-lechat.js',
    'Qwen': 'content-scripts/content-qwen.js',
    'DeepSeek': 'content-scripts/content-deepseek.js',
    'Perplexity': 'content-scripts/content-perplexity.js'
};

// Проверка, жив ли скрипт (контент-скрипты отвечают на HEALTH_CHECK_PING).
async function checkScriptHealth(tabId, llmName, { silent = false } = {}) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: 'HEALTH_CHECK_PING', pingId: `health_${Date.now()}` }, (response) => {
            if (chrome.runtime.lastError || !response) {
                if (!silent) {
                    const errMsg = chrome.runtime.lastError?.message || 'no response';
                    emitTelemetry(llmName, 'SCRIPT_HEALTH_FAIL', {
                        details: errMsg,
                        level: 'warning',
                        meta: { tabId, reason: 'health_ping_failed' }
                    });
                }
                if (!silent) {
                    console.warn(`[BACKGROUND] Script health check failed for ${llmName}`);
                }
                resolve(false);
            } else {
                if (!silent) {
                    console.log(`[BACKGROUND] ✅ Script healthy for ${llmName}`);
                }
                resolve(true);
            }
        });
    });
}

// Лёгкое ожидание готовности скрипта без реинъекции.
async function waitForScriptReady(tabId, llmName, { timeoutMs = 8000, intervalMs = 250 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const ok = await checkScriptHealth(tabId, llmName, { silent: true });
        if (ok) return true;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
}

// Принудительная переинъекция
async function reinjectScript(tabId, llmName) {
    const scriptFile = SCRIPT_MAP[llmName];
    if (!scriptFile) {
        console.error(`[BACKGROUND] No script mapping for ${llmName}`);
        return false;
    }

    console.log(`[BACKGROUND] 🔄 Reinjecting ${scriptFile} into tab ${tabId}...`);
    emitTelemetry(llmName, 'SCRIPT_REINJECT_START', {
        meta: { tabId, scriptFile }
    });
    
    try {
        // Сначала отправляем команду cleanup (если скрипт еще живой)
        chrome.tabs.sendMessage(tabId, { type: 'FORCE_CLEANUP' }).catch(() => {});
        
        // Даем время на cleanup
        await new Promise(r => setTimeout(r, 500));
        
        // Перезагружаем вкладку для полной очистки
        await chrome.tabs.reload(tabId);
        
        // Ждем загрузки
        return new Promise((resolve) => {
            const listener = (changedTabId, changeInfo) => {
                if (changedTabId === tabId && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    console.log(`[BACKGROUND] ✅ Tab ${tabId} reloaded, script auto-injected via manifest`);
                    emitTelemetry(llmName, 'SCRIPT_REINJECT_RESULT', {
                        details: 'ok',
                        meta: { tabId, scriptFile, ok: true }
                    });
                    resolve(true);
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
            
            // Таймаут на случай проблем
            setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                emitTelemetry(llmName, 'SCRIPT_REINJECT_RESULT', {
                    details: 'timeout',
                    level: 'warning',
                    meta: { tabId, scriptFile, ok: false, reason: 'timeout' }
                });
                resolve(false);
            }, 30000);
        });
    } catch (err) {
        console.error(`[BACKGROUND] ❌ Reinject failed for ${llmName}:`, err);
        emitTelemetry(llmName, 'SCRIPT_REINJECT_RESULT', {
            details: err?.message || 'reinject_failed',
            level: 'error',
            meta: { tabId, scriptFile, ok: false, reason: 'exception' }
        });
        return false;
    }
}

// Умная подготовка вкладки перед использованием
async function prepareTabForUse(tabId, llmName) {
    console.log(`[BACKGROUND] Preparing tab for ${llmName}...`);
    
    // Проверяем здоровье скрипта
    const isHealthy = await checkScriptHealth(tabId, llmName);
    
    if (!isHealthy) {
        console.warn(`[BACKGROUND] Script unhealthy for ${llmName}, reinjecting...`);
        const success = await reinjectScript(tabId, llmName);
        if (!success) {
            throw new Error(`Failed to reinject script for ${llmName}`);
        }
    }
    
    return true;
}

// --- V2.0 START: API Fallback Execution Logic ---
async function executeApiFallback(llmName, prompt, options = {}) {
    const { silentOnFailure = false, apiKeyOverride = null } = options;
    const config = apiFallbackConfig[llmName];
    if (!config || typeof config.buildRequest !== 'function' || typeof config.parseResponse !== 'function') {
        console.warn(`[API] No API configuration for ${llmName}`);
        return false;
    }

    let apiKey = apiKeyOverride;
    if (!apiKey) {
        const storedData = await chrome.storage.local.get(config.storageKey);
        apiKey = storedData?.[config.storageKey];
    }
    if (!apiKey) {
        console.warn(`[API] API key for ${llmName} not found.`);
        return false;
    }

    const endpointMeta = getApiEndpointMeta(config);
    if (!endpointMeta || !endpointMeta.endpoint) {
        console.warn(`[API] No endpoint metadata for ${llmName}`);
        return false;
    }

    console.log(`[API] Executing direct API request for ${llmName}`);
    updateModelState(llmName, 'API_PENDING', buildApiStatusData(config, {
        apiStatus: 'pending',
        message: 'Connecting via API…'
    }, endpointMeta));
    logApiEvent(llmName, 'API request pending', 'info', config, '', endpointMeta);

    const requestConfig = config.buildRequest(prompt, apiKey, {
        ...config,
        endpoint: endpointMeta.endpoint,
        model: endpointMeta.model
    });
    if (!requestConfig || !requestConfig.url) {
        handleApiFailureNotice(llmName, config, 'Invalid request configuration', silentOnFailure, endpointMeta);
        return false;
    }

    const controller = new AbortController();
    let connectionTimedOut = false;
    const connectionTimer = setTimeout(() => {
        connectionTimedOut = true;
        controller.abort();
    }, API_CONNECTION_TIMEOUT_MS);

    const fetchInit = {
        method: requestConfig.method || 'POST',
        headers: requestConfig.headers || { 'Content-Type': 'application/json' },
        signal: controller.signal
    };

    if (typeof requestConfig.body !== 'undefined') {
        fetchInit.body = (typeof requestConfig.body === 'string' || requestConfig.skipStringify)
            ? requestConfig.body
            : JSON.stringify(requestConfig.body);
    }

    let response;
    try {
        response = await fetch(requestConfig.url, fetchInit);
    } catch (error) {
        clearTimeout(connectionTimer);
        const reason = connectionTimedOut
            ? `Connection timeout (${API_CONNECTION_TIMEOUT_MS}ms)`
            : (error?.message || 'Request failed');
        handleApiFailureNotice(llmName, config, reason, silentOnFailure, endpointMeta);
        return false;
    }
    clearTimeout(connectionTimer);

    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        const message = `Status ${response.status}${errorBody ? ` – ${errorBody.slice(0, 120)}` : ''}`;
        if (response.status === 404 && advanceApiEndpoint(config)) {
            logApiEvent(llmName, 'Switching Gemini endpoint', 'warning', config, message, endpointMeta);
            return executeApiFallback(llmName, prompt, options);
        }
        handleApiFailureNotice(llmName, config, message, silentOnFailure, endpointMeta);
        return false;
    }

    const data = await new Promise((resolve, reject) => {
        let settled = false;
        const responseTimer = setTimeout(() => {
            if (!settled) {
                reject(new Error(`Response timeout (${API_RESPONSE_TIMEOUT_MS}ms)`));
            }
        }, API_RESPONSE_TIMEOUT_MS);
        response.json().then((payload) => {
            settled = true;
            clearTimeout(responseTimer);
            resolve(payload);
        }).catch((err) => {
            settled = true;
            clearTimeout(responseTimer);
            reject(err);
        });
    }).catch((error) => {
        handleApiFailureNotice(llmName, config, error?.message || 'Response parsing failed', silentOnFailure, endpointMeta);
        return null;
    });

    if (!data) {
        return false;
    }

    let answer = '';
    try {
        answer = config.parseResponse(data, prompt) || '';
    } catch (parseError) {
        handleApiFailureNotice(llmName, config, parseError?.message || 'API parse error', silentOnFailure, endpointMeta);
        return false;
    }

    if (!answer) {
        handleApiFailureNotice(llmName, config, 'Empty response payload', silentOnFailure, endpointMeta);
        return false;
    }

    logApiEvent(llmName, 'API sucsefull', 'api', config, '', endpointMeta);
    updateModelState(llmName, 'API_MODE', buildApiStatusData(config, {
        apiStatus: 'active',
        message: 'API sucsefull'
    }, endpointMeta));
    handleLLMResponse(llmName, answer);
    return true;
}
// --- V2.0 END: API Fallback Execution Logic ---

//-- 15.1. Перезагрузка LLM-вкладок при обновлении расширения --//
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'update') {
        console.log('[BACKGROUND] Extension updated, reloading LLM tabs...');
        
        const llmUrls = [
            '*://chat.openai.com/*',
            '*://chatgpt.com/*',
            '*://gemini.google.com/*',
            '*://claude.ai/*',
            '*://grok.com/*',
            '*://chat.qwen.ai/*',
            '*://chat.mistral.ai/*',
            '*://chat.deepseek.com/*',
            '*://www.perplexity.ai/*'
        ];
        
    chrome.tabs.query({ url: llmUrls, audible: false }, (tabs) => {
        console.log(`[BACKGROUND] Found ${tabs.length} LLM tabs to reload`);
        tabs.forEach(tab => {
            chrome.tabs.reload(tab.id, () => {
                if (chrome.runtime.lastError) {
                        console.warn(`[BACKGROUND] Failed to reload tab ${tab.id}`);
                    }
                });
            });
        });
        
        // Очищаем сохраненные состояния
        chrome.storage.local.remove(['llmTabMap', 'jobState', CIRCUIT_BREAKER_STORAGE_KEY]);
    }
    if (remoteSelectorsAllowed) {
        chrome.alarms.create(REMOTE_SELECTORS_ALARM, { periodInMinutes: REMOTE_SELECTORS_REFRESH_MS / 60000 });
        fetchRemoteSelectors();
    } else {
        chrome.alarms.clear(REMOTE_SELECTORS_ALARM);
    }
});
chrome.runtime.onStartup.addListener(() => {
    if (remoteSelectorsAllowed) {
        chrome.alarms.create(REMOTE_SELECTORS_ALARM, { periodInMinutes: REMOTE_SELECTORS_REFRESH_MS / 60000 });
        fetchRemoteSelectors();
    } else {
        chrome.alarms.clear(REMOTE_SELECTORS_ALARM);
    }
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (changeInfo.status === 'complete') {
        const key = `${TAB_STOP_PREFIX}${tabId}`;
        try {
            const data = await chrome.storage.session.get(key);
            if (data?.[key]?.state === 'HARD_STOP') {
                chrome.tabs.sendMessage(tabId, { type: 'FORCE_HARD_STOP_RESTORE' }).catch(() => {});
            } else {
                await chrome.storage.session.remove(key);
            }
        } catch (_) {}
    }
});
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === REMOTE_SELECTORS_ALARM) {
        if (remoteSelectorsAllowed) {
            fetchRemoteSelectors();
        }
        return;
    }
    if (alarm.name === VERSION_STATUS_ALARM) {
        updateVersionStatusSnapshot();
        return;
    }
});

//-- 9.1. Очистка при остановке Service Worker --//
chrome.runtime.onSuspend.addListener(() => {
    console.log('[BACKGROUND] Service Worker suspending, cleaning up...');

    flushSelectorMetrics(true);
    
    // Отправляем команду cleanup во все активные вкладки
    TabMapManager.entries().forEach(([llmName, tabId]) => {
        chrome.tabs.sendMessage(tabId, { type: 'STOP_AND_CLEANUP' }).catch(() => {});
    });
    
    // Очищаем локальное состояние
    TabMapManager.clear();
    jobState = {};
    clearAllDeferredAnswerTimers();
    circuitBreakerState = {};
    Object.keys(llmActivityMap).forEach((tabId) => delete llmActivityMap[tabId]);
    clearActiveListeners();
    persistCircuitBreakerState();
    
    // Останавливаем health checker
    pendingPings.clear();
    
    // Останавливаем heartbeat monitor
    stopHeartbeatMonitor();
    
    console.log('[BACKGROUND] Cleanup complete on suspend');
});

// --- V4.0: Global Anti-Sleep Heartbeat ---
// Keep patterns in sync with LLM_TARGETS.queryPatterns.
const LLM_URL_PATTERNS = (() => {
    const fallback = [
        '*://chat.openai.com/*',
        '*://chatgpt.com/*',
        '*://gemini.google.com/*',
        '*://claude.ai/*',
        '*://grok.com/*',
        '*://x.com/*',
        '*://chat.qwen.ai/*',
        '*://chat.deepseek.com/*',
        '*://www.perplexity.ai/*',
        '*://chat.mistral.ai/*'
    ];
    try {
        const patterns = Object.values(LLM_TARGETS || {})
            .flatMap((entry) => {
                if (!entry?.queryPatterns) return [];
                return Array.isArray(entry.queryPatterns) ? entry.queryPatterns : [entry.queryPatterns];
            })
            .filter(Boolean)
            // Normalize https/http -> *:// for chrome.tabs.query match patterns.
            .map((pattern) => pattern.replace(/^https?:\/\//, '*://'));
        const unique = Array.from(new Set(patterns));
        return unique.length ? unique : fallback;
    } catch (err) {
        console.warn('[BACKGROUND] Failed to build LLM_URL_PATTERNS from LLM_TARGETS', err);
        return fallback;
    }
})();

chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.type === 'LLM_ACTIVITY_PONG' && sender.tab?.id) {
        llmActivityMap[sender.tab.id] = Date.now();
        return;
    }
    if (message.type === 'STOP_AND_CLEANUP' && sender.tab?.id) {
        closePingWindowForTab(sender.tab.id);
        delete llmActivityMap[sender.tab.id];
        return;
    }
    if (message.type === 'SCROLL_HARD_STOP' && sender.tab?.id) {
        setTabStopState(sender.tab.id, message.state).catch(() => {});
        return;
    }
});

function getInactivityMs(tabId) {
    return llmActivityMap[tabId] ? (Date.now() - llmActivityMap[tabId]) : Infinity;
}

function getLlmNameByTabId(tabId) {
    return TabMapManager.getNameByTabId(tabId);
}

function isTabSessionCompleted(tabId) {
    const llmName = getLlmNameByTabId(tabId);
    if (!llmName) return false;
    const status = jobState?.llms?.[llmName]?.status;
    return status === 'COPY_SUCCESS' || status === 'SUCCESS' || status === 'DONE';
}

const STORAGE_CLEANUP_ALARM = 'pragmatist_storage_cleanup';
chrome.alarms.create(STORAGE_CLEANUP_ALARM, { periodInMinutes: 5 });

async function cleanupStorageBudgets() {
    try {
        const now = Date.now();
        const { __PRAGMATIST_BUDGETS: budgets = {} } = globalThis || {};
        const timing = budgets?.timing || {};
        const ackTtl = timing.ackTTL || 300000; // 5m
        const cmdTtl = timing.commandTTL || 60000; // 60s
        const maxStateAge = 24 * 60 * 60 * 1000; // 24h
        const maxKeys = budgets?.storage?.maxKeys || 50;
        const all = await chrome.storage.local.get(null);
        const compute = typeof globalThis.computeStorageCleanup === 'function' ? globalThis.computeStorageCleanup : null;
        if (compute) {
            const { removals, updates } = compute(all, {
                now,
                timing: { ackTTL: ackTtl, commandTTL: cmdTtl, stateTTL: maxStateAge },
                storage: { maxKeys }
            });
            if (updates && Object.keys(updates).length) {
                await chrome.storage.local.set(updates);
            }
            if (removals && removals.length) {
                await chrome.storage.local.remove(removals);
                try {
                    chrome.runtime.sendMessage({
                        type: 'DIAG_EVENT',
                        event: { type: 'storage_cleanup', removed: removals.length, reason: 'ttl/maxKeys', ts: Date.now() }
                    });
                } catch (_) {}
            }
        }
    } catch (err) {
        console.warn('[STORAGE CLEANUP] Failed', err);
    }
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === STORAGE_CLEANUP_ALARM) {
        cleanupStorageBudgets().catch(() => {});
    }
});
// Run one eager cleanup on startup
cleanupStorageBudgets().catch(() => {});
function deriveHumanState(entry, llmName) {
    if (!entry) return 'off';
    if (entry.skipHumanLoop) return 'off';
    if (entry.humanStalled) return 'alert';
    if (entry.status === 'COPY_SUCCESS') return 'active';
    if (currentHumanVisit?.llmName === llmName) return 'active';
    if (!entry.status || entry.status === 'IDLE') return 'pending';
    return 'pending';
}

// ==================== v2.54 (2025-12-19 19:40): Smart Tab Pre-warming ====================
// Предварительная загрузка вкладок топовых моделей для мгновенного старта
// Включает проверки памяти и защиту от tab discarding

// v2.54.1 (2025-12-19 19:50): Добавлен Perplexity в прогрев (часто используется)
const PREWARM_MODELS = ['Claude', 'GPT', 'Perplexity']; // Топ-3 модели для прогрева
const PREWARM_CHECK_INTERVAL = 5 * 60 * 1000; // Проверка каждые 5 минут
let prewarmCheckTimer = null;

// Проверка доступной памяти устройства
function hasEnoughMemoryForPrewarm() {
    try {
        // navigator.deviceMemory доступен в Chromium-based браузерах
        if (navigator.deviceMemory && navigator.deviceMemory < 4) {
            console.log('[PREWARM] Insufficient device memory, skipping pre-warm');
            return false;
        }
        return true;
    } catch (_) {
        // Если API недоступен, разрешаем прогрев
        return true;
    }
}

// Создание вкладки в фоне без активации
async function createTabQuietly(url) {
    return new Promise((resolve) => {
        chrome.tabs.create({ url, active: false }, (tab) => {
            if (chrome.runtime.lastError || !tab) {
                console.error('[PREWARM] Failed to create tab:', chrome.runtime.lastError);
                resolve(null);
            } else {
                console.log(`[PREWARM] Created background tab ${tab.id} for ${url}`);
                resolve(tab);
            }
        });
    });
}

// Проверка является ли вкладка discarded
async function isTabDiscarded(tabId) {
    return new Promise((resolve) => {
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError || !tab) {
                resolve(true); // Вкладка не существует = считаем discarded
            } else {
                resolve(tab.discarded === true);
            }
        });
    });
}

// Умный прогрев вкладок
async function smartPrewarmTabs() {
    // Проверка памяти
    if (!hasEnoughMemoryForPrewarm()) {
        return;
    }

    // Проверка что не идёт активная работа
    if (promptDispatchInProgress > 0) {
        console.log('[PREWARM] Dispatch in progress, skipping pre-warm');
        return;
    }

    console.log('[PREWARM] Starting smart tab pre-warming...');

    for (const llmName of PREWARM_MODELS) {
        const existingTabId = TabMapManager.get(llmName);

        if (existingTabId) {
            // Проверяем существующую вкладку
            const discarded = await isTabDiscarded(existingTabId);

            if (discarded) {
                console.log(`[PREWARM] Tab ${existingTabId} for ${llmName} is discarded, reloading...`);
                try {
                    await chrome.tabs.reload(existingTabId);
                    console.log(`[PREWARM] Reloaded tab ${existingTabId} for ${llmName}`);
                } catch (err) {
                    console.error(`[PREWARM] Failed to reload tab for ${llmName}:`, err);
                    // Если reload не удался, создаём новую вкладку
                    TabMapManager.removeByTabId(existingTabId);
                    await prewarmSingleModel(llmName);
                }
            } else {
                console.log(`[PREWARM] Tab ${existingTabId} for ${llmName} is already active`);
            }
        } else {
            // Нет вкладки, создаём новую
            await prewarmSingleModel(llmName);
        }

        // Задержка между созданием вкладок (имитация человеческого поведения)
        await new Promise(r => setTimeout(r, 3000));
    }

    console.log('[PREWARM] Pre-warming complete');
}

// Прогрев одной модели
async function prewarmSingleModel(llmName) {
    const llmConfig = LLM_CONFIGS[llmName];
    if (!llmConfig || !llmConfig.url) {
        console.warn(`[PREWARM] No config for ${llmName}`);
        return;
    }

    console.log(`[PREWARM] Creating pre-warmed tab for ${llmName}...`);
    const tab = await createTabQuietly(llmConfig.url);

    if (tab) {
        TabMapManager.setTab(llmName, tab.id);
        console.log(`[PREWARM] Successfully pre-warmed ${llmName} on tab ${tab.id}`);
    }
}

// Периодическая проверка и обновление прогретых вкладок
function schedulePrewarmCheck() {
    if (prewarmCheckTimer) {
        clearTimeout(prewarmCheckTimer);
    }

    prewarmCheckTimer = setTimeout(() => {
        smartPrewarmTabs().catch(err => {
            console.error('[PREWARM] Check failed:', err);
        }).finally(() => {
            schedulePrewarmCheck(); // Планируем следующую проверку
        });
    }, PREWARM_CHECK_INTERVAL);
}

// Запуск при установке/обновлении расширения
chrome.runtime.onInstalled.addListener((details) => {
    console.log('[BACKGROUND] Extension installed/updated:', details);

    // Отложенный прогрев через 10 секунд после установки
    setTimeout(() => {
        smartPrewarmTabs().catch(err => {
            console.error('[PREWARM] Initial pre-warm failed:', err);
        });
    }, 10000);

    // Запуск периодических проверок
    schedulePrewarmCheck();
});

// Запуск при старте браузера (если расширение уже установлено)
chrome.runtime.onStartup.addListener(() => {
    console.log('[BACKGROUND] Browser started, scheduling pre-warm...');

    setTimeout(() => {
        smartPrewarmTabs().catch(err => {
            console.error('[PREWARM] Startup pre-warm failed:', err);
        });
    }, 15000); // Даём браузеру время полностью загрузиться

    schedulePrewarmCheck();
});

console.log('[BACKGROUND] v2.54 Smart Tab Pre-warming initialized');
