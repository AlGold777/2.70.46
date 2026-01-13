# Patch Pack — 2.48–2.53 (после 2.47)

Этот документ — «быстрый набор патчей» для коллег, которые остались на версии **2.47** и хотят быстро внедрить позитивные изменения, накопленные позже.

## Как применять

- Для каждого пункта ниже есть:
  - «строки/якоря» (чтобы быстро найти место в коде),
  - `diff`‑блоки (как готовые вставки/замены).

## Важно про базу diff

В текущем workspace нет снапшота исходников **ровно 2.47**. Поэтому «левая сторона» большинства `diff`‑блоков собрана относительно ближайшего снапшота **2.46** из папки `Copied files/`.

На ветке `2.47` часть ханков применится без конфликтов, часть — потребует ручной подгонки контекста.

## 1) Dispatch без дублей (PROMPT_SUBMITTED не вызывает resend)

**Описание (из Release Notes):** Dispatch без дублей: `PROMPT_SUBMITTED` больше не триггерит повторную отправку `GET_ANSWER`, а `messageSent` ставится сразу после успешной доставки команды (меньше “спама” по вкладкам и ошибок вида “Another request is already being processed”).

**Строки/якоря (в текущей ветке):**
52:const PROMPT_SUBMIT_TIMEOUTS_MS = {
228:    const override = PROMPT_SUBMIT_TIMEOUTS_MS[llmName];
267:async function dispatchPromptToTab(llmName, tabId, prompt, attachments = [], reason = 'auto') {
356:function runPromptDispatchSupervisor() {
2531:            case 'PROMPT_SUBMITTED': {

**Diff (background.js — dispatch coordinator + dispatchPromptToTab):**
```diff
--- a/background.js
+++ b/background.js
@@ -34,9 +44,21 @@
 const AUTO_PING_WINDOW_MS = 45000;
 const MANUAL_PING_WINDOW_MS = 20000;
 const pingWindowByTabId = {};
+const pingStartByTabId = {};
 const llmActivityMap = {};
 const TAB_LOAD_TIMEOUT_MS = 45000;
 const MAX_LOG_ENTRIES = 60;
+const PROMPT_SUBMIT_TIMEOUT_MS = 7000;
+const PROMPT_SUBMIT_TIMEOUTS_MS = {
+    Gemini: 30000,
+    Perplexity: 5000,
+    Claude: 30000,
+    Grok: 9000,
+    Qwen: 9000,
+    DeepSeek: 9000,
+    GPT: 12000,
+    'Le Chat': 20000
+};
 const RESOLUTION_LAYER_MAP = {
     cache: 'L1',
     versioned: 'L2',
@@ -66,14 +88,346 @@
 let currentHumanVisit = null;
 let browserHasFocus = true;
 const deferredAnswerTimers = {};
-const SEND_PROMPT_DELAY_MS = 7000;
+const SEND_PROMPT_DELAY_MS = 5000;
 const DEFERRED_VISIT_DELAYS_MS = [15000, 45000, 90000];
 const API_MODE_STORAGE_KEY = 'llmComparatorApiModeEnabled';
+const AUTO_FOCUS_NEW_TABS_KEY = 'autofocus_llm_tabs_enabled';
+const ALLOW_FOCUS_STEAL_KEY = 'allow_focus_steal_enabled';
+const AUTOMATION_WINDOW_ID_KEY = 'llm_automation_window_id';
 let cachedApiMode = true;
 let remoteSelectorsAllowed = REMOTE_SELECTORS_ENABLED;
+let autoFocusNewTabsEnabled = false;
+let allowFocusSteal = false;
+const rateLimitState = new Map();
+const rateLimitTimers = new Map();
+const llmStartChains = Object.create(null);
 const postSuccessScrollTimers = new Map();
 const TAB_STOP_PREFIX = 'tab_stop_';
+
+// --- Prompt dispatch coordinator (prevents focus thrash) ---
+let promptDispatchMutex = Promise.resolve();
+let promptDispatchInProgress = 0;
+const promptSubmitWaiters = new Map(); // llmName -> Set<fn>
+let promptDispatchSupervisorTimer = null;
+const DISPATCH_SUPERVISOR_TICK_MS = 1200;
+const DISPATCH_RETRY_BACKOFF_MS = [0, 2500, 5000, 9000];
+const DISPATCH_MAX_ATTEMPTS = 4;
+
+const withPromptDispatchLock = (fn) => {
+    promptDispatchMutex = promptDispatchMutex.then(() => Promise.resolve(fn())).catch((err) => {
+        console.warn('[DISPATCH] lock fn failed', err);
+    });
+    return promptDispatchMutex;
+};
+
+function canStealUserFocus() {
+    return !!allowFocusSteal && !!browserHasFocus;
+}
+
+function isValidWindowId(windowId) {
+    return Number.isInteger(windowId) && windowId > 0;
+}
+
+function shouldUseAutomationWindow() {
+    return !allowFocusSteal;
+}
+
+function getWindowSafe(windowId) {
+    return new Promise((resolve) => {
+        if (!isValidWindowId(windowId)) {
+            resolve(null);
+            return;
+        }
+        chrome.windows.get(windowId, { populate: false }, (win) => {
+            if (chrome.runtime.lastError || !win) {
+                resolve(null);
+                return;
+            }
+            resolve(win);
+        });
+    });
+}
+
+async function ensureAutomationWindow() {
+    if (!shouldUseAutomationWindow()) return null;
+    if (isValidWindowId(automationWindowId)) {
+        const existing = await getWindowSafe(automationWindowId);
+        if (existing) return automationWindowId;
+        automationWindowId = null;
+    }
+    if (automationWindowInitPromise) return automationWindowInitPromise;
+    automationWindowInitPromise = (async () => {
+        try {
+            const stored = await chrome.storage.session.get([AUTOMATION_WINDOW_ID_KEY]).catch(() => ({}));
+            const storedId = Number(stored?.[AUTOMATION_WINDOW_ID_KEY]);
+            if (isValidWindowId(storedId)) {
+                const existing = await getWindowSafe(storedId);
+                if (existing) {
+                    automationWindowId = storedId;
+                    return storedId;
+                }
+            }
+        } catch (_) {}
+        const createdId = await new Promise((resolve) => {
+            chrome.windows.create({
+                url: 'about:blank',
+                focused: false,
+                type: 'normal',
+                width: 520,
+                height: 720
+            }, (win) => resolve(win?.id || null));
+        });
+        if (isValidWindowId(createdId)) {
+            automationWindowId = createdId;
+            try {
+                await chrome.storage.session.set({ [AUTOMATION_WINDOW_ID_KEY]: createdId });
+            } catch (_) {}
+            return createdId;
+        }
+        return null;
+    })().finally(() => {
+        automationWindowInitPromise = null;
+    });
+    return automationWindowInitPromise;
+}
+
+function resolvePromptSubmitted(llmName, payload = {}) {
+    const waiters = promptSubmitWaiters.get(llmName);
+    if (waiters && waiters.size) {
+        waiters.forEach((cb) => {
+            try { cb(payload); } catch (_) {}
+        });
+        waiters.clear();
+    }
+}
+
+function waitForPromptSubmitted(llmName, timeoutMs = PROMPT_SUBMIT_TIMEOUT_MS) {
+    return new Promise((resolve) => {
+        if (!llmName) {
+            resolve(false);
+            return;
+        }
+        const waiters = promptSubmitWaiters.get(llmName) || new Set();
+        promptSubmitWaiters.set(llmName, waiters);
+        let settled = false;
+        const done = (ok, payload) => {
+            if (settled) return;
+            settled = true;
+            clearTimeout(timer);
+            waiters.delete(handler);
+            resolve(ok ? (payload || true) : false);
+        };
+        const handler = (payload) => done(true, payload);
+        waiters.add(handler);
+        const timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
+    });
+}
+
+function getPromptSubmitTimeoutMs(llmName) {
+    if (!llmName) return PROMPT_SUBMIT_TIMEOUT_MS;
+    const override = PROMPT_SUBMIT_TIMEOUTS_MS[llmName];
+    return Number.isFinite(override) ? override : PROMPT_SUBMIT_TIMEOUT_MS;
+}
+
+function activateTabForDispatch(tabId) {
+    return new Promise((resolve) => {
+        if (!isValidTabId(tabId)) {
+            resolve(false);
+            return;
+        }
+        chrome.tabs.get(tabId, (tab) => {
+            if (chrome.runtime.lastError || !tab) {
+                resolve(false);
+                return;
+            }
+            const winId = tab.windowId;
+            if (canStealUserFocus()) {
+                const focusWindow = (cb) => {
+                    if (!winId) return cb();
+                    chrome.windows.update(winId, { focused: true }, () => cb());
+                };
+                focusWindow(() => {
+                    chrome.tabs.update(tabId, { active: true }, () => {
+                        resolve(!chrome.runtime.lastError);
+                    });
+                });
+                return;
+            }
+
+            if (shouldUseAutomationWindow() && isValidWindowId(automationWindowId) && winId === automationWindowId) {
+                chrome.tabs.update(tabId, { active: true }, () => resolve(!chrome.runtime.lastError));
+                return;
+            }
+
+            resolve(true);
+        });
+    });
+}
+
+async function dispatchPromptToTab(llmName, tabId, prompt, attachments = [], reason = 'auto') {
+    if (!llmName || !isValidTabId(tabId) || !prompt) return false;
+    const entry = jobState?.llms?.[llmName];
+    if (!entry) return false;
+    if (entry.messageSent) return false;
+    if (entry.dispatchInFlight) return false;
+    entry.dispatchInFlight = true;
+    entry.dispatchAttempts = (entry.dispatchAttempts || 0) + 1;
+    entry.lastDispatchAt = Date.now();
+    saveJobState(jobState);
+
+    const submitTimeoutMs = getPromptSubmitTimeoutMs(llmName);
+    const sessionId = jobState?.session?.startTime || Date.now();
+    const dispatchId = `${llmName}:${sessionId}:${entry.dispatchAttempts || 0}`;
+    let promptSubmittedWaiter = null;
+
+    let commandDelivered = false;
+    try {
+        await withPromptDispatchLock(async () => {
+            promptDispatchInProgress += 1;
+            stopHumanPresenceLoop();
+            try {
+                broadcastDiagnostic(llmName, { type: 'DISPATCH', label: 'Активация вкладки для отправки', details: reason, level: 'info' });
+                await activateTabForDispatch(tabId);
+                await waitForScriptReady(tabId, llmName, { timeoutMs: SEND_PROMPT_DELAY_MS, intervalMs: 250 }).catch(() => false);
+                // Важно: ставим waiter ДО отправки команды, чтобы не потерять быстрый PROMPT_SUBMITTED.
+                promptSubmittedWaiter = waitForPromptSubmitted(llmName, submitTimeoutMs);
+                commandDelivered = await sendMessageSafely(tabId, llmName, {
+                    type: 'GET_ANSWER',
+                    prompt,
+                    attachments,
+                    meta: { dispatchReason: reason, sessionId, dispatchId, backgroundMode: !canStealUserFocus() }
+                });
+                if (commandDelivered) {
+                    entry.messageSent = true;
+                    entry.commandDispatchedAt = Date.now();
+                    saveJobState(jobState);
+                }
+            } catch (err) {
+                console.warn('[DISPATCH] dispatchPromptToTab send phase failed', llmName, err);
+                broadcastDiagnostic(llmName, { type: 'DISPATCH', label: 'Ошибка отправки промпта', details: err?.message || String(err), level: 'error' });
+            } finally {
+                promptDispatchInProgress = Math.max(0, promptDispatchInProgress - 1);
+                schedulePromptDispatchSupervisor();
+            }
+        });
+
+        const submitted = await (promptSubmittedWaiter || Promise.resolve(false));
+        if (!submitted) {
+            broadcastDiagnostic(llmName, { type: 'DISPATCH', label: 'Таймаут подтверждения отправки', details: `${submitTimeoutMs}ms`, level: 'warning' });
+        }
+        return commandDelivered;
+    } catch (err) {
+        console.warn('[DISPATCH] dispatchPromptToTab failed', llmName, err);
+        broadcastDiagnostic(llmName, { type: 'DISPATCH', label: 'Ошибка отправки промпта', details: err?.message || String(err), level: 'error' });
+        return commandDelivered;
+    } finally {
+        try {
+            entry.dispatchInFlight = false;
+            saveJobState(jobState);
+        } catch (_) {}
+        try {
+            focusResultsTab();
+        } catch (_) {}
+        schedulePromptDispatchSupervisor();
+    }
+}
 
+function hasPendingPromptDispatches() {
+    if (!jobState?.llms) return false;
+    return Object.keys(jobState.llms).some((llmName) => {
+        const entry = jobState.llms[llmName];
+        if (!entry) return false;
+        if (entry.messageSent) return false;
+        if (!isValidTabId(entry.tabId)) return false;
+        const attempts = entry.dispatchAttempts || 0;
+        return attempts < DISPATCH_MAX_ATTEMPTS;
+    });
+}
+
+function schedulePromptDispatchSupervisor() {
+    if (promptDispatchSupervisorTimer) return;
+    if (!hasPendingPromptDispatches()) return;
+    promptDispatchSupervisorTimer = setTimeout(() => {
+        promptDispatchSupervisorTimer = null;
+        runPromptDispatchSupervisor();
+    }, DISPATCH_SUPERVISOR_TICK_MS);
+}
+
+function runPromptDispatchSupervisor() {
+    if (!jobState?.llms) return;
+    if (promptDispatchInProgress > 0) {
+        schedulePromptDispatchSupervisor();
+        return;
+    }
+    const now = Date.now();
+    for (const llmName of Object.keys(jobState.llms)) {
+        const entry = jobState.llms[llmName];
+        if (!entry || entry.messageSent || entry.dispatchInFlight) continue;
+        const tabId = entry.tabId;
+        if (!isValidTabId(tabId)) continue;
+        const attempts = entry.dispatchAttempts || 0;
+        if (attempts >= DISPATCH_MAX_ATTEMPTS) continue;
+        const backoff = DISPATCH_RETRY_BACKOFF_MS[Math.min(attempts, DISPATCH_RETRY_BACKOFF_MS.length - 1)] || 0;
+        const lastAt = entry.lastDispatchAt || 0;
+        if (now - lastAt < backoff) continue;
+        dispatchPromptToTab(llmName, tabId, jobState.prompt, jobState.attachments || [], 'retry_supervisor');
+    }
+    schedulePromptDispatchSupervisor();
+}
+
+function getTabSafe(tabId) {
+    return new Promise((resolve) => {
+        if (!isValidTabId(tabId)) {
+            resolve(null);
+            return;
+        }
+        chrome.tabs.get(tabId, (tab) => {
+            if (chrome.runtime.lastError || !tab) {
+                resolve(null);
+            } else {
+                resolve(tab);
+            }
+        });
+    });
+}
+
+async function findExistingResultsTab() {
+    const current = await getTabSafe(resultsTabId);
+    if (current) return current;
+    try {
+        const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('result_new.html') });
+        return tabs.find((t) => t?.id) || null;
+    } catch (err) {
+        console.warn('[BACKGROUND] Failed to query results tabs', err);
+        return null;
+    }
+}
+
+async function openOrFocusResultsTab() {
+    const existing = await findExistingResultsTab();
+    const tabToUse = existing || await new Promise((resolve) => {
+        chrome.tabs.create({ url: chrome.runtime.getURL('result_new.html'), active: true }, (tab) => resolve(tab || null));
+    });
+    if (tabToUse?.id) {
+        resultsTabId = tabToUse.id;
+        resultsWindowId = tabToUse.windowId || resultsWindowId;
+        try {
+            chrome.windows.update(tabToUse.windowId, { focused: true }, () => chrome.runtime.lastError);
+            chrome.tabs.update(tabToUse.id, { active: true }, () => chrome.runtime.lastError);
+        } catch (err) {
+            console.warn('[BACKGROUND] Failed to focus results tab', err);
+        }
+    }
+    return tabToUse;
+}
+
+// Claude / Dato  2025-10-19 00-31 — singleton results tab
+chrome.action.onClicked.addListener(() => {
+    openOrFocusResultsTab().catch((err) => {
+        console.warn('[BACKGROUND] Failed to open results tab', err);
+    });
+});
+
 chrome.storage.local.get(API_MODE_STORAGE_KEY, (data) => {
     if (typeof data?.[API_MODE_STORAGE_KEY] === 'boolean') {
         cachedApiMode = data[API_MODE_STORAGE_KEY];
```

## 2) Очередь dispatch не блокируется ожиданием PROMPT_SUBMITTED

**Описание (из Release Notes):** Очередь dispatch: ожидание подтверждения отправки вынесено за пределы mutex, чтобы зависшая/медленная вкладка не блокировала остальные модели.

**Строки/якоря (в текущей ветке):**
116:const withPromptDispatchLock = (fn) => {
285:        await withPromptDispatchLock(async () => {
281:    let promptSubmittedWaiter = null;
293:                promptSubmittedWaiter = waitForPromptSubmitted(llmName, submitTimeoutMs);
314:        const submitted = await (promptSubmittedWaiter || Promise.resolve(false));

**Проверка в коде:**
- В `dispatchPromptToTab` ожидание `promptSubmittedWaiter` должно быть *после* выхода из `withPromptDispatchLock`.
- См. diff в п.1 — строки около `promptSubmittedWaiter = waitForPromptSubmitted(...)` и `const submitted = await (promptSubmittedWaiter || Promise.resolve(false))`.

## 3) UX без focus‑steal (allow_focus_steal_enabled + automation window)

**Описание (из Release Notes):** UX без focus‑steal: флаг `allow_focus_steal_enabled` (по умолчанию выключен) + отдельное automation‑окно для LLM‑вкладок при отключённом focus‑steal.

**Строки/якоря (в текущей ветке):**
95:const ALLOW_FOCUS_STEAL_KEY = 'allow_focus_steal_enabled';
452:chrome.storage.local.get(ALLOW_FOCUS_STEAL_KEY, (data) => {
453:    if (typeof data?.[ALLOW_FOCUS_STEAL_KEY] === 'boolean') {
454:        allowFocusSteal = data[ALLOW_FOCUS_STEAL_KEY];
472:    if (changes[ALLOW_FOCUS_STEAL_KEY]) {
473:        allowFocusSteal = !!changes[ALLOW_FOCUS_STEAL_KEY].newValue;
25:    if (automationWindowId && windowId === automationWindowId) {
26:        automationWindowId = null;
38:let automationWindowId = null;
151:async function ensureAutomationWindow() {
153:    if (isValidWindowId(automationWindowId)) {
154:        const existing = await getWindowSafe(automationWindowId);
155:        if (existing) return automationWindowId;
156:        automationWindowId = null;
166:                    automationWindowId = storedId;
181:            automationWindowId = createdId;
257:            if (shouldUseAutomationWindow() && isValidWindowId(automationWindowId) && winId === automationWindowId) {
653:    const allowBackgroundCycle = shouldUseAutomationWindow() && isValidWindowId(automationWindowId);
781:        const allowBackgroundCycle = shouldUseAutomationWindow() && isValidWindowId(automationWindowId);
827:        const allowBackgroundCycle = shouldUseAutomationWindow() && isValidWindowId(automationWindowId);
892:            if (allowBackgroundCycle && tab.windowId === automationWindowId) {
3354:        ensureAutomationWindow()
3633:    if (shouldUseAutomationWindow() && isValidWindowId(automationWindowId)) {
3634:        createOptions.windowId = automationWindowId;
123:function canStealUserFocus() {
4196:function focusResultsTab() {
3625:function createNewLlmTab(llmName, prompt, attachments = []) {

**Diff (background.js — focus tracking + guard для focusResultsTab):**
```diff
--- a/background.js
+++ b/background.js
@@ -13,20 +13,30 @@
     'shared/storage-budgets.js'
 );
 
-// Claude / Dato  2025-10-19 00-31
-chrome.action.onClicked.addListener(() => {
-    chrome.tabs.create({ url: chrome.runtime.getURL('result_new.html') });
-});
-
 chrome.windows.onFocusChanged.addListener((windowId) => {
     const hasFocus = windowId !== chrome.windows.WINDOW_ID_NONE;
+    if (hasFocus) {
+        lastFocusedWindowId = windowId;
+    }
     handleBrowserFocusChange(hasFocus);
 });
 
+chrome.windows.onRemoved.addListener((windowId) => {
+    if (automationWindowId && windowId === automationWindowId) {
+        automationWindowId = null;
+        try {
+            chrome.storage.session.remove([AUTOMATION_WINDOW_ID_KEY]).catch(() => {});
+        } catch (_) {}
+    }
+});
+
 let jobState = {};
 let activeListeners = new Map();
 let resultsTabId = null;
 let resultsWindowId = null;
+let lastFocusedWindowId = null;
+let automationWindowId = null;
+let automationWindowInitPromise = null;
 let llmTabMap = {};
 const jobMetadata = new Map();
 const llmRequestMap = {};
@@ -3588,6 +4194,7 @@
 }
 
 function focusResultsTab() {
+    if (!canStealUserFocus()) return;
     if (!isValidTabId(resultsTabId)) return;
     chrome.tabs.get(resultsTabId, (tab) => {
         if (chrome.runtime.lastError || !tab) return;
```

## 4) Извлечение ответов: платформенные селекторы + DOM fallback + hardMax=180s

**Описание (из Release Notes):** Извлечение ответов: обновлены платформенные селекторы + UnifiedAnswerPipeline, добавлены DOM‑fallback’и (берём последний ответ), hardMax streaming timeout снижен до 180s.

### 4.1 Добавить AnswerPipelineSelectors (новый файл)

**Строки/якоря (в текущей ветке):**
6:  const SelectorBundle = window.AnswerPipelineSelectors;

**Diff (добавить файл `content-scripts/answer-pipeline-selectors.js`):**
```diff
--- a/content-scripts/answer-pipeline-selectors.js
+++ b/content-scripts/answer-pipeline-selectors.js
@@ -0,0 +1,162 @@
+(function initAnswerPipelineSelectors() {
+  if (window.AnswerPipelineSelectors) return;
+
+  const detectPlatform = () => {
+    const h = (location.hostname || '').toLowerCase();
+    if (h.includes('chatgpt') || h.includes('openai')) return 'chatgpt';
+    if (h.includes('claude.ai')) return 'claude';
+    if (h.includes('gemini.google') || h.includes('bard.google')) return 'gemini';
+    if (h.includes('grok.com') || h.includes('grok.x.ai') || h.includes('x.ai') || h === 'x.com') return 'grok';
+    if (h.includes('perplexity.ai')) return 'perplexity';
+    if (h.includes('deepseek')) return 'deepseek';
+    if (h.includes('qwen')) return 'qwen';
+    if (h.includes('mistral')) return 'lechat';
+    return 'generic';
+  };
+
+  const PLATFORM_SELECTORS = {
+    chatgpt: {
+      answerContainer: '[data-testid=\"conversation-panel\"], main, [data-testid=\"conversation-turn\"]',
+      lastMessage: '[data-testid=\"conversation-turn\"][data-message-author-role=\"assistant\"], div[data-message-author-role=\"assistant\"]',
+      streamStart: ['[data-testid=\"conversation-turn\"]', 'div[data-message-author-role=\"assistant\"]', '.agent-turn'],
+      generatingIndicators: ['button[aria-label*=\"Stop\" i]', '[data-testid=\"stop-button\"]'],
+      completionIndicators: ['button[data-testid=\"send-button\"]:not([disabled])', 'textarea[role=\"textbox\"]'],
+      stopButton: 'button[aria-label*=\"Stop\" i], [data-testid=\"stop-button\"]'
+    },
+    claude: {
+      answerContainer: '[data-testid=\"conversation-content\"], [data-testid*=\"conversation\"], [class*=\"conversation\" i], main, [role=\"main\"]',
+      lastMessage: [
+        'div[data-testid=\"conversation-turn\"][data-author-role=\"assistant\"]',
+        'div[data-testid=\"conversation-turn\"][data-role=\"assistant\"]',
+        'div[data-is-response=\"true\"][data-author-role=\"assistant\"]',
+        'div[data-is-response=\"true\"][data-role=\"assistant\"]',
+        'div[data-message-author-role=\"assistant\"]',
+        '[data-testid=\"assistant-message\"]',
+        '[data-testid=\"assistant-response\"]',
+        '[data-testid=\"chat-response\"]'
+      ].join(', '),
+      streamStart: [
+        '[data-testid=\"assistant-message\"]',
+        'div[data-testid=\"conversation-turn\"][data-author-role=\"assistant\"]',
+        'div[data-testid=\"conversation-turn\"][data-role=\"assistant\"]',
+        'div[data-is-response=\"true\"]',
+        '.font-claude-message',
+        '[class*=\"font-claude\" i]'
+      ],
+      generatingIndicators: ['button[aria-label*=\"Stop\" i]', '[data-is-streaming=\"true\"]', '[class*=\"streaming\" i]', '[data-testid=\"chat-spinner\"]', '[data-testid=\"typing\"]', '.typing-indicator', '.animate-pulse'],
+      completionIndicators: ['[data-testid=\"composer-input\"]', 'textarea', '[contenteditable=\"true\"]'],
+      stopButton: 'button[aria-label*=\"Stop\" i]'
+    },
+    gemini: {
+      answerContainer: 'main, [role=\"main\"], [class*=\"conversation\" i]',
+      lastMessage: [
+        '[data-test-id*=\"model-response\"]',
+        '[data-testid*=\"model-response\"]',
+        '.model-response',
+        'model-response',
+        'message-content',
+        '[data-message-author-role=\"assistant\"]',
+        '[data-role=\"assistant\"]'
+      ].join(', '),
+      streamStart: ['[data-test-id*=\"model-response\"]', '[data-testid*=\"model-response\"]', '.model-response', 'model-response', 'message-content', '[data-message-author-role=\"assistant\"]', '[data-role=\"assistant\"]'],
+      generatingIndicators: ['.loading', '[aria-busy=\"true\"]', '[data-is-loading=\"true\"]', '[data-loading=\"true\"]', '[data-streaming=\"true\"]'],
+      completionIndicators: ['rich-textarea', 'textarea[aria-label*=\"Prompt\" i]', 'textarea[aria-label*=\"Message\" i]', 'textarea[aria-label*=\"Ask\" i]'],
+      stopButton: 'button[aria-label*=\"Stop\" i]'
+    },
+    grok: {
+      answerContainer: 'main[role=\"main\"], [data-testid=\"conversation-container\"], [data-testid*=\"conversation\"], [role=\"log\"], main',
+      lastMessage: [
+        '[data-testid=\"grok-response\"]',
+        '[data-testid=\"message\"]',
+        '[data-testid*=\"chat-message\"]',
+        '[data-message-author-role=\"assistant\"]',
+        '[data-role=\"assistant\"]',
+        'article[data-role=\"assistant\"]',
+        'div[class*=\"assistant\" i]',
+        '[role=\"article\"]',
+        '.prose',
+        'article'
+      ].join(', '),
+      streamStart: ['[data-testid=\"grok-response\"]', '[data-testid=\"message\"]', '[data-testid*=\"chat-message\"]', '[data-message-author-role=\"assistant\"]', '[data-role=\"assistant\"]', 'article[data-role=\"assistant\"]', 'div[class*=\"assistant\" i]', '[role=\"article\"]', '.prose', 'article'],
+      generatingIndicators: ['.animate-pulse', '[aria-busy=\"true\"]', '[data-streaming=\"true\"]', '[data-generating=\"true\"]', '[class*=\"typing\" i]'],
+      completionIndicators: ['[data-testid=\"grok-send-button\"]', 'button[data-testid=\"grok-send-button\"]:not([disabled])', 'button[aria-label*=\"Send\" i]:not([disabled])', 'textarea[role=\"textbox\"]'],
+      stopButton: 'button[aria-label*=\"Stop\" i], button[data-testid=\"grok-stop-button\"]'
+    },
+    perplexity: {
+      answerContainer: 'main, [role=\"main\"], [data-testid=\"conversation-container\"], [data-testid=\"layout-wrapper\"], [class*=\"answer-container\" i], [data-testid*=\"answer\"], [data-testid*=\"response\"], article',
+      lastMessage: [
+        '[data-testid=\"answer-card\"]',
+        '[data-testid=\"answer\"]',
+        '[data-testid*=\"answer\"]',
+        '[data-testid*=\"response\"]',
+        '[class*=\"answer-container\" i] > :last-child',
+        '[class*=\"answer-container\" i] .prose',
+        '[data-testid=\"chat-message\"] .prose',
+        '[data-testid=\"conversation-turn\"]',
+        '.answer',
+        '.prose',
+        'article'
+      ].join(', '),
+      streamStart: [
+        '[data-testid=\"answer-card\"]',
+        '[data-testid=\"answer\"]',
+        '[data-testid*=\"answer\"]',
+        '[data-testid*=\"response\"]',
+        '[class*=\"answer-container\" i]',
+        '[data-testid=\"chat-message\"]',
+        '[data-testid=\"conversation-turn\"]',
+        '.answer',
+        '.prose',
+        'article'
+      ],
+      generatingIndicators: ['.loading-indicator', '[data-testid=\"loading-indicator\"]', '[aria-busy=\"true\"]', '[data-generating=\"true\"]', '[class*=\"streaming\" i]', 'button[aria-label*=\"Stop\" i]', '[data-testid=\"stop-button\"]'],
+      completionIndicators: ['textarea[aria-label*=\"Ask\" i]', 'textarea[aria-label*=\"Search\" i]', 'textarea[aria-label*=\"Message\" i]', 'button[aria-label*=\"Ask\" i]', 'button[data-testid=\"send-button\"]:not([disabled])', 'button[type=\"submit\"]:not([disabled])'],
+      stopButton: 'button[aria-label*=\"Stop\" i], button[data-testid=\"stop-button\"]'
+    },
+    qwen: {
+      answerContainer: 'main, article',
+      lastMessage: '[data-testid=\"chat-response\"], main article, .prose',
+      streamStart: ['[data-testid=\"chat-response\"]', 'main article', '.prose'],
+      generatingIndicators: ['[data-testid=\"chat-loader\"]', '[aria-busy=\"true\"]'],
+      completionIndicators: ['button[data-testid*=\"send\"]:not([disabled])', 'textarea[role=\"textbox\"]'],
+      stopButton: 'button[aria-label*=\"Stop\" i]'
+    },
+    deepseek: {
+      answerContainer: 'main, [role=\"main\"], .chat-content, [class*=\"conversation\" i], [class*=\"chat\" i], article',
+      lastMessage: [
+        '.message-item[data-role=\"assistant\"]',
+        'div[class*=\"assistant\" i]',
+        '[data-role=\"assistant\"]',
+        '.assistant-message',
+        '.message-content',
+        '.markdown-body',
+        '[class*=\"message\" i][class*=\"assistant\" i]',
+        '[class*=\"response\" i]',
+        'article',
+        '.prose'
+      ].join(', '),
+      streamStart: ['.message-item[data-role=\"assistant\"]', 'div[class*=\"assistant\" i]', '[data-role=\"assistant\"]', '.assistant-message', '.message-content', '.markdown-body', '[class*=\"message\" i][class*=\"assistant\" i]', '[class*=\"response\" i]', 'article', '.prose'],
+      generatingIndicators: ['[aria-busy=\"true\"]', '.loading', '[data-generating=\"true\"]', '[data-streaming=\"true\"]', '.typing-indicator', '.spinner', '.loader'],
+      completionIndicators: ['textarea:not([disabled])', 'textarea[role=\"textbox\"]:not([disabled])', 'button[type=\"submit\"]:not([disabled])', 'button[aria-label*=\"Send\" i]:not([disabled])'],
+      stopButton: 'button[aria-label*=\"Stop\" i]'
+    },
+    lechat: {
+      answerContainer: 'main, article',
+      lastMessage: 'article, .prose',
+      streamStart: ['article', '.prose'],
+      generatingIndicators: ['[aria-busy=\"true\"]', '.loading'],
+      completionIndicators: ['button[type=\"submit\"]:not([disabled])'],
+      stopButton: 'button[aria-label*=\"Stop\" i]'
+    },
+    generic: {
+      answerContainer: 'main, [role=\"main\"], article',
+      lastMessage: '.prose, article',
+      streamStart: ['.prose', 'article', '[role=\"log\"]'],
+      generatingIndicators: ['.loading', '.spinner', '[aria-busy=\"true\"]'],
+      completionIndicators: ['textarea:not([disabled])', 'button[type=\"submit\"]:not([disabled])'],
+      stopButton: 'button[aria-label*=\"Stop\" i]'
+    }
+  };
+
+  window.AnswerPipelineSelectors = { PLATFORM_SELECTORS, detectPlatform };
+})();
```

### 4.2 UnifiedAnswerPipeline: подключение SelectorBundle

**Строки/якоря (в текущей ветке):**
6:  const SelectorBundle = window.AnswerPipelineSelectors;

**Diff (content-scripts/unified-answer-pipeline.js — первые hunks):**
```diff
--- a/content-scripts/unified-answer-pipeline.js
+++ b/content-scripts/unified-answer-pipeline.js
@@ -9,9 +9,16 @@
   const SanityCheckClass = namespace.SanityCheck;
 
   if (!Modules || !Config || !SelectorBundle || !WatcherClass || !SanityCheckClass) {
-    console.warn('[UnifiedAnswerPipeline] Missing dependencies (modules/config/selectors/watcher/sanity)');
+    console.error('[UnifiedAnswerPipeline] Missing dependencies:', {
+      Modules: !!Modules,
+      Config: !!Config,
+      SelectorBundle: !!SelectorBundle,
+      WatcherClass: !!WatcherClass,
+      SanityCheckClass: !!SanityCheckClass
+    });
     return;
   }
+  console.log('[UnifiedAnswerPipeline] All dependencies loaded successfully');
 
   const {
     AdaptiveTimeoutManager,
@@ -77,12 +84,14 @@
         this.config.streaming.continuousActivity = Object.assign({}, this.config.streaming.continuousActivity, { enabled: false });
         this.config.streaming.initialScrollKick = Object.assign({}, this.config.streaming.initialScrollKick, { enabled: false });
       }
-      this.selectors = PLATFORM_SELECTORS[this.platform] || PLATFORM_SELECTORS.generic || {};
+      const platformSelectors = PLATFORM_SELECTORS[this.platform];
+      this.selectors = platformSelectors || PLATFORM_SELECTORS.generic || {};
+      this.platformSelectorsMissing = !platformSelectors || !Object.keys(platformSelectors || {}).length;
 
       this.adaptiveTimeout = new AdaptiveTimeoutManager(this.config.streaming?.adaptiveTimeout);
       this.retryManager = new IntelligentRetryManager(this.config.streaming?.intelligentRetry);
       this.humanActivity = new ContinuousHumanActivity(this.config.streaming?.continuousActivity);
-      this.tabProtector = new Modules.TabProtector?.() || null;
+      this.tabProtector = Modules.TabProtector ? new Modules.TabProtector() : null;
       this._initHumanSession();
       this.maintenanceScroll = new MaintenanceScroll(this.config.streaming?.maintenanceScroll, this.humanSession);
       this.sanityCheck = new SanityCheckClass(this.config.finalization?.sanityCheck);
```

### 4.3 Manifest: общий блок инъекции + подключение answer‑pipeline‑selectors

**Строки/якоря (в текущей ветке):**
74:        "content-scripts/answer-pipeline-selectors.js",

**Diff (manifest.json — целиком):**
```diff
--- a/manifest.json
+++ b/manifest.json
@@ -1,7 +1,7 @@
 {
   "manifest_version": 3,
   "name": "A_Codex",
-  "version": "2.46",
+  "version": "2.53",
   "description": "Compares LLMs.",
   "permissions": [
     "storage",
@@ -10,27 +10,30 @@
     "activeTab",
     "alarms"
   ],
- "host_permissions": [
-"*://chat.openai.com/*",
-"*://chatgpt.com/*",
-"*://gemini.google.com/*",
-"*://bard.google.com/*",
-"*://claude.ai/*",
-"*://grok.com/*",
-"*://x.com/*",
-"*://chat.qwen.ai/*",
-"*://chat.mistral.ai/*",
-"*://chat.deepseek.com/*",
-"*://perplexity.ai/*",
-"https://api.openai.com/*",
-"https://api.anthropic.com/*",
-"https://generativelanguage.googleapis.com/*",
-"https://api.x.ai/*",
-"https://api.mistral.ai/*",
-"https://dashscope.aliyuncs.com/*",
-"https://api.deepseek.com/*",
-"https://api.perplexity.ai/*"
-],
+  "host_permissions": [
+    "*://chat.openai.com/*",
+    "*://chatgpt.com/*",
+    "*://gemini.google.com/*",
+    "*://bard.google.com/*",
+    "*://claude.ai/*",
+    "*://grok.com/*",
+    "*://grok.x.ai/*",
+    "*://x.com/*",
+    "*://x.ai/*",
+    "*://chat.qwen.ai/*",
+    "*://chat.mistral.ai/*",
+    "*://chat.deepseek.com/*",
+    "*://perplexity.ai/*",
+    "*://www.perplexity.ai/*",
+    "https://api.openai.com/*",
+    "https://api.anthropic.com/*",
+    "https://generativelanguage.googleapis.com/*",
+    "https://api.x.ai/*",
+    "https://api.mistral.ai/*",
+    "https://dashscope.aliyuncs.com/*",
+    "https://api.deepseek.com/*",
+    "https://api.perplexity.ai/*"
+  ],
   "background": {
     "service_worker": "background.js"
   },
@@ -41,67 +44,74 @@
       "128": "icons/icon128.png"
     }
   },
-"content_scripts": [
+  "content_scripts": [
     {
       "matches": [
         "*://chat.openai.com/*",
-        "*://chatgpt.com/*"
+        "*://chatgpt.com/*",
+        "*://gemini.google.com/*",
+        "*://bard.google.com/*",
+        "*://claude.ai/*",
+        "*://grok.com/*",
+        "*://grok.x.ai/*",
+        "*://x.com/*",
+        "*://x.ai/*",
+        "*://chat.qwen.ai/*",
+        "*://chat.mistral.ai/*",
+        "*://chat.deepseek.com/*",
+        "*://www.perplexity.ai/*",
+        "*://perplexity.ai/*"
       ],
       "js": [
         "content-scripts/content-bootstrap.js",
+        "content-scripts/fetch-monitor.js",
+        "content-scripts/content-utils.js",
+        "scroll-toolkit.js",
+        "humanoid.js",
+        "selector-manager-strategies.js",
+        "selector-manager.js",
+        "content-scripts/pipeline-config.js",
+        "content-scripts/answer-pipeline-selectors.js",
         "content-scripts/selectors-finder-lite.js",
         "content-scripts/selectors-metrics.js",
         "content-scripts/selectors-circuit.js",
         "content-scripts/pragmatist-core.js",
+        "content-scripts/pipeline-modules.js",
+        "content-scripts/sanity-check.js",
+        "content-scripts/unified-answer-watcher.js",
+        "content-scripts/unified-answer-pipeline.js",
         "content-scripts/pragmatist-runner.js",
-        "scroll-toolkit.js",
-        "selector-manager-strategies.js",
-        "selector-manager.js",
-        "selectors/chatgpt.config.js",
-        "selectors-config.js",
-        "humanoid.js",
+        "selectors/config-bundle.js",
+        "selectors-config.js"
+      ],
+      "run_at": "document_end"
+    },
+    {
+      "matches": [
+        "*://chat.openai.com/*",
+        "*://chatgpt.com/*"
+      ],
+      "js": [
         "content-scripts/content-chatgpt.js"
       ],
       "run_at": "document_end"
     },
     {
       "matches": [
-        "*://www.perplexity.ai/*"
+        "*://www.perplexity.ai/*",
+        "*://perplexity.ai/*"
       ],
       "js": [
-        "content-scripts/content-bootstrap.js",
-        "content-scripts/selectors-finder-lite.js",
-        "content-scripts/selectors-metrics.js",
-        "content-scripts/selectors-circuit.js",
-        "content-scripts/pragmatist-core.js",
-        "content-scripts/pragmatist-runner.js",
-        "scroll-toolkit.js",
-        "selector-manager-strategies.js",
-        "selector-manager.js",
-        "selectors/perplexity.config.js",
-        "selectors-config.js",
-        "humanoid.js",
         "content-scripts/content-perplexity.js"
       ],
       "run_at": "document_end"
     },
     {
       "matches": [
-        "*://gemini.google.com/*"
+        "*://gemini.google.com/*",
+        "*://bard.google.com/*"
       ],
       "js": [
-        "content-scripts/content-bootstrap.js",
-        "content-scripts/selectors-finder-lite.js",
-        "content-scripts/selectors-metrics.js",
-        "content-scripts/selectors-circuit.js",
-        "content-scripts/pragmatist-core.js",
-        "content-scripts/pragmatist-runner.js",
-        "scroll-toolkit.js",
-        "selector-manager-strategies.js",
-        "selector-manager.js",
-        "selectors/gemini.config.js",
-        "selectors-config.js",
-        "humanoid.js",
         "content-scripts/content-gemini.js"
       ],
       "run_at": "document_end"
@@ -111,18 +121,6 @@
         "*://claude.ai/*"
       ],
       "js": [
-        "content-scripts/content-bootstrap.js",
-        "content-scripts/selectors-finder-lite.js",
-        "content-scripts/selectors-metrics.js",
-        "content-scripts/selectors-circuit.js",
-        "content-scripts/pragmatist-core.js",
-        "content-scripts/pragmatist-runner.js",
-        "scroll-toolkit.js",
-        "selector-manager-strategies.js",
-        "selector-manager.js",
-        "selectors/claude.config.js",
-        "selectors-config.js",
-        "humanoid.js",
         "content-scripts/content-claude.js"
       ],
       "run_at": "document_end"
@@ -130,21 +128,12 @@
     {
       "matches": [
         "*://grok.com/*",
+        "*://grok.x.ai/*",
         "*://x.com/*"
+        ,
+        "*://x.ai/*"
       ],
       "js": [
-        "content-scripts/content-bootstrap.js",
-        "content-scripts/selectors-finder-lite.js",
-        "content-scripts/selectors-metrics.js",
-        "content-scripts/selectors-circuit.js",
-        "content-scripts/pragmatist-core.js",
-        "content-scripts/pragmatist-runner.js",
-        "scroll-toolkit.js",
-        "selector-manager-strategies.js",
-        "selector-manager.js",
-        "selectors/grok.config.js",
-        "selectors-config.js",
-        "humanoid.js",
         "content-scripts/content-grok.js"
       ],
       "run_at": "document_end"
@@ -154,20 +143,8 @@
         "*://chat.qwen.ai/*"
       ],
       "js": [
-        "content-scripts/content-bootstrap.js",
-        "content-scripts/selectors-finder-lite.js",
-        "content-scripts/selectors-metrics.js",
-        "content-scripts/selectors-circuit.js",
-        "content-scripts/pragmatist-core.js",
-        "content-scripts/pragmatist-runner.js",
-        "scroll-toolkit.js",
-        "selector-manager-strategies.js",
-        "selector-manager.js",
-        "selectors/qwen.config.js",
-        "selectors-config.js",
-        "humanoid.js",
         "content-scripts/content-qwen.js"
-      ], 
+      ],
       "run_at": "document_end"
     },
     {
@@ -175,20 +152,8 @@
         "*://chat.mistral.ai/*"
       ],
       "js": [
-        "content-scripts/content-bootstrap.js",
-        "content-scripts/selectors-finder-lite.js",
-        "content-scripts/selectors-metrics.js",
-        "content-scripts/selectors-circuit.js",
-        "content-scripts/pragmatist-core.js",
-        "content-scripts/pragmatist-runner.js",
-        "scroll-toolkit.js",
-        "selector-manager-strategies.js",
-        "selector-manager.js",
-        "selectors/lechat.config.js",
-        "selectors-config.js",
-        "humanoid.js",
         "content-scripts/content-lechat.js"
-      ],      
+      ],
       "run_at": "document_end"
     },
     {
@@ -196,48 +161,41 @@
         "*://chat.deepseek.com/*"
       ],
       "js": [
-        "content-scripts/content-bootstrap.js",
-        "content-scripts/selectors-finder-lite.js",
-        "content-scripts/selectors-metrics.js",
-        "content-scripts/selectors-circuit.js",
-        "content-scripts/pragmatist-core.js",
-        "content-scripts/pragmatist-runner.js",
-        "scroll-toolkit.js",
-        "selector-manager-strategies.js",
-        "selector-manager.js",
-        "selectors/deepseek.config.js",
-        "selectors-config.js",
-        "humanoid.js",
         "content-scripts/content-deepseek.js"
-      ],      
+      ],
       "run_at": "document_end"
     }
   ],
-
   "icons": {
     "16": "icons/icon16.png",
     "48": "icons/icon48.png",
     "128": "icons/icon128.png"
   },
-
-  "web_accessible_resources": [{
-  "resources": [
-    "result_new.html",
-    "styles.css",
-    "results.js",
-    "Modifiers/modifier-presets.json",
-    "Modifiers/modifiers.json",
-    "Modifiers/modifiers_product.json",
-    "Modifiers/modifiers_product-manager.json",
-    "Modifiers/modifiers-research.json",
-    "Modifiers/modifiers_marketing.json",
-    "Modifiers/modifiers_support.json",
-    "Modifiers/modifiers_ideation.json",
-    "Modifiers/modifiers_photo_enhance.json",
-    "system_templates/*",
-    "system_templates/index.json"
-  ],
-  "matches": ["<all_urls>"]
-}]
-  
+  "web_accessible_resources": [
+    {
+      "resources": [
+        "result_new.html",
+        "styles.css",
+        "results.js",
+        "content-scripts/content-bridge.js",
+        "content-scripts/fetch-monitor-bridge.js",
+        "scroll-toolkit.js",
+        "humanoid.js",
+        "Modifiers/modifier-presets.json",
+        "Modifiers/modifiers.json",
+        "Modifiers/modifiers_product.json",
+        "Modifiers/modifiers_product-manager.json",
+        "Modifiers/modifiers-research.json",
+        "Modifiers/modifiers_marketing.json",
+        "Modifiers/modifiers_support.json",
+        "Modifiers/modifiers_ideation.json",
+        "Modifiers/modifiers_photo_enhance.json",
+        "system_templates/*",
+        "system_templates/index.json"
+      ],
+      "matches": [
+        "<all_urls>"
+      ]
+    }
+  ]
 }
```

### 4.4 Pipeline config: hardMax=180000 и запрет активации вкладок

**Строки/якоря (в текущей ветке):**
7:      allowTabActivation: false,
26:        hardMax: 180000

**Diff (content-scripts/pipeline-config.js):**
```diff
--- a/content-scripts/pipeline-config.js
+++ b/content-scripts/pipeline-config.js
@@ -4,7 +4,8 @@
   const CONFIG = {
     preparation: {
       tabActivationTimeout: 3000,
-      streamStartTimeout: 45000,
+      allowTabActivation: false,
+      streamStartTimeout: 30000,
       streamStartPollInterval: 100
     },
     streaming: {
@@ -17,12 +18,12 @@
         }
       },
       adaptiveTimeout: {
-        short: { maxChars: 500, timeout: 15000 },
-        medium: { maxChars: 2000, timeout: 30000 },
-        long: { maxChars: 5000, timeout: 60000 },
-        veryLong: { maxChars: Infinity, timeout: 120000 },
-        softExtension: 15000,
-        hardMax: 120000
+        short: { maxChars: 500, timeout: 20000 },
+        medium: { maxChars: 2000, timeout: 45000 },
+        long: { maxChars: 5000, timeout: 90000 },
+        veryLong: { maxChars: Infinity, timeout: 180000 },
+        softExtension: 30000,
+        hardMax: 180000
       },
       intelligentRetry: {
         enabled: true,
@@ -40,11 +41,13 @@
       },
       completionCriteria: {
         completionSignalEnabled: true,
-        mutationIdle: 1500,
-        scrollStable: 2000,
-        contentStable: 1500,
-        minMetCriteria: 3,
-        checkInterval: 500
+        mutationIdle: 15000,
+        scrollStable: 4000,
+        contentStable: 8000,
+        minMetCriteria: 4,
+        stopButtonCheckMode: 'fresh',
+        stopButtonCacheMaxAgeMs: 3000,
+        checkInterval: 3000
       },
       continuousActivity: {
         enabled: true,
```

### 4.5 ChatGPT: grabLatestAssistantMarkup + DOM fallback

**Строки/якоря (в текущей ветке):**
33:  function grabLatestAssistantMarkup() {
1182:          const latestMarkup = grabLatestAssistantMarkup();
1246:                const latestMarkup = grabLatestAssistantMarkup();
1185:            console.warn('[CONTENT-GPT] Pipeline empty, using DOM fallback');

**Diff (content-scripts/content-chatgpt.js — ключевые hunks):**
```diff
--- a/content-scripts/content-chatgpt.js
+++ b/content-scripts/content-chatgpt.js
@@ -22,6 +22,55 @@
 
 (function () {
   const MODEL = "GPT";
+  const FALLBACK_LAST_MESSAGE_SELECTORS = [
+    '[data-testid="conversation-turn"][data-message-author-role="assistant"]',
+    'div[data-message-author-role="assistant"]',
+    '.prose',
+    'article',
+    '[role="article"]'
+  ];
+
+  function grabLatestAssistantMarkup() {
+    try {
+      const selectorsFromBundle = (window.AnswerPipelineSelectors?.PLATFORM_SELECTORS?.chatgpt?.lastMessage
+        ? [window.AnswerPipelineSelectors.PLATFORM_SELECTORS.chatgpt.lastMessage]
+        : []).flat().filter(Boolean);
+      const candidates = selectorsFromBundle.length ? selectorsFromBundle : FALLBACK_LAST_MESSAGE_SELECTORS;
+      const nodes = [];
+      const seen = new Set();
+      const pushUnique = (el) => {
+        if (!el || el.nodeType !== 1) return;
+        if (seen.has(el)) return;
+        seen.add(el);
+        nodes.push(el);
+      };
+      for (const sel of candidates) {
+        try {
+          document.querySelectorAll(sel).forEach(pushUnique);
+        } catch (_) {}
+      }
+      if (!nodes.length) return '';
+      const sorted = nodes.slice().sort((a, b) => {
+        if (a === b) return 0;
+        try {
+          const pos = a.compareDocumentPosition(b);
+          if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
+          if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
+        } catch (_) {}
+        return 0;
+      });
+      for (let i = sorted.length - 1; i >= 0; i--) {
+        const node = sorted[i];
+        const html = (node.innerHTML || '').trim();
+        if (html) return html;
+        const text = (node.textContent || '').trim();
+        if (text) return text;
+      }
+    } catch (err) {
+      console.warn('[CONTENT-GPT] grabLatestAssistantMarkup failed', err);
+    }
+    return '';
+  }
   // Pragmatist integration
   const prag = window.__PragmatistAdapter;
   const getPragSessionId = () => prag?.sessionId;
@@ -927,8 +1067,8 @@
           'button[data-testid="pegasus-send-button"]',
           'button[data-testid*="send-button"]',
           'button[data-testid*="send"]',
-          'button[aria-label*="Send"]',
-          'button[aria-label*="message"]',
+          'button[aria-label*="Send" i]',
+          'button[aria-label*="send" i]',
           'button[class*="SendButton"]',
           
           // Icon-based
@@ -943,67 +1083,80 @@
           
           // Form-based
           'form button[type="submit"]',
-          'form button:not([disabled])',
-          'form [role="button"][aria-label*="send" i]',
-          
-          // Positional fallback
-          'button:not([disabled])',
-          '[role="button"]:not([aria-disabled="true"])'
+          'form [role="button"][aria-label*="send" i]'
         ];
 
         console.log('[CONTENT-GPT] Looking for send button...');
         activity.heartbeat(0.45, { phase: 'send-button-search' });
         
-        let sendButton = null;
-        try {
-            sendButton = await findAndCacheElement('sendButton', sendButtonSelectors, 10000);
-        } catch (err) {
-            console.warn('[CONTENT-GPT] Send button not found via selectors, trying smart search...');
-            
-            // Smart search: find button near the input field
-            const inputRect = inputField.getBoundingClientRect();
-            const allButtons = Array.from(document.querySelectorAll('button:not([disabled]), [role="button"]:not([aria-disabled="true"])'));
-            
-            console.log(`[DEBUG] Checking ${allButtons.length} buttons for proximity to input`);
-            
-            for (const btn of allButtons) {
-                if (isElementInteractable(btn)) {
-                    const btnRect = btn.getBoundingClientRect();
-                    
-                    // Button should be close to input (within 200px)
-                    const distance = Math.sqrt(
-                        Math.pow(btnRect.left - inputRect.right, 2) + 
-                        Math.pow(btnRect.top - inputRect.top, 2)
-                    );
-                    
-                    if (distance < 200) {
-                        const hasIcon = btn.querySelector('svg') !== null;
-                        const btnText = btn.textContent?.trim().toLowerCase() || '';
-                        
-                        console.log(`[DEBUG] Button candidate (distance: ${distance.toFixed(0)}px):`, {
-                            hasIcon,
-                            text: btnText.substring(0, 20),
-                            ariaLabel: btn.getAttribute('aria-label')
-                        });
-                        
-                        // Prefer buttons with icons or send-related text
-                        if (hasIcon || btnText.includes('send') || distance < 100) {
-                            sendButton = btn;
-                            console.log('[CONTENT-GPT] Found send button via smart search');
-                            break;
-                        }
-                    }
-                }
-            }
-            
-            if (!sendButton) {
-                throw { type: 'selector_not_found', message: 'ChatGPT send button not found' };
+        const resolveSendButton = async () => {
+          const scope = inputField.closest('form') || inputField.closest('[data-testid*="composer"]') || inputField.parentElement || document;
+          for (const sel of sendButtonSelectors) {
+            let el = null;
+            try { el = scope.querySelector?.(sel) || document.querySelector(sel); } catch (_) { el = null; }
+            if (!el) continue;
+            if (!isElementInteractable(el)) continue;
+            const ariaDisabled = el.getAttribute?.('aria-disabled');
+            if (el.disabled || ariaDisabled === 'true') continue;
+            const aria = String(el.getAttribute?.('aria-label') || '').toLowerCase();
+            const testid = String(el.getAttribute?.('data-testid') || '').toLowerCase();
+            if (testid.includes('send') || aria.includes('send') || aria.includes('submit') || el.type === 'submit') {
+              return el;
             }
+          }
+          return null;
+        };
+
+        const tryEnterSend = async () => {
+          try { inputField.focus?.({ preventScroll: true }); } catch (_) { try { inputField.focus?.(); } catch (_) {} }
+          const down = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
+          const up = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
+          inputField.dispatchEvent(down);
+          inputField.dispatchEvent(up);
+        };
+
+        const confirmChatgptSend = async () => {
+          const before = document.querySelectorAll('[data-message-author-role="user"]').length;
+          const deadline = Date.now() + 1600;
+          while (Date.now() < deadline) {
+            const stopBtn = document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop" i]');
+            if (stopBtn && isElementInteractable(stopBtn)) return true;
+            const after = document.querySelectorAll('[data-message-author-role="user"]').length;
+            if (after > before) return true;
+            const val = String(inputField.value ?? inputField.textContent ?? '').trim();
+            if (!val.length) return true;
+            await sleep(120);
+          }
+          return false;
+        };
+
+        // Wait a bit for Send to become enabled after React state updates
+        let sendButton = null;
+        const enableDeadline = Date.now() + 2500;
+        while (Date.now() < enableDeadline) {
+          sendButton = await resolveSendButton();
+          if (sendButton) break;
+          await sleep(120);
         }
-        
-        console.log('[CONTENT-GPT] Clicking send button');
-        await humanClick(sendButton);
+        if (sendButton) {
+          console.log('[CONTENT-GPT] Clicking send button');
+          await humanClick(sendButton);
+        } else {
+          console.warn('[CONTENT-GPT] Send button not found, trying Enter fallback');
+          await tryEnterSend();
+        }
+
+        let confirmed = await confirmChatgptSend();
+        if (!confirmed && sendButton) {
+          console.warn('[CONTENT-GPT] Send not confirmed, trying Enter fallback');
+          await tryEnterSend();
+          confirmed = await confirmChatgptSend();
+        }
+        if (!confirmed) {
+          throw { type: 'send_failed', message: 'ChatGPT send not confirmed' };
+        }
         activity.heartbeat(0.5, { phase: 'send-dispatched' });
+        try { chrome.runtime.sendMessage({ type: 'PROMPT_SUBMITTED', llmName: MODEL, ts: Date.now() }); } catch (_) {}
 
         console.log('[CONTENT-GPT] Message sent, waiting for response...');
         activity.heartbeat(0.6, { phase: 'waiting-response' });
@@ -1024,150 +1177,46 @@
         if (pipelineAnswer) {
           return pipelineAnswer;
         }
-        const response = await withSmartScroll(() => waitForResponse(120000), {
-          keepAliveInterval: 2000,
-          operationTimeout: 300000,
-          debug: false
-        });
+        // Fallback: grab latest DOM answer if pipeline missed it
+        try {
+          const latestMarkup = grabLatestAssistantMarkup();
+          const cleanedFallback = window.contentCleaner.cleanContent(latestMarkup || '', { maxLength: 50000 });
+          if (cleanedFallback) {
+            console.warn('[CONTENT-GPT] Pipeline empty, using DOM fallback');
+            lastResponseSnapshot = cleanedFallback;
+            activity.stop({ status: 'success', answerLength: cleanedFallback.length, source: 'dom-fallback' });
+            return cleanedFallback;
+          }
+        } catch (fallbackErr) {
+          console.warn('[CONTENT-GPT] DOM fallback failed', fallbackErr);
+        }
+        throw new Error('Pipeline did not return answer');
 
-        // Очистка ответа с помощью нового модуля
-        const cleanedResponse = window.contentCleaner.cleanContent(response, {
-            maxLength: 50000
-        });
-        lastResponseSnapshot = cleanedResponse;
-
-        console.log(`[CONTENT-GPT] Process completed. Response length: ${cleanedResponse.length}`);
-        activity.heartbeat(0.9, { phase: 'response-processed' });
-        activity.stop({ status: 'success', answerLength: cleanedResponse.length });
-        return cleanedResponse;
-
       } catch (error) {
         if (error?.code === 'background-force-stop') {
           activity.error(error, false);
           throw error;
         }
-        activity.error(error, true);
+
+        // Only fatal errors (selector/injection) set error status
+        // Other errors handled by handleLLMResponse
+        const isFatal = String(error).includes('selector') || String(error).includes('injection');
+
+        if (isFatal) {
+          activity.error(error, true);
+        } else {
+          activity.stop({ status: 'error' });
+        }
+
         throw error;
       }
     });
-  }
 
-  // УЛУЧШЕННАЯ ФУНКЦИЯ ОЖИДАНИЯ (MutationObserver + стабильность)
-  async function waitForResponse(timeout = 120000) {
-    console.log('[CONTENT-GPT] Waiting for response (observer mode)…');
-    const stopSelectors = [
-      'button[aria-label*="Stop"]',
-      'button[aria-label*="stop"]'
-    ];
-    const messageSelectors = [
-      'div[data-message-author-role="assistant"]',
-      'div.agent-turn',
-      'div[class*="agent-turn"]',
-      'div[data-testid="conversation-turn"]',
-      'article[data-testid*="conversation"]',
-      '.group\/turn-messages',
-      '[class*="turn-messages"]'
-    ];
-    const contentSelectors = [
-      '.markdown',
-      '[class*="markdown"]',
-      '.prose',
-      '[class*="prose"]',
-      '.text-message',
-      '[class*="message-content"]',
-      'article',
-      'div[class*="flex"]',
-      'div',
-      'p'
-    ];
-
-    const readAssistantText = () => {
-      let nodes = null;
-      for (const sel of messageSelectors) {
-        try {
-          nodes = document.querySelectorAll(sel);
-          if (nodes.length) break;
-        } catch (_) {}
-      }
-      if (!nodes || !nodes.length) return null;
-      const last = nodes[nodes.length - 1];
-      let contentNode = null;
-      for (const sel of contentSelectors) {
-        try {
-          const candidate = last.querySelector(sel);
-          if (candidate && candidate.innerText?.trim().length > 10) {
-            contentNode = candidate;
-            break;
-          }
-        } catch (_) {}
-      }
-      if (!contentNode) contentNode = last;
-      let currentText = '';
-      if (contentNode.innerHTML && contentNode.innerHTML.trim().length > 10) {
-        currentText = contentNode.innerHTML.trim();
-      } else if (contentNode.innerText && contentNode.innerText.trim().length > 10) {
-        currentText = contentNode.innerText.trim();
-      } else if (contentNode.textContent && contentNode.textContent.trim().length > 10) {
-        currentText = contentNode.textContent.trim();
-      }
-      if (!currentText) return null;
-      const isGenerating = stopSelectors.some((sel) => document.querySelector(sel));
-      return { text: currentText, isGenerating };
-    };
-
-    return new Promise((resolve, reject) => {
-      let lastText = '';
-      let stableCount = 0;
-      let settled = false;
-      const observer = cleanupScope.trackObserver(new MutationObserver(() => evaluate()));
-      const intervalId = cleanupScope.trackInterval(setInterval(() => evaluate(), 1200));
-      const timerId = cleanupScope.trackTimeout(setTimeout(() => {
-        if (settled) return;
-        settled = true;
-        observer.disconnect();
-        clearInterval(intervalId);
-        if (lastText) {
-          console.warn('[CONTENT-GPT] Timeout reached, returning last snippet.');
-          resolve(lastText);
-        } else {
-          reject(new Error('Timeout: No response received from ChatGPT'));
-        }
-      }, timeout));
-
-      const cleanup = (value) => {
-        if (settled) return;
-        settled = true;
-        observer.disconnect();
-        clearInterval(intervalId);
-        clearTimeout(timerId);
-        resolve(value);
-      };
-
-      const evaluate = () => {
-        const snapshot = readAssistantText();
-        if (!snapshot) return;
-        const { text, isGenerating } = snapshot;
-        if (isGenerating) {
-          lastText = text;
-          stableCount = 0;
-          return;
-        }
-        if (!lastText) lastText = text;
-        if (text === lastText) {
-          stableCount += 1;
-          if (stableCount >= 2) {
-            console.log('[CONTENT-GPT] Response stabilized.');
-            cleanup(text);
-          }
-        } else {
-          lastText = text;
-          stableCount = 0;
-        }
-      };
-
-      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
-      evaluate();
+    gptSharedInjection = opPromise;
+    opPromise.finally(() => {
+      if (gptSharedInjection === opPromise) gptSharedInjection = null;
     });
+    return opPromise;
   }
 
   // ОБРАБОТЧИК СООБЩЕНИЙ (с улучшенной обработкой)
```

### 4.6 Gemini: grabLatestAssistantMarkup + DOM fallback (+ SelectorFinder fallback)

**Строки/якоря (в текущей ветке):**
32:function grabLatestAssistantMarkup() {
943:          const latestMarkup = grabLatestAssistantMarkup();
946:            console.warn('[content-gemini] Pipeline empty, using DOM fallback');

**Diff (content-scripts/content-gemini.js — ключевые hunks):**
```diff
--- a/content-scripts/content-gemini.js
+++ b/content-scripts/content-gemini.js
@@ -19,7 +19,102 @@
 //-- Конец защиты --//
 
 const MODEL = "Gemini";
+const GEMINI_FALLBACK_LAST_MESSAGE_SELECTORS = [
+  '[data-test-id*="model-response"]',
+  '[data-testid*="model-response"]',
+  '.model-response',
+  'model-response',
+  'message-content',
+  '[data-message-author-role="assistant"]',
+  '[data-role="assistant"]'
+];
+
+function grabLatestAssistantMarkup() {
+  try {
+    const selectorsFromBundle = (window.AnswerPipelineSelectors?.PLATFORM_SELECTORS?.gemini?.lastMessage
+      ? [window.AnswerPipelineSelectors.PLATFORM_SELECTORS.gemini.lastMessage]
+      : []).flat().filter(Boolean);
+    const candidates = selectorsFromBundle.length ? selectorsFromBundle : GEMINI_FALLBACK_LAST_MESSAGE_SELECTORS;
+    for (const sel of candidates) {
+      const nodes = Array.from(document.querySelectorAll(sel));
+      for (let i = nodes.length - 1; i >= 0; i--) {
+        const node = nodes[i];
+        if (!node) continue;
+        if (node.innerHTML && node.innerHTML.trim()) return node.innerHTML;
+        if (node.textContent && node.textContent.trim()) return node.textContent;
+      }
+    }
+  } catch (err) {
+    console.warn('[content-gemini] grabLatestAssistantMarkup failed', err);
+  }
+  return '';
+}
+
+async function trySelectorFinderResponse(prompt, timeoutMs = 60000) {
+  const finder = window.SelectorFinder;
+  if (!finder?.waitForElement) return '';
+  try {
+    const res = await finder.waitForElement({
+      modelName: MODEL,
+      elementType: 'response',
+      timeout: timeoutMs,
+      prompt: prompt || ''
+    });
+    return (res?.text || '').trim();
+  } catch (err) {
+    console.warn('[content-gemini] SelectorFinder response fallback failed', err);
+    return '';
+  }
+}
+
+// --- Idempotency / singleflight (prevents periodic re-insertion on duplicate GET_ANSWER) ---
+let geminiSharedInjection = null;
+let geminiSharedFingerprint = null;
+let geminiSharedStartedAt = 0;
+let geminiLastSubmittedFingerprint = null;
+let geminiLastSubmittedAt = 0;
+let geminiSessionId = null;
+const GEMINI_SUBMIT_DEDUPE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
+
+function quickHash(s) {
+  const str = String(s || '');
+  let hash = 2166136261;
+  for (let i = 0; i < str.length; i++) {
+    hash ^= str.charCodeAt(i);
+    hash = Math.imul(hash, 16777619);
+  }
+  return (hash >>> 0).toString(16);
+}
+
+function fingerprintPrompt(prompt = '') {
+  const s = String(prompt || '');
+  return `${s.length}:${quickHash(s.slice(0, 600))}`;
+}
+
+function readComposerText(el) {
+  if (!el) return '';
+  try {
+    if ('value' in el) return String(el.value || '').trim();
+  } catch (_) {}
+  try {
+    const raw = (el.innerText || el.textContent || '');
+    return String(raw).replace(/\u200B/g, '').trim();
+  } catch (_) {
+    return '';
+  }
+}
 
+function ensureSession(nextSessionId) {
+  if (!nextSessionId) return;
+  if (geminiSessionId === nextSessionId) return;
+  geminiSessionId = nextSessionId;
+  geminiSharedInjection = null;
+  geminiSharedFingerprint = null;
+  geminiSharedStartedAt = 0;
+  geminiLastSubmittedFingerprint = null;
+  geminiLastSubmittedAt = 0;
+}
+
 window.setupHumanoidFetchMonitor?.(MODEL, ({ status, retryAfter }) => {
     if (status !== 429) return;
     const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 || 60000 : 60000;
@@ -777,6 +915,9 @@
         console.log('[content-gemini] Clicking send button');
         await geminiHumanClick(sendButton);
         activity.heartbeat(0.6, { phase: 'send-dispatched' });
+        geminiLastSubmittedFingerprint = fp;
+        geminiLastSubmittedAt = Date.now();
+        try { chrome.runtime.sendMessage({ type: 'PROMPT_SUBMITTED', llmName: MODEL, ts: Date.now() }); } catch (_) {}
 
         console.log('[content-gemini] Message sent, waiting for response...');
         activity.heartbeat(0.7, { phase: 'waiting-response' });
@@ -797,110 +938,57 @@
         if (pipelineAnswer) {
             return pipelineAnswer;
         }
-        const response = await withSmartScroll(() => waitForResponse(120000), {
-            keepAliveInterval: 2000,
-            operationTimeout: 300000,
-            debug: false
-        });
-
-        // Очистка ответа с помощью нового модуля
-        const cleanedResponse = window.contentCleaner.cleanContent(response, {
-            maxLength: 50000
-        });
-
-        console.log(`[content-gemini] Process completed. Response length: ${cleanedResponse.length}`);
-        activity.heartbeat(0.95, { phase: 'response-processed' });
-        activity.stop({ status: 'success', answerLength: cleanedResponse.length });
-        return cleanedResponse;
+        // Fallback: read last assistant message if pipeline missed
+        try {
+          const latestMarkup = grabLatestAssistantMarkup();
+          const cleanedFallback = window.contentCleaner.cleanContent(latestMarkup || '', { maxLength: 50000 });
+          if (cleanedFallback) {
+            console.warn('[content-gemini] Pipeline empty, using DOM fallback');
+            activity.stop({ status: 'success', answerLength: cleanedFallback.length, source: 'dom-fallback' });
+            return cleanedFallback;
+          }
+        } catch (fallbackErr) {
+          console.warn('[content-gemini] DOM fallback failed', fallbackErr);
+        }
+        // Last resort: SelectorFinder observation-based extraction (can traverse shadow DOM).
+        try {
+          const finderText = await trySelectorFinderResponse(prompt, 60000);
+          const cleanedFinder = window.contentCleaner.cleanContent(finderText || '', { maxLength: 50000 });
+          if (cleanedFinder) {
+            console.warn('[content-gemini] DOM fallback empty, using SelectorFinder response');
+            activity.stop({ status: 'success', answerLength: cleanedFinder.length, source: 'selector-finder' });
+            return cleanedFinder;
+          }
+        } catch (finderErr) {
+          console.warn('[content-gemini] SelectorFinder fallback crashed', finderErr);
+        }
+        throw new Error('Pipeline did not return answer');
         } catch (error) {
         if (error?.code === 'background-force-stop') {
             activity.error(error, false);
             throw error;
         }
-        activity.error(error, true);
-        throw error;
-      }
-    });
-}
 
-// --- ОЖИДАНИЕ ОТВЕТА (логика сохранена, т.к. специфична для Gemini) ---
-async function waitForResponse(timeout = 120000) {
-    const responseSelectors = [
-        '.model-response-text',
-        '[data-testid="model-response-text"]',
-        '.markdown'
-    ];
-    const generatingSelector = '.loading-animation, .typing-indicator, [class*="generating"], .response-loader, [data-testid="generation-in-progress"]';
+        // Only fatal errors (selector/injection) set error status
+        // Other errors handled by handleLLMResponse
+        const isFatal = String(error).includes('selector') || String(error).includes('injection');
 
-    const readSnapshot = () => {
-        let nodes = [];
-        for (const sel of responseSelectors) {
-            try {
-                nodes = document.querySelectorAll(sel);
-                if (nodes.length) break;
-            } catch (_) {}
+        if (isFatal) {
+            activity.error(error, true);
+        } else {
+            activity.stop({ status: 'error' });
         }
-        if (!nodes.length) return null;
-        const last = nodes[nodes.length - 1];
-        const text = last.innerHTML?.trim();
-        if (!text) return null;
-        const isGenerating = Boolean(document.querySelector(generatingSelector));
-        return { text, isGenerating };
-    };
 
-    return new Promise((resolve, reject) => {
-        let lastText = '';
-        let stableCount = 0;
-        let settled = false;
-        const observer = cleanupScope.trackObserver(new MutationObserver(() => evaluate()));
-        const intervalId = cleanupScope.trackInterval(setInterval(() => evaluate(), 1200));
-        const timerId = cleanupScope.trackTimeout(setTimeout(() => {
-            if (settled) return;
-            settled = true;
-            observer.disconnect();
-            clearInterval(intervalId);
-            if (lastText) {
-                console.warn('[content-gemini] Timeout reached, returning last captured text.');
-                resolve(lastText);
-            } else {
-                reject(new Error('Timeout: No response received from Gemini'));
-            }
-        }, timeout));
+        throw error;
+      }
+    });
 
-        const cleanup = (value) => {
-            if (settled) return;
-            settled = true;
-            observer.disconnect();
-            clearInterval(intervalId);
-            clearTimeout(timerId);
-            resolve(value);
-        };
-
-        const evaluate = () => {
-            const snapshot = readSnapshot();
-            if (!snapshot) return;
-            const { text, isGenerating } = snapshot;
-            if (isGenerating) {
-                lastText = text;
-                stableCount = 0;
-                return;
-            }
-            if (!lastText) lastText = text;
-            if (text === lastText) {
-                stableCount += 1;
-                if (stableCount >= 2) {
-                    console.log('[content-gemini] Response stabilized.');
-                    cleanup(text);
-                }
-            } else {
-                lastText = text;
-                stableCount = 0;
-            }
-        };
-
-        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
-        evaluate();
+    geminiSharedInjection = opPromise.finally(() => {
+        if (geminiSharedInjection === opPromise) {
+            geminiSharedInjection = null;
+        }
     });
+    return geminiSharedInjection;
 }
 
 // --- ОБРАБОТЧИК СООБЩЕНИЙ (улучшенная версия из Claude) ---
```

### 4.7 Perplexity: grabLatestAssistantMarkup + DOM fallback (+ SelectorFinder fallback)

**Строки/якоря (в текущей ветке):**
43:function grabLatestAssistantMarkup() {
907:      const latestMarkup = grabLatestAssistantMarkup();
910:        console.warn('[content-perplexity] Pipeline empty, using DOM fallback');

**Diff (content-scripts/content-perplexity.js — ключевые hunks):**
```diff
--- a/content-scripts/content-perplexity.js
+++ b/content-scripts/content-perplexity.js
@@ -27,6 +27,56 @@
 //-- Конец защиты --//
 
 const MODEL = "Perplexity";
+const PERPLEXITY_FALLBACK_LAST_MESSAGE_SELECTORS = [
+  '[data-testid="answer-card"]',
+  '[data-testid="answer-card"] .prose',
+  '[data-testid="answer"]',
+  '[data-testid="answer"] .prose',
+  '[data-testid="chat-message"] .prose',
+  '[data-testid="conversation-turn"] .prose',
+  '[class*="answer-container" i] .prose',
+  '.answer',
+  '.prose',
+  'article'
+];
+
+function grabLatestAssistantMarkup() {
+  try {
+    const selectorsFromBundle = (window.AnswerPipelineSelectors?.PLATFORM_SELECTORS?.perplexity?.lastMessage
+      ? [window.AnswerPipelineSelectors.PLATFORM_SELECTORS.perplexity.lastMessage]
+      : []).flat().filter(Boolean);
+    const candidates = selectorsFromBundle.length ? selectorsFromBundle : PERPLEXITY_FALLBACK_LAST_MESSAGE_SELECTORS;
+    for (const sel of candidates) {
+      const nodes = Array.from(document.querySelectorAll(sel));
+      for (let i = nodes.length - 1; i >= 0; i--) {
+        const node = nodes[i];
+        if (!node) continue;
+        if (node.innerHTML && node.innerHTML.trim()) return node.innerHTML;
+        if (node.textContent && node.textContent.trim()) return node.textContent;
+      }
+    }
+  } catch (err) {
+    console.warn('[content-perplexity] grabLatestAssistantMarkup failed', err);
+  }
+  return '';
+}
+
+async function trySelectorFinderResponse(prompt, timeoutMs = 60000) {
+  const finder = window.SelectorFinder;
+  if (!finder?.waitForElement) return '';
+  try {
+    const res = await finder.waitForElement({
+      modelName: MODEL,
+      elementType: 'response',
+      timeout: timeoutMs,
+      prompt: prompt || ''
+    });
+    return (res?.text || '').trim();
+  } catch (err) {
+    console.warn('[content-perplexity] SelectorFinder response fallback failed', err);
+    return '';
+  }
+}
 
 window.setupHumanoidFetchMonitor?.(MODEL, ({ status, retryAfter }) => {
   if (status !== 429) return;
@@ -822,6 +880,7 @@
       inputField.dispatchEvent(evt);
     }
     activity.heartbeat(0.55, { phase: 'send-dispatched' });
+    try { chrome.runtime.sendMessage({ type: 'PROMPT_SUBMITTED', llmName: MODEL, ts: Date.now() }); } catch (_) {}
 
     console.log('[content-perplexity] Message sent, waiting for response...');
     activity.heartbeat(0.6, { phase: 'waiting-response' });
@@ -843,21 +902,33 @@
       return pipelineAnswer;
     }
 
-    const response = await withSmartScroll(() => waitForResponse(120000), {
-      keepAliveInterval: 2000,
-      operationTimeout: 300000,
-      debug: false
-    });
+    // Fallback: extract latest assistant text if pipeline missed it
+    try {
+      const latestMarkup = grabLatestAssistantMarkup();
+      const cleanedFallback = window.contentCleaner.cleanContent(latestMarkup || '', { maxLength: 50000 });
+      if (cleanedFallback) {
+        console.warn('[content-perplexity] Pipeline empty, using DOM fallback');
+        activity.stop({ status: 'success', answerLength: cleanedFallback.length, source: 'dom-fallback' });
+        return cleanedFallback;
+      }
+    } catch (fallbackErr) {
+      console.warn('[content-perplexity] DOM fallback failed', fallbackErr);
+    }
 
-    // Очистка ответа
-    const cleanedResponse = window.contentCleaner.cleanContent(response, {
-      maxLength: 50000
-    });
+    // Last resort: SelectorFinder observation-based extraction (can traverse shadow DOM).
+    try {
+      const finderText = await trySelectorFinderResponse(prompt, 60000);
+      const cleanedFinder = window.contentCleaner.cleanContent(finderText || '', { maxLength: 50000 });
+      if (cleanedFinder) {
+        console.warn('[content-perplexity] DOM fallback empty, using SelectorFinder response');
+        activity.stop({ status: 'success', answerLength: cleanedFinder.length, source: 'selector-finder' });
+        return cleanedFinder;
+      }
+    } catch (finderErr) {
+      console.warn('[content-perplexity] SelectorFinder fallback crashed', finderErr);
+    }
 
-    console.log(`[content-perplexity] Process completed. Response length: ${cleanedResponse.length}`);
-    activity.heartbeat(0.9, { phase: 'response-processed' });
-    activity.stop({ status: 'success', answerLength: cleanedResponse.length });
-    return cleanedResponse;
+    throw new Error('Pipeline did not return answer');
 
   } catch (error) {
     if (error?.code === 'background-force-stop') {
```

## 5) Claude: стабильнее извлечение ответа + фильтр model-label

**Описание (из Release Notes):** Claude: извлечение ответа стало стабильнее (ожидание элементов через SelectorFinder, защита от “ответов‑лейблов” вроде `Sonnet 4.5`).

**Строки/якоря (в текущей ветке):**
1260:  async function autoExtractResponse(prompt, composerEl) {
1278:function isLikelyClaudeModelLabel(text = '') {
1398:        if (response && isLikelyClaudeModelLabel(response)) {
1405:          if (domCandidate && !isLikelyClaudeModelLabel(domCandidate)) {
1413:            const auto = await autoExtractResponse(prompt, inputArea);
1414:            if (auto && !isLikelyClaudeModelLabel(auto)) {
1399:          console.warn('[content-claude] Pipeline returned model label, ignoring:', response);

**Diff (content-scripts/content-claude.js — ключевые hunks):**
```diff
--- a/content-scripts/content-claude.js
+++ b/content-scripts/content-claude.js
@@ -1226,41 +1257,59 @@
   }
 
 //-- 2.2.1. Вставить: autoExtractResponse для Claude (non-destructive) --//
-async function autoExtractResponse(prompt, composerEl) {
-  if (window.SelectorFinder) {
+  async function autoExtractResponse(prompt, composerEl) {
+    const finder = window.SelectorFinder;
+    if (!finder?.waitForElement) return '';
     try {
-      const res = await window.SelectorFinder.findOrDetectResponseSelector({
-        modelName: 'Claude', domain: location.hostname, prompt, composerEl, debug: false
+      const res = await finder.waitForElement({
+        modelName: MODEL,
+        elementType: 'response',
+        timeout: 120000,
+        prompt: String(prompt || ''),
+        referenceElement: composerEl || null
       });
-      if (res && res.selector) {
-        const el = document.querySelector(res.selector);
-        if (el && (el.innerText || el.textContent || '').trim()) return (el.innerText || el.textContent || '').trim();
-        for (const n of window.SelectorFinder._internals.deepElements(document)) {
-          try {
-            const sub = n.shadowRoot && n.shadowRoot.querySelector && n.shadowRoot.querySelector(res.selector);
-            if (sub && (sub.innerText || sub.textContent || '').trim()) return (sub.innerText || sub.textContent || '').trim();
-          } catch (e) {}
-        }
-      }
-    } catch (e) {
-      console.warn('[content-claude] SelectorFinder error', e);
+      return String(res?.text || '').trim();
+    } catch (err) {
+      console.warn('[content-claude] SelectorFinder response extraction failed', err);
+      return '';
     }
-  }
-  return await autoExtractResponse(prompt, composer);
 }
 
+function isLikelyClaudeModelLabel(text = '') {
+  const s = String(text || '').trim();
+  if (!s) return false;
+  if (s.length > 40) return false;
+  return /^(?:claude\\s*)?(?:opus|sonnet|haiku)(?:\\s+\\d+(?:\\.\\d+)?)?$/i.test(s);
+}
 
+
+  let claudeSharedInjection = null;
+  let claudeSharedFingerprint = null;
+  let claudeSharedStartedAt = 0;
+  const fingerprintPrompt = (prompt = '') => {
+    const s = String(prompt || '');
+    return `${s.length}:${quickHash(s.slice(0, 600))}`;
+  };
+
   // ==================== Main Injection Logic (PRESERVED Claude-specific flow) ====================
 
 
 
   async function injectAndGetResponse(prompt, attachments = []) {
-    return runLifecycle('claude:inject', buildLifecycleContext(prompt, { evaluator: isEvaluatorMode }), async (activity) => {
+    const fp = fingerprintPrompt(prompt);
+    if (claudeSharedInjection && fp === claudeSharedFingerprint && Date.now() - claudeSharedStartedAt < 15000) {
+      console.warn('[content-claude] Reusing in-flight injection promise');
+      return claudeSharedInjection;
+    }
+    claudeSharedFingerprint = fp;
+    claudeSharedStartedAt = Date.now();
+
+    const opPromise = runLifecycle('claude:inject', buildLifecycleContext(prompt, { evaluator: isEvaluatorMode }), async (activity) => {
       const opId = metricsCollector.startOperation('injectAndGetResponse');
       const startTime = Date.now();
       try {
         console.log('[content-claude] Starting Claude injection process');
-        await sleep(3000);
+        await sleep(250);
         
         const inputSelectors = uiDetector.getComposerSelectors();
         const sendButtonSelectors = uiDetector.getSendButtonSelectors();
@@ -1271,72 +1320,114 @@
         
         try { await attachFilesToComposer(inputArea, attachments); } catch (err) { console.warn('[content-claude] attach failed', err); }
 
-        // Main world text setter first
-        try {
-          ensureMainWorldBridge();
-          window.dispatchEvent(new CustomEvent('EXT_SET_TEXT', {
-            detail: {
-              text: prompt,
-              selectors: [
-                'textarea',
-                '[contenteditable=\"true\"]',
-                '[role=\"textbox\"]',
-                inputArea ? null : ''
-              ].filter(Boolean)
-            }
-          }));
-          await sleep(200);
-          const head = prompt.slice(0, Math.min(20, prompt.length));
-          if ((inputArea?.value || inputArea?.textContent || '').includes(head)) {
-            console.log('[content-claude] Main-world text setter succeeded');
-          }
-        } catch (err) {
-          console.warn('[content-claude] main-world text setter failed', err);
-        }
-        
-        const typingSuccess = await typeWithHumanPauses(inputArea, prompt);
+        const head = String(prompt || '').slice(0, Math.min(24, String(prompt || '').length));
+        const existing = String(inputArea?.value || inputArea?.textContent || '');
+        const typingSuccess = existing.includes(head) ? true : await typeWithHumanPauses(inputArea, prompt);
         activity.heartbeat(0.35, { phase: 'typing' });
         if (!typingSuccess) throw new Error('Text input failed');
 
-        await sleep(600);
-        
         console.log('[content-claude] Looking for send button...');
         activity.heartbeat(0.4, { phase: 'send-button-search' });
         const sendButton = await findAndCacheElement('sendButton', sendButtonSelectors);
         
         if (sendButton.disabled || sendButton.getAttribute('aria-disabled') === 'true') {
           const enableStart = Date.now();
-          while (Date.now() - enableStart < 8000) {
+          while (Date.now() - enableStart < 5000) {
             if (!sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true') break;
-            await sleep(150);
+            await sleep(50);
           }
         }
 
         const humanoid = window.Humanoid;
         console.log('[content-claude] Clicking send button');
-        if (humanoid && typeof humanoid.click === 'function') {
-          await humanoid.click(sendButton);
+        const form = sendButton.closest('form');
+        if (form && typeof form.requestSubmit === 'function') {
+          form.requestSubmit(sendButton);
+        } else if (humanoid && typeof humanoid.click === 'function') {
+          try {
+            await humanoid.click(sendButton);
+          } catch (e) {
+            console.warn('[content-claude] Humanoid click failed, trying native click', e);
+            sendButton.click();
+          }
         } else {
-          sendButton.focus({ preventScroll: true });
+          try { sendButton.focus({ preventScroll: true }); } catch (_) { sendButton.focus?.(); }
           sendButton.click();
         }
         activity.heartbeat(0.5, { phase: 'send-dispatched' });
+        try { chrome.runtime.sendMessage({ type: 'PROMPT_SUBMITTED', llmName: MODEL, ts: Date.now() }); } catch (_) {}
 
-        if ((inputArea.textContent || '').trim().length && document.contains(inputArea)) {
-          console.log('[content-claude] Composer still populated after click, sending Enter key as fallback');
-          inputArea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
-          inputArea.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
+        const confirmClaudeSend = async () => {
+          const beforeTurns = document.querySelectorAll('[data-testid="conversation-turn"], [data-testid*="conversation"]').length;
+          const deadline = Date.now() + 1600;
+          while (Date.now() < deadline) {
+            const typing = document.querySelector('[data-testid="chat-spinner"], [data-testid="typing"], .typing-indicator, .animate-pulse, [class*="streaming"], [data-testid="generation"]');
+            if (typing) return true;
+            const afterTurns = document.querySelectorAll('[data-testid="conversation-turn"], [data-testid*="conversation"]').length;
+            if (afterTurns > beforeTurns) return true;
+            if (sendButton?.disabled || sendButton?.getAttribute?.('aria-disabled') === 'true') return true;
+            await sleep(120);
+          }
+          return false;
+        };
+
+        const sentConfirmed = await confirmClaudeSend();
+        if (!sentConfirmed && document.contains(inputArea)) {
+          const stillText = String(inputArea.value || inputArea.textContent || '').trim();
+          if (stillText.length) {
+            console.log('[content-claude] Send not confirmed, using Enter fallback');
+            inputArea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
+            inputArea.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
+          }
         }
         
         console.log('[content-claude] Message sent, waiting for response...');
         activity.heartbeat(0.6, { phase: 'waiting-response' });
+
+        let response = '';
+        let pipelineAnswer = null;
+        await tryClaudePipeline(prompt, {
+          heartbeat: (meta = {}) => activity.heartbeat(0.8, Object.assign({ phase: 'pipeline' }, meta)),
+          stop: async ({ answer }) => {
+            pipelineAnswer = answer || '';
+            activity.stop({ status: 'success', answerLength: pipelineAnswer.length, source: 'pipeline' });
+          }
+        });
+
+        response = String(pipelineAnswer || '').trim();
+        if (response && isLikelyClaudeModelLabel(response)) {
+          console.warn('[content-claude] Pipeline returned model label, ignoring:', response);
+          response = '';
+        }
+
+        if (!response) {
+          const domCandidate = extractClaudeResponseFromDOM(prompt);
+          if (domCandidate && !isLikelyClaudeModelLabel(domCandidate)) {
+            console.warn('[content-claude] Pipeline empty, using DOM fallback');
+            response = domCandidate;
+          }
+        }
+
+        if (!response) {
+          try {
+            const auto = await autoExtractResponse(prompt, inputArea);
+            if (auto && !isLikelyClaudeModelLabel(auto)) {
+              console.warn('[content-claude] DOM fallback empty, using SelectorFinder response selector');
+              response = auto;
+            }
+          } catch (autoErr) {
+            console.warn('[content-claude] SelectorFinder response fallback failed', autoErr);
+          }
+        }
+
+        if (!response) {
+          throw new Error('Pipeline did not return answer');
+        }
         
-        const response = await withSmartScroll(
-          async () => await waitForClaudeResponse(120000, prompt),
-          { keepAliveInterval: 2000, operationTimeout: 300000, debug: false }
-        );
-        
         const cleanedResponse = contentCleaner.clean(response, { maxLength: 50000 });
+        if (!String(cleanedResponse || '').trim()) {
+          throw new Error('Empty answer after cleaning');
+        }
         
         metricsCollector.recordTiming('total_response_time', Date.now() - startTime);
         metricsCollector.endOperation(opId, true, { 
@@ -1359,6 +1450,13 @@
         throw error;
       }
     });
+    claudeSharedInjection = opPromise;
+    opPromise.finally(() => {
+      if (claudeSharedInjection === opPromise) {
+        claudeSharedInjection = null;
+      }
+    });
+    return opPromise;
   }
 
   // ==================== Basic Heartbeat (disabled: event-driven anti-sleep only) ====================
```

## 6) Results UI/IPC: normalizedAnswer, ACK, CSP‑safe scripts

**Описание (из Release Notes):** Results UI/IPC: в results уходит `normalizedAnswer`, добавлен ACK на входящие сообщения (фон не теряет `resultsTabId`), убраны CSP/JS ошибки в `result_new.html`/`results.js`.

### 6.1 Results: ACK на входящие сообщения + безопасный старт

**Строки/якоря (в текущей ветке):**
2:if (window.__RESULTS_PAGE_LOADED) {
5:    window.__RESULTS_PAGE_LOADED = true;
8:    const shared = window.ResultsShared || {};
4777:} // end guard __RESULTS_PAGE_LOADED
2923:    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
3024:            try { sendResponse?.({ ok: true }); } catch (_) {}
3027:            try { sendResponse?.({ ok: false, error: err?.message || String(err) }); } catch (_) {}
3702:        const sendToBackground = (payload) => new Promise((resolve, reject) => {
3738:                response = await sendToBackground({
3748:                response = await sendToBackground({

**Diff (results.js — ключевые hunks):**
```diff
--- a/results.js
+++ b/results.js
@@ -1,4 +1,20 @@
+// Prevent double-init when the page is opened or injected twice
+if (window.__RESULTS_PAGE_LOADED) {
+    console.warn('[RESULTS] Initialization skipped: already loaded');
+} else {
+    window.__RESULTS_PAGE_LOADED = true;
+
 document.addEventListener('DOMContentLoaded', async () => {
+    const shared = window.ResultsShared || {};
+    const {
+        escapeHtml = (s = '') => String(s),
+        stripHtmlToPlainText = (html = '') => String(html),
+        buildResponseCopyHtmlBlock = () => '',
+        wrapResponsesHtmlBundle = (sections = '') => sections,
+        fallbackCopyViaTextarea = () => {},
+        flashButtonFeedback = () => {},
+        writeRichContentToClipboard = async () => {}
+    } = shared;
     //-- 2.1. Логика для переключения и сохранения состояния Pro-режима --//
     const proLink = document.getElementById('pro-header');
     const proModeStorageKey = 'llmComparatorProModeActive';
@@ -2904,104 +2921,110 @@
     // Listen for messages from the background script
     // Listen for messages from the background script
     chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
-        switch (message.type) {
-            case 'LLM_JOB_CREATED':
-                mergeLLMMetadata(message.llmName, {
-                    requestId: message.requestId || null,
-                    url: message.metadata?.url || '',
-                    createdAt: message.metadata?.createdAt || message.metadata?.timestamp || Date.now(),
-                    completedAt: message.metadata?.completedAt || null
-                }, { reset: true });
-                break;
-            case 'LLM_PARTIAL_RESPONSE':
-                if (autoMode) {
-                    updateLLMPanelOutput(message.llmName, message.answer);
-                } else {
-                    storeResponseForManualMode(message.llmName, message.answer);
-                }
-                if (message.metadata || message.requestId) {
+        try {
+            switch (message.type) {
+                case 'LLM_JOB_CREATED':
                     mergeLLMMetadata(message.llmName, {
-                        requestId: message.requestId,
-                        url: message.metadata?.url,
-                        createdAt: message.metadata?.createdAt || message.metadata?.timestamp,
-                        completedAt: message.metadata?.completedAt
-                    });
-                }
-                if (Array.isArray(message.logs)) {
-                    ingestLogs(message.llmName, message.logs);
-                }
-                if (typeof message.answer === 'string' && message.answer.trim().startsWith('Error:')) {
-                    const errorDetails = message.answer.replace(/^Error:\s*/i, '').trim() || 'Ошибка повторной отправки';
-                    settleManualResend(message.llmName, 'error', errorDetails);
-                } else {
-                    settleManualResend(message.llmName, 'success', 'Ответ обновлен');
-                }
-                break;
-            // --- V2.0 START: Status Update Handler ---
-            case 'STATUS_UPDATE':
-                updateModelStatusUI(message.llmName, message.status, message.data || {});
-                if (Array.isArray(message.logs)) {
-                    ingestLogs(message.llmName, message.logs);
-                }
-                if (['ERROR', 'UNRESPONSIVE', 'CIRCUIT_OPEN'].includes(message.status)) {
-                    settleManualResend(message.llmName, 'error', (message.data && message.data.message) || 'Ошибка повторной отправки');
-                }
-                break;
-            // --- V2.0 END: Status Update Handler ---
-            case 'PROCESS_COMPLETE':
-                if (comparisonSpinner) comparisonSpinner.style.display = 'none';
-                const cleanedAnswer = sanitizeFinalAnswer(message.finalAnswer || '');
-                pendingJudgeAnswer = cleanedAnswer;
-                pendingJudgeHTML = cleanedAnswer
-                    ? convertMarkdownToHTML(cleanedAnswer)
-                    : '<p class="comparison-placeholder">No evaluation response received.</p>';
-                if (comparisonOutput) {
-                    comparisonOutput.innerHTML = pendingJudgeHTML;
-                }
-                lastEvaluationPromptNormalized = '';
-                lastEvaluationPrefixNormalized = '';
-                lastEvaluationSuffixNormalized = '';
-                lastResponsesListNormalized = '';
-                break;
-            case 'STARTING_EVALUATION':
-                if (comparisonSpinner) comparisonSpinner.style.display = 'block';
-                if (comparisonOutput) {
-                    comparisonOutput.innerHTML = '<p class="comparison-placeholder">Collecting responses for evaluation...</p>';
-                }
-                break;
-            case 'UPDATE_LLM_PANEL_OUTPUT':
-                updateLLMPanelOutput(message.llmName, message.answer);
-                break;
-            case 'LLM_DIAGNOSTIC_EVENT':
-                if (Array.isArray(message.logs) && message.logs.length) {
-                    ingestLogs(message.llmName, message.logs);
-                } else if (message.event) {
-                    ingestLogs(message.llmName, [message.event]);
-                }
-                break;
-            case 'MANUAL_PING_RESULT':
-                if (message.status === 'success') {
-                    setPingButtonState(message.llmName, 'success', 'Ответ обновлен');
-                } else if (message.status === 'failed') {
-                    setPingButtonState(message.llmName, 'error', message.error || 'Ошибка пинга');
-                } else if (message.status === 'unchanged') {
-                    setPingButtonState(message.llmName, 'unchanged', 'Ответ не изменился');
-                }
-                break;
-            case 'SELECTOR_OVERRIDE_CLEARED':
-                if (message.success === false) {
-                    updateDevToolsStatus(`Clear failed: ${message.error || 'unknown error'}`, 'error');
-                } else {
-                    updateDevToolsStatus('Overrides & caches cleared', 'success');
-                }
-                break;
-            case 'SELECTOR_OVERRIDE_REFRESH_RESULT':
-                if (message.result?.success) {
-                    updateDevToolsStatus('Remote selectors refreshed', 'success');
-                } else {
-                    updateDevToolsStatus(`Refresh failed: ${message.result?.error || 'unknown error'}`, 'error');
-                }
-                break;
+                        requestId: message.requestId || null,
+                        url: message.metadata?.url || '',
+                        createdAt: message.metadata?.createdAt || message.metadata?.timestamp || Date.now(),
+                        completedAt: message.metadata?.completedAt || null
+                    }, { reset: true });
+                    break;
+                case 'LLM_PARTIAL_RESPONSE':
+                    if (autoMode) {
+                        updateLLMPanelOutput(message.llmName, message.answer);
+                    } else {
+                        storeResponseForManualMode(message.llmName, message.answer);
+                    }
+                    if (message.metadata || message.requestId) {
+                        mergeLLMMetadata(message.llmName, {
+                            requestId: message.requestId,
+                            url: message.metadata?.url,
+                            createdAt: message.metadata?.createdAt || message.metadata?.timestamp,
+                            completedAt: message.metadata?.completedAt
+                        });
+                    }
+                    if (Array.isArray(message.logs)) {
+                        ingestLogs(message.llmName, message.logs);
+                    }
+                    if (typeof message.answer === 'string' && message.answer.trim().startsWith('Error:')) {
+                        const errorDetails = message.answer.replace(/^Error:\s*/i, '').trim() || 'Ошибка повторной отправки';
+                        settleManualResend(message.llmName, 'error', errorDetails);
+                    } else {
+                        settleManualResend(message.llmName, 'success', 'Ответ обновлен');
+                    }
+                    break;
+                // --- V2.0 START: Status Update Handler ---
+                case 'STATUS_UPDATE':
+                    updateModelStatusUI(message.llmName, message.status, message.data || {});
+                    if (Array.isArray(message.logs)) {
+                        ingestLogs(message.llmName, message.logs);
+                    }
+                    if (['ERROR', 'UNRESPONSIVE', 'CIRCUIT_OPEN'].includes(message.status)) {
+                        settleManualResend(message.llmName, 'error', (message.data && message.data.message) || 'Ошибка повторной отправки');
+                    }
+                    break;
+                // --- V2.0 END: Status Update Handler ---
+                case 'PROCESS_COMPLETE':
+                    if (comparisonSpinner) comparisonSpinner.style.display = 'none';
+                    const cleanedAnswer = sanitizeFinalAnswer(message.finalAnswer || '');
+                    pendingJudgeAnswer = cleanedAnswer;
+                    pendingJudgeHTML = cleanedAnswer
+                        ? convertMarkdownToHTML(cleanedAnswer)
+                        : '<p class="comparison-placeholder">No evaluation response received.</p>';
+                    if (comparisonOutput) {
+                        comparisonOutput.innerHTML = pendingJudgeHTML;
+                    }
+                    lastEvaluationPromptNormalized = '';
+                    lastEvaluationPrefixNormalized = '';
+                    lastEvaluationSuffixNormalized = '';
+                    lastResponsesListNormalized = '';
+                    break;
+                case 'STARTING_EVALUATION':
+                    if (comparisonSpinner) comparisonSpinner.style.display = 'block';
+                    if (comparisonOutput) {
+                        comparisonOutput.innerHTML = '<p class="comparison-placeholder">Collecting responses for evaluation...</p>';
+                    }
+                    break;
+                case 'UPDATE_LLM_PANEL_OUTPUT':
+                    updateLLMPanelOutput(message.llmName, message.answer);
+                    break;
+                case 'LLM_DIAGNOSTIC_EVENT':
+                    if (Array.isArray(message.logs) && message.logs.length) {
+                        ingestLogs(message.llmName, message.logs);
+                    } else if (message.event) {
+                        ingestLogs(message.llmName, [message.event]);
+                    }
+                    break;
+                case 'MANUAL_PING_RESULT':
+                    if (message.status === 'success') {
+                        setPingButtonState(message.llmName, 'success', 'Ответ обновлен');
+                    } else if (message.status === 'failed') {
+                        setPingButtonState(message.llmName, 'error', message.error || 'Ошибка пинга');
+                    } else if (message.status === 'unchanged') {
+                        setPingButtonState(message.llmName, 'unchanged', 'Ответ не изменился');
+                    }
+                    break;
+                case 'SELECTOR_OVERRIDE_CLEARED':
+                    if (message.success === false) {
+                        updateDevToolsStatus(`Clear failed: ${message.error || 'unknown error'}`, 'error');
+                    } else {
+                        updateDevToolsStatus('Overrides & caches cleared', 'success');
+                    }
+                    break;
+                case 'SELECTOR_OVERRIDE_REFRESH_RESULT':
+                    if (message.result?.success) {
+                        updateDevToolsStatus('Remote selectors refreshed', 'success');
+                    } else {
+                        updateDevToolsStatus(`Refresh failed: ${message.result?.error || 'unknown error'}`, 'error');
+                    }
+                    break;
+            }
+            try { sendResponse?.({ ok: true }); } catch (_) {}
+        } catch (err) {
+            console.error('[RESULTS] onMessage handler failed:', err);
+            try { sendResponse?.({ ok: false, error: err?.message || String(err) }); } catch (_) {}
         }
     });
         
@@ -3757,54 +3697,79 @@
     startButton.addEventListener('click', async () => {
         if (getItButton) {
             getItButton.disabled = true;
-        }
-        let finalPrompt = promptInput.value;
-        if (!finalPrompt) {
-            alert('Please enter a prompt.');
-            return;
         }
-        
-        finalPrompt = applySelectedModifiersToPrompt(finalPrompt);
-        const selectedLLMs = getSelectedLLMs();
-        if (selectedLLMs.length === 0) {
-            showNotification('Please select at least one LLM.');
-            return;
-        }
-        const forceNewTabs = newPagesCheckbox ? newPagesCheckbox.checked : true;
-        const useApiFallback = apiModeCheckbox ? apiModeCheckbox.checked : true;
-        const attachmentsPayload = await buildAttachmentPayload();
-        if (attachmentsPayload.length) {
-            const unsupported = selectedLLMs.filter((name) => ATTACH_CAPABILITY[name] === false);
-            if (unsupported.length) {
-                showNotification(`Эти LLM могут не поддерживать вложения: ${unsupported.join(', ')}`, 'warn');
-            }
-        }
-        try {
-            chrome.runtime.sendMessage({
-                type: 'START_FULLPAGE_PROCESS',
-                prompt: finalPrompt,
-                selectedLLMs: selectedLLMs,
-                forceNewTabs,
-                useApiFallback,
-                attachments: attachmentsPayload
+
+        const sendToBackground = (payload) => new Promise((resolve, reject) => {
+            chrome.runtime.sendMessage(payload, (response) => {
+                if (chrome.runtime.lastError) {
+                    reject(new Error(chrome.runtime.lastError.message));
+                    return;
+                }
+                resolve(response);
             });
+        });
+
+        try {
+            let finalPrompt = promptInput.value;
+            if (!finalPrompt) {
+                alert('Please enter a prompt.');
+                return;
+            }
+
+            finalPrompt = applySelectedModifiersToPrompt(finalPrompt);
+            const selectedLLMs = getSelectedLLMs();
+            if (selectedLLMs.length === 0) {
+                showNotification('Please select at least one LLM.');
+                return;
+            }
+
+            const forceNewTabs = newPagesCheckbox ? newPagesCheckbox.checked : true;
+            const useApiFallback = apiModeCheckbox ? apiModeCheckbox.checked : true;
+            const attachmentsPayload = await buildAttachmentPayload();
+            if (attachmentsPayload.length) {
+                const unsupported = selectedLLMs.filter((name) => ATTACH_CAPABILITY[name] === false);
+                if (unsupported.length) {
+                    showNotification(`Эти LLM могут не поддерживать вложения: ${unsupported.join(', ')}`, 'warn');
+                }
+            }
+
+            let response = null;
+            try {
+                response = await sendToBackground({
+                    type: 'START_FULLPAGE_PROCESS',
+                    prompt: finalPrompt,
+                    selectedLLMs: selectedLLMs,
+                    forceNewTabs,
+                    useApiFallback,
+                    attachments: attachmentsPayload
+                });
+            } catch (err) {
+                console.warn('[RESULTS] Failed to start with attachments, retrying without them', err);
+                response = await sendToBackground({
+                    type: 'START_FULLPAGE_PROCESS',
+                    prompt: finalPrompt,
+                    selectedLLMs: selectedLLMs,
+                    forceNewTabs,
+                    useApiFallback
+                });
+            }
+
+            if (!response || response.status !== 'process_started') {
+                showNotification(`Запуск процесса: неожиданный ответ background (${response?.status || 'no_response'})`, 'warn');
+            }
+
+            if (forceNewTabs && newPagesCheckbox) {
+                newPagesCheckbox.checked = false;
+                storeNewPagesState(false);
+            }
         } catch (err) {
-            console.warn('[RESULTS] Failed to send attachments, retrying without them', err);
-            chrome.runtime.sendMessage({
-                type: 'START_FULLPAGE_PROCESS',
-                prompt: finalPrompt,
-                selectedLLMs: selectedLLMs,
-                forceNewTabs,
-                useApiFallback
-            });
-        }
-        if (forceNewTabs && newPagesCheckbox) {
-            newPagesCheckbox.checked = false;
-            storeNewPagesState(false);
+            console.error('[RESULTS] Failed to start process', err);
+            showNotification(`Не удалось отправить запрос: ${err?.message || String(err)}`, 'error');
+        } finally {
+            if (getItButton) {
+                getItButton.disabled = false;
+            }
         }
-        if (getItButton) {
-            getItButton.disabled = false;
-        }
     });
     
 if (getItButton) {
```

### 6.2 Results shared/devtools (новые файлы)

**Diff (добавить файлы):**
```diff
--- a/results-shared.js
+++ b/results-shared.js
@@ -0,0 +1,95 @@
+(function initResultsShared(globalObject) {
+  if (globalObject.ResultsShared) return;
+
+  const escapeHtml = (str = '') => str
+    .replace(/&/g, '&amp;')
+    .replace(/</g, '&lt;')
+    .replace(/>/g, '&gt;')
+    .replace(/"/g, '&quot;')
+    .replace(/'/g, '&#39;');
+
+  const stripHtmlToPlainText = (html = '') => {
+    if (!html) return '';
+    const temp = globalObject.document?.createElement?.('div');
+    if (!temp) return String(html);
+    temp.innerHTML = html;
+    return (temp.textContent || temp.innerText || '').trim();
+  };
+
+  const buildResponseCopyHtmlBlock = (name, metadataLine, htmlBody, fallbackText) => {
+    const safeBody = (htmlBody && htmlBody.trim())
+      ? htmlBody
+      : (fallbackText ? `<p>${escapeHtml(fallbackText).replace(/\n/g, '<br>')}</p>` : '');
+    if (!safeBody) return '';
+    const safeName = escapeHtml(name || 'Response');
+    const metaHtml = metadataLine ? `<div class="copied-meta">${escapeHtml(metadataLine)}</div>` : '';
+    return `<section class="copied-response"><h2>${safeName}</h2>${metaHtml}<div class="copied-body">${safeBody}</div></section>`;
+  };
+
+  const wrapResponsesHtmlBundle = (sectionsHtml = '') => {
+    const trimmed = sectionsHtml.trim();
+    if (!trimmed) return '';
+    return `<article class="llm-copied-responses">${trimmed}</article>`;
+  };
+
+  const fallbackCopyViaTextarea = (text = '') => {
+    const doc = globalObject.document;
+    if (!doc) return;
+    const textarea = doc.createElement('textarea');
+    textarea.value = text;
+    textarea.setAttribute('readonly', '');
+    textarea.style.position = 'absolute';
+    textarea.style.left = '-9999px';
+    doc.body.appendChild(textarea);
+    textarea.select();
+    doc.execCommand('copy');
+    doc.body.removeChild(textarea);
+  };
+
+  const flashButtonFeedback = (btn, type = 'success', duration = 420) => {
+    if (!btn) return;
+    const classMap = {
+        success: 'btn-flash-success',
+        error: 'btn-flash-error',
+        warn: 'btn-flash-warn'
+    };
+    const targetClass = classMap[type] || classMap.success;
+    btn.classList.remove('btn-flash-success', 'btn-flash-error', 'btn-flash-warn');
+    // force reflow to restart animation
+    void btn.offsetWidth;
+    btn.classList.add(targetClass);
+    setTimeout(() => btn.classList.remove(targetClass), duration);
+  };
+
+  const writeRichContentToClipboard = async ({ text = '', html = '' } = {}) => {
+    const plainText = text.trim();
+    const htmlPayload = html.trim();
+    const fallbackText = plainText || (htmlPayload ? stripHtmlToPlainText(htmlPayload) : '');
+
+    if (htmlPayload && globalObject.navigator?.clipboard?.write && typeof ClipboardItem !== 'undefined') {
+      const clipboardItem = new ClipboardItem({
+        'text/html': new Blob([htmlPayload], { type: 'text/html' }),
+        'text/plain': new Blob([(fallbackText || '')], { type: 'text/plain' })
+      });
+      await globalObject.navigator.clipboard.write([clipboardItem]);
+      return;
+    }
+
+    if (fallbackText && globalObject.navigator?.clipboard?.writeText) {
+      await globalObject.navigator.clipboard.writeText(fallbackText);
+      return;
+    }
+
+    fallbackCopyViaTextarea(fallbackText);
+  };
+
+  globalObject.ResultsShared = {
+    escapeHtml,
+    stripHtmlToPlainText,
+    buildResponseCopyHtmlBlock,
+    wrapResponsesHtmlBundle,
+    fallbackCopyViaTextarea,
+    flashButtonFeedback,
+    writeRichContentToClipboard
+  };
+})(typeof window !== 'undefined' ? window : self);
--- a/results-devtools.js
+++ b/results-devtools.js
@@ -0,0 +1,277 @@
+// DevTools: States / Commands / Diagnostics (Embedded Pragmatist)
+(function attachPragmatistDevtools() {
+    const statesRefreshBtn = document.getElementById('states-refresh-btn');
+    const statesList = document.getElementById('states-list');
+    const speedModeToggle = document.getElementById('speed-mode-toggle');
+    const smokeCheckBtn = document.getElementById('smoke-check-btn');
+    const smokeCheckStatus = document.getElementById('smoke-check-status');
+    const cmdPrompt = document.getElementById('cmd-prompt');
+    const cmdPlatformSelect = document.getElementById('cmd-platform-select');
+    const cmdSubmitBtn = document.getElementById('cmd-submit-btn');
+    const cmdStopAllBtn = document.getElementById('cmd-stopall-btn');
+    const cmdCollectBtn = document.getElementById('cmd-collect-btn');
+    const cmdCollectStatus = document.getElementById('cmd-collect-status');
+    const cmdStatusBox = document.getElementById('cmd-status-box');
+    const cmdStatusRefreshBtn = document.getElementById('cmd-status-refresh-btn');
+    const monkeySnippetEl = document.getElementById('monkey-patch-snippet');
+    const copyMonkeyBtn = document.getElementById('copy-monkey-btn');
+    const diagRefreshBtn = document.getElementById('diag-refresh-btn');
+    const diagCopyBtn = document.getElementById('diag-copy-btn');
+    const diagDownloadBtn = document.getElementById('diag-download-btn');
+    const diagClearBtn = document.getElementById('diag-clear-btn');
+    const diagEventsEl = document.getElementById('diag-events');
+    const diagFilterInput = document.getElementById('diag-filter-input');
+    const escapeHtml = (window.ResultsShared && window.ResultsShared.escapeHtml) || ((s = '') => String(s));
+    let diagCache = [];
+    let speedModeEnabled = false;
+
+    const monkeySnippet = "(function() {\n  const oTo = window.scrollTo, oBy = window.scrollBy;\n  function log(method, args) {\n    const state = window.humanSessionController?.getState?.() || window.__HumanoidSessionState?.state;\n    if (state === 'HARD_STOP') {\n      console.error('🚨 ILLEGAL SCROLL via ' + method + ' after HARD_STOP!', new Error().stack);\n    }\n  }\n  window.scrollTo = (...a) => { log('scrollTo', a); return oTo.apply(window, a); };\n  window.scrollBy = (...a) => { log('scrollBy', a); return oBy.apply(window, a); };\n})();";
+
+    if (monkeySnippetEl) {
+        monkeySnippetEl.textContent = monkeySnippet;
+    }
+    if (copyMonkeyBtn) {
+        copyMonkeyBtn.addEventListener('click', async () => {
+            try { await navigator.clipboard.writeText(monkeySnippet); } catch (err) { console.warn('[devtools] copy monkey patch failed', err); }
+        });
+    }
+
+    const renderStates = (states = []) => {
+        if (!statesList) return;
+        const platformFilter = (cmdPlatformSelect?.value || 'all').toLowerCase();
+        if (!states.length) {
+            statesList.innerHTML = '<p class="diag-empty">No states</p>';
+            return;
+        }
+        const options = new Set(['all']);
+        const filteredStates = states.filter((s) => {
+            const p = (s?.platform || 'unknown').toLowerCase();
+            if (platformFilter === 'all') return true;
+            return p === platformFilter;
+        });
+        statesList.innerHTML = filteredStates.map((s) => {
+            const ts = s?.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : '';
+            const status = s?.status || 'unknown';
+            const platform = (s?.platform || 'unknown').toLowerCase();
+            options.add(platform);
+            return `<article class="devtools-card"><div class="devtools-card-header"><h2>${platform}</h2><span class="status-pill status-${status}">${status}</span></div><div class="devtools-card-body"><div>${s.preview || ''}</div><div class="devtools-meta">len: ${s.textLength || 0} • ${ts}</div></div></article>`;
+        }).join('');
+        if (cmdPlatformSelect) {
+            const current = cmdPlatformSelect.value;
+            const built = Array.from(options).sort();
+            cmdPlatformSelect.innerHTML = built.map((p) => `<option value="${p}">${p === 'all' ? 'All platforms' : p}</option>`).join('');
+            if (built.includes(current)) cmdPlatformSelect.value = current;
+        }
+    };
+
+    const loadStates = () => {
+        try {
+            chrome.runtime.sendMessage({ type: 'GET_ALL_STATES' }, (resp) => {
+                if (resp?.success) {
+                    renderStates(resp.states || []);
+                } else if (statesList) {
+                    statesList.innerHTML = '<p class="diag-empty">States unavailable</p>';
+                }
+            });
+        } catch (err) {
+            console.warn('[devtools] loadStates error', err);
+            if (statesList) statesList.innerHTML = '<p class="diag-empty">States load error</p>';
+        }
+    };
+    statesRefreshBtn && statesRefreshBtn.addEventListener('click', loadStates);
+    const syncSpeedModeUI = (enabled) => {
+        speedModeEnabled = !!enabled;
+        if (speedModeToggle) {
+            speedModeToggle.setAttribute('aria-pressed', String(speedModeEnabled));
+            speedModeToggle.classList.toggle('is-active', speedModeEnabled);
+        }
+    };
+
+    const loadSettings = () => {
+        try {
+            chrome.storage?.local?.get?.(['settings'], (res) => {
+                const enabled = !!res?.settings?.speedMode;
+                syncSpeedModeUI(enabled);
+            });
+        } catch (_) {}
+    };
+
+    speedModeToggle && speedModeToggle.addEventListener('click', () => {
+        const next = !speedModeEnabled;
+        try {
+            chrome.runtime.sendMessage({ type: 'SET_SETTINGS', settings: { speedMode: next } }, (resp) => {
+                if (resp?.success) syncSpeedModeUI(next);
+            });
+        } catch (_) {}
+    });
+    if (statesList) {
+        loadStates();
+    }
+
+    cmdSubmitBtn && cmdSubmitBtn.addEventListener('click', () => {
+        const prompt = cmdPrompt?.value?.trim();
+        if (!prompt) return;
+        const platformValue = cmdPlatformSelect?.value || 'all';
+        const platforms = platformValue === 'all' ? undefined : [platformValue];
+        chrome.runtime.sendMessage({ type: 'SUBMIT_PROMPT', prompt, platforms }, (resp) => {
+            if (cmdCollectStatus) cmdCollectStatus.textContent = resp?.success ? 'Prompt sent' : 'Send failed';
+        });
+    });
+    cmdStopAllBtn && cmdStopAllBtn.addEventListener('click', () => {
+        const platformValue = cmdPlatformSelect?.value || 'all';
+        const platforms = platformValue === 'all' ? undefined : [platformValue];
+        chrome.runtime.sendMessage({ type: 'STOP_ALL', platforms }, (resp) => {
+            if (cmdCollectStatus) cmdCollectStatus.textContent = resp?.success ? 'Stopped' : 'Stop failed';
+        });
+    });
+    cmdCollectBtn && cmdCollectBtn.addEventListener('click', () => {
+        cmdCollectStatus && (cmdCollectStatus.textContent = 'Collecting...');
+        chrome.runtime.sendMessage({ type: 'COLLECT_RESPONSES' }, (resp) => {
+            if (cmdCollectStatus) cmdCollectStatus.textContent = resp?.success ? `Collected ${resp.responses?.length || 0}` : 'Collect failed';
+            loadCommandStatus();
+        });
+    });
+    const renderCommandStatus = (payload = {}) => {
+        if (!cmdStatusBox) return;
+        const pending = payload.pending;
+        const acks = Array.isArray(payload.acks) ? payload.acks : [];
+        const parts = [];
+        if (pending) {
+            parts.push(`<div class="diag-row"><strong>Pending</strong>: ${pending.action || ''} #${pending.id || ''}</div>`);
+        } else {
+            parts.push('<div class="diag-row">Pending: none</div>');
+        }
+        if (acks.length) {
+            parts.push('<div class="diag-row"><strong>Recent ACKs</strong></div>');
+            acks.forEach((ack) => {
+                const ts = ack.executedAt ? new Date(ack.executedAt).toLocaleTimeString() : '';
+                parts.push(`<div class="diag-row small">${ack.status || ''} ${ack.commandId || ''} • ${ts}</div>`);
+            });
+        } else {
+            parts.push('<div class="diag-row">No ACKs</div>');
+        }
+        cmdStatusBox.innerHTML = parts.join('');
+    };
+    const loadCommandStatus = () => {
+        const platformValue = cmdPlatformSelect?.value || 'all';
+        const platforms = platformValue === 'all' ? undefined : [platformValue];
+        chrome.runtime.sendMessage({ type: 'GET_COMMAND_STATUS', platforms }, (resp) => {
+            if (resp?.success) {
+                renderCommandStatus(resp);
+            } else if (cmdStatusBox) {
+                cmdStatusBox.innerHTML = '<p class="diag-empty">Status unavailable</p>';
+            }
+        });
+    };
+    cmdStatusRefreshBtn && cmdStatusRefreshBtn.addEventListener('click', loadCommandStatus);
+    cmdPlatformSelect && cmdPlatformSelect.addEventListener('change', () => {
+        loadStates();
+        loadCommandStatus();
+    });
+    if (cmdStatusBox) {
+        loadCommandStatus();
+    }
+
+    const renderDiag = (events = []) => {
+        if (!diagEventsEl) return;
+        const filter = (diagFilterInput?.value || '').toLowerCase().trim();
+        const filtered = filter
+            ? events.filter((e) => JSON.stringify(e).toLowerCase().includes(filter))
+            : events;
+        if (!events.length) {
+            diagEventsEl.innerHTML = '<p class="diag-empty">No diag events</p>';
+            return;
+        }
+        if (!filtered.length) {
+            diagEventsEl.innerHTML = '<p class="diag-empty">No events match filter</p>';
+            return;
+        }
+        const limited = filtered.slice(-200);
+        diagEventsEl.innerHTML = limited.map((e) => {
+            const time = e.ts ? new Date(e.ts).toLocaleTimeString() : '';
+            const label = e.type || e.label || 'diag';
+            const details = e.details || e.reason || '';
+            const platform = e.platform ? `<span class="diag-pill">${escapeHtml(e.platform)}</span>` : '';
+            const trace = e.traceId ? ` • trace:${escapeHtml(e.traceId)}` : '';
+            const sess = e.sessionId ? ` • sess:${escapeHtml(e.sessionId)}` : '';
+            return `<div class="diag-row"><code>${label}</code> ${platform} — ${escapeHtml(details)}${trace}${sess} <span class="diag-ts">${time}</span></div>`;
+        }).join('');
+    };
+
+    const refreshDiag = () => {
+        try {
+            const platformValue = cmdPlatformSelect?.value || 'all';
+            const platforms = platformValue === 'all' ? undefined : [platformValue];
+            chrome.runtime.sendMessage({ type: 'GET_DIAG_EVENTS', platforms, limit: 200 }, (resp) => {
+                if (resp?.success) {
+                    diagCache = resp.events || [];
+                    renderDiag(diagCache);
+                } else {
+                    diagCache = [];
+                    renderDiag([]);
+                }
+            });
+        } catch (err) { console.warn('[devtools] diag refresh error', err); }
+    };
+    diagRefreshBtn && diagRefreshBtn.addEventListener('click', refreshDiag);
+    diagClearBtn && diagClearBtn.addEventListener('click', () => {
+        try {
+            chrome.runtime.sendMessage({ type: 'CLEAR_DIAG_EVENTS' }, () => {
+                diagCache = [];
+                renderDiag([]);
+            });
+        } catch (err) { console.warn('[devtools] diag clear error', err); }
+    });
+    diagFilterInput && diagFilterInput.addEventListener('input', () => {
+        renderDiag(diagCache);
+    });
+    diagCopyBtn && diagCopyBtn.addEventListener('click', async () => {
+        try {
+            const text = diagCache.map((e) => JSON.stringify(e)).join('\\n');
+            if (!text) return;
+            await navigator.clipboard.writeText(text);
+        } catch (err) { console.warn('[devtools] diag copy error', err); }
+    });
+    diagDownloadBtn && diagDownloadBtn.addEventListener('click', () => {
+        try {
+            const blob = new Blob([diagCache.map((e) => JSON.stringify(e)).join('\\n')], { type: 'text/plain' });
+            const url = URL.createObjectURL(blob);
+            const a = document.createElement('a');
+            a.href = url;
+            a.download = `diag-events-${Date.now()}.txt`;
+            a.click();
+            setTimeout(() => URL.revokeObjectURL(url), 1000);
+        } catch (err) { console.warn('[devtools] diag download error', err); }
+    });
+    if (diagEventsEl) {
+        refreshDiag();
+    }
+
+    const runSmokeCheck = () => {
+        const platformValue = cmdPlatformSelect?.value || 'all';
+        const platform = platformValue === 'all' ? undefined : platformValue;
+        if (smokeCheckStatus) smokeCheckStatus.textContent = 'Running…';
+        try {
+            chrome.runtime.sendMessage({ type: 'SMOKE_CHECK', platform }, (resp) => {
+                if (smokeCheckStatus) smokeCheckStatus.textContent = resp?.success ? 'OK' : (resp?.error || 'Failed');
+                refreshDiag();
+            });
+        } catch (err) {
+            if (smokeCheckStatus) smokeCheckStatus.textContent = 'Error';
+        }
+    };
+    smokeCheckBtn && smokeCheckBtn.addEventListener('click', runSmokeCheck);
+
+    document.addEventListener('click', (event) => {
+        const tabBtn = event.target.closest('.devtools-tab');
+        if (!tabBtn) return;
+        const targetId = tabBtn.dataset?.tabTarget;
+        if (targetId === 'diag-tabpanel') {
+            loadStates();
+            refreshDiag();
+            loadSettings();
+        }
+    });
+
+    loadSettings();
+})();
```

### 6.3 Results HTML: подключить results-shared.js и results-devtools.js

**Строки/якоря (в текущей ветке):**
741:    <script src="results-shared.js"></script>
743:    <script src="results-devtools.js"></script>

**Patch (ручной, если у вас в 2.47 другая разметка):**

Найдите блок `<script>` внизу `result_new.html` и приведите к виду:

```diff
--- a/result_new.html
+++ b/result_new.html
@@
-    <script src="results.js"></script>
+    <script src="results-shared.js"></script>
+    <script src="results.js"></script>
+    <script src="results-devtools.js"></script>
```

### 6.4 Background → results: normalizedAnswer + обработка no-response

**Строки/якоря (в текущей ветке):**
4037:    let normalizedAnswer = typeof answer === 'string' ? answer : (answer ?? '');
4038:    const trimmedAnswer = String(normalizedAnswer || '').trim();
4041:        normalizedAnswer = 'Error: Empty answer received';
4043:    const isSuccess = !error && !!String(normalizedAnswer || '').trim() && !normalizedAnswer.startsWith('Error:');
4048:        details: isSuccess ? '' : (error?.message || normalizedAnswer),
4088:        dataPayload.message = normalizedAnswer;
4093:    jobState.llms[llmName].answer = normalizedAnswer;
4127:            answer: normalizedAnswer,
4149:function sendMessageToResultsTab(message) {
4154:        errorMessage.toLowerCase().includes('message port closed before a response was received');

**Diff (background.js — hunks normalizedAnswer/sendMessageToResultsTab):**
```diff
--- a/background.js
+++ b/background.js
@@ -3443,8 +4034,13 @@
     }
     closePingWindowForLLM(llmName);
     clearPostSuccessScrollAudit(llmName);
-    const normalizedAnswer = typeof answer === 'string' ? answer : (answer ?? '');
-    const isSuccess = !error && !normalizedAnswer.startsWith('Error:');
+    let normalizedAnswer = typeof answer === 'string' ? answer : (answer ?? '');
+    const trimmedAnswer = String(normalizedAnswer || '').trim();
+    if (!error && !trimmedAnswer) {
+        error = { type: 'empty_answer', message: 'Empty answer received from content script' };
+        normalizedAnswer = 'Error: Empty answer received';
+    }
+    const isSuccess = !error && !!String(normalizedAnswer || '').trim() && !normalizedAnswer.startsWith('Error:');
     console.log(`[BACKGROUND] Handling response from ${llmName}. Success: ${isSuccess}`);
     appendLogEntry(llmName, {
         type: 'RESPONSE',
@@ -3528,7 +4124,7 @@
             type: 'LLM_PARTIAL_RESPONSE',
             llmName,
             requestId: snapshot?.requestId || jobState?.llms?.[llmName]?.requestId,
-            answer,
+            answer: normalizedAnswer,
             metadata: snapshot
                 ? {
                     url: snapshot.url || '',
@@ -3552,7 +4148,10 @@
 
 function sendMessageToResultsTab(message) {
     const isNoReceiverError = (errorMessage = '') =>
-        errorMessage.toLowerCase().includes('receiving end does not exist');
+        errorMessage.toLowerCase().includes('receiving end does not exist') ||
+        errorMessage.toLowerCase().includes('could not establish connection');
+    const isNoResponseError = (errorMessage = '') =>
+        errorMessage.toLowerCase().includes('message port closed before a response was received');
 
     const fallbackToRuntime = () => {
         chrome.runtime.sendMessage(message, () => {
@@ -3577,10 +4176,17 @@
 
     chrome.tabs.sendMessage(resultsTabId, message, () => {
         if (chrome.runtime.lastError) {
-            console.warn('[BACKGROUND] tabs.sendMessage to results failed:', chrome.runtime.lastError.message);
-            // сбрасываем ID, чтобы не пытаться повторно в ту же вкладку
-            resultsTabId = null;
-            fallbackToRuntime();
+            const errorMessage = chrome.runtime.lastError.message || '';
+            if (isNoResponseError(errorMessage)) {
+                // Results UI обработал сообщение, но не вернул ответ (не ошибка доставки).
+                return;
+            }
+            console.warn('[BACKGROUND] tabs.sendMessage to results failed:', errorMessage);
+            if (isNoReceiverError(errorMessage)) {
+                // сбрасываем ID, чтобы не пытаться повторно в ту же вкладку
+                resultsTabId = null;
+                fallbackToRuntime();
+            }
         } else {
             console.log('[BACKGROUND] Message sent to results tab:', message.type);
         }
```

## 7) Совместимость доменов (Gemini/Perplexity/Grok)

**Описание (из Release Notes):** Совместимость доменов: расширены `host_permissions`/`matches` для Gemini (`bard.google.com`), Perplexity (`www.perplexity.ai`) и Grok (`grok.x.ai`, `x.ai`).

См. diff `manifest.json` в п.4.3 — там добавлены:
- `bard.google.com`
- `www.perplexity.ai`
- `grok.x.ai`, `x.ai`

## 8) Диагностика: явные ошибки при chrome.tabs.create

**Описание (из Release Notes):** Диагностика: явные ошибки при проблемах `chrome.tabs.create` и более аккуратная обработка ошибок запуска в results.

**Строки/якоря (в текущей ветке):**
3641:            console.error(`[BACKGROUND] Failed to create tab for ${llmName}:`, errMsg);

**Diff (background.js — createNewLlmTab: обработка ошибок):**
```diff
--- a/background.js
+++ b/background.js
@@ -3098,24 +3626,45 @@
     const llmConfig = jobState.llms[llmName];
     if (!llmConfig) return;
 
-    chrome.tabs.create({ url: llmConfig.url, active: false }, (tab) => {
-        llmTabMap[llmName] = tab.id;
-        saveTabMapToStorage();
+    const createOptions = {
+        url: llmConfig.url,
+        active: !!autoFocusNewTabsEnabled
+    };
+    if (shouldUseAutomationWindow() && isValidWindowId(automationWindowId)) {
+        createOptions.windowId = automationWindowId;
+        createOptions.active = false;
+    }
+
+    chrome.tabs.create(createOptions, (tab) => {
+        if (chrome.runtime.lastError || !tab?.id) {
+            const errMsg = chrome.runtime.lastError?.message || 'Tab creation failed';
+            console.error(`[BACKGROUND] Failed to create tab for ${llmName}:`, errMsg);
+            broadcastDiagnostic(llmName, {
+                type: 'TAB',
+                label: 'Ошибка создания вкладки',
+                details: errMsg,
+                level: 'error'
+            });
+            handleLLMResponse(llmName, `Error: Failed to open tab for ${llmName}. ${errMsg}`, {
+                type: 'tab_create_failed',
+                message: errMsg
+            });
+            return;
+        }
+        TabMapManager.setTab(llmName, tab.id);
         jobState.llms[llmName].tabId = tab.id;
         console.log(`[BACKGROUND] Создана и сохранена вкладка для ${llmName}: ${tab.id}`);
+        broadcastGlobalState();
 
         initRequestMetadata(llmName, tab.id, tab.url || llmConfig.url || '');
         broadcastHumanVisitStatus();
+        schedulePromptDispatchSupervisor();
 
         const listener = (tabId, changeInfo) => {
             if (tabId === tab.id && changeInfo.status === 'complete') {
                 if (!jobState.llms[llmName].messageSent) {
-                    console.log(`[BACKGROUND] Вкладка ${llmName} загружена, отправляем промпт.`);
-                    jobState.llms[llmName].messageSent = true;
-                    const delay = Math.min(llmConfig.delay || SEND_PROMPT_DELAY_MS, SEND_PROMPT_DELAY_MS);
-                    setTimeout(() => {
-                        sendMessageSafely(tab.id, llmName, { type: 'GET_ANSWER', prompt, attachments });
-                    }, delay);
+                    console.log(`[BACKGROUND] Вкладка ${llmName} загружена, ставим в очередь отправку промпта.`);
+                    dispatchPromptToTab(llmName, tab.id, prompt, attachments, 'tab_loaded');
                 }
                 removeActiveListenerForTab(tab.id);
             }
```
