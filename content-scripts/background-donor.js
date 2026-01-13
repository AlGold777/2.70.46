

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
    'shared/storage-budgets.js'
);

// Claude / Dato  2025-10-19 00-31
chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL('result_new.html') });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
    const hasFocus = windowId !== chrome.windows.WINDOW_ID_NONE;
    handleBrowserFocusChange(hasFocus);
});

let jobState = {};
let activeListeners = new Map();
let resultsTabId = null;
let resultsWindowId = null;
let llmTabMap = {};
const jobMetadata = new Map();
const llmRequestMap = {};
const selectorResolutionMetrics = {};
const AUTO_PING_WINDOW_MS = 45000;
const MANUAL_PING_WINDOW_MS = 20000;
const pingWindowByTabId = {};
const llmActivityMap = {};
const TAB_LOAD_TIMEOUT_MS = 45000;
const MAX_LOG_ENTRIES = 60;
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
const deferredAnswerTimers = {};
const SEND_PROMPT_DELAY_MS = 3000;
const DEFERRED_VISIT_DELAYS_MS = [15000, 45000, 90000];
const API_MODE_STORAGE_KEY = 'llmComparatorApiModeEnabled';
let cachedApiMode = true;
let remoteSelectorsAllowed = REMOTE_SELECTORS_ENABLED;
const postSuccessScrollTimers = new Map();
const TAB_STOP_PREFIX = 'tab_stop_';

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
        queryPatterns: ['https://gemini.google.com/*']
    },
    'Claude': {
        url: 'https://claude.ai/chat/new',
        delay: 3000,
        queryPatterns: ['https://claude.ai/*']
    },
    'Grok': {
        url: 'https://grok.com/',
        delay: 3000,
        queryPatterns: ['https://grok.com/*', 'https://x.com/*']
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
        queryPatterns: ['https://www.perplexity.ai/*']
    }
};
function isValidTabId(tabId) {
    return Number.isInteger(tabId) && tabId > 0;
}

function extendPingWindowForTab(tabId, durationMs = AUTO_PING_WINDOW_MS) {
    if (!isValidTabId(tabId)) return;
    pingWindowByTabId[tabId] = Date.now() + durationMs;
}

function extendPingWindowForLLM(llmName, durationMs = AUTO_PING_WINDOW_MS) {
    const tabId = llmTabMap[llmName];
    if (!tabId) return;
    extendPingWindowForTab(tabId, durationMs);
}

function isPingWindowActive(tabId) {
    const expiry = pingWindowByTabId[tabId];
    if (!expiry) return false;
    if (Date.now() > expiry) {
        delete pingWindowByTabId[tabId];
        return false;
    }
    return true;
}

function closePingWindowForTab(tabId) {
    if (!isValidTabId(tabId)) return;
    if (pingWindowByTabId[tabId]) {
        delete pingWindowByTabId[tabId];
    }
}

function closePingWindowForLLM(llmName) {
    const tabId = llmTabMap[llmName];
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

function appendLogEntry(llmName, entry = {}) {
    const buffer = ensureLogBuffer(llmName);
    if (!buffer) return null;
    const logEntry = {
        ts: entry.ts || Date.now(),
        type: entry.type || 'INFO',
        label: entry.label || '',
        details: entry.details || '',
        level: entry.level || 'info',
        meta: entry.meta || {}
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

function stopHumanPresenceLoop() {
    if (humanPresenceLoopTimeout) {
        clearTimeout(humanPresenceLoopTimeout);
        humanPresenceLoopTimeout = null;
    }
    humanPresenceActive = false;
    broadcastHumanVisitStatus();
}

function scheduleHumanPresenceLoop(immediate = false) {
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
            const tabId = entry.tabId || llmTabMap[llmName];
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
    Object.values(llmTabMap).forEach((tabId) => {
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
        if (currentHumanVisit?.cancel) {
            try { currentHumanVisit.cancel(); } catch (_) { /* noop */ }
        }
        stopHumanPresenceLoop();
    } else if (!humanPresencePaused && !humanPresenceManuallyStopped && hasPendingHumanVisits()) {
        scheduleHumanPresenceLoop(true);
    } else {
        broadcastHumanVisitStatus();
    }
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
                            if (isScrollable(node)) {
                                set.add(node);
                            }
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
            ensureScrollToolkit().scrollAllTargets().catch((err) => console.warn('[HUMAN-VISIT] scrollTabToBottom error:', err));
        }
    }).catch((err) => {
        console.warn('[HUMAN-VISIT] scrollTabToBottom failed:', err?.message || err);
    });
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
const saveTabMapToStorage = async () => {
    await chrome.storage.local.set({ llmTabMap: llmTabMap });
    console.log('[BACKGROUND] Карта вкладок сохранена в storage:', llmTabMap);
};

// Функция для загрузки карты вкладок из хранилища при запуске
const loadTabMapFromStorage = async () => {
    const data = await chrome.storage.local.get('llmTabMap');
    if (data.llmTabMap) {
        llmTabMap = data.llmTabMap;
        console.log('[BACKGROUND] Карта вкладок загружена из storage:', llmTabMap);
    }
};

const loadResolutionMetrics = async () => {
    try {
        const stored = await chrome.storage.local.get('selectorResolutionMetrics');
        if (stored.selectorResolutionMetrics) {
            Object.assign(selectorResolutionMetrics, stored.selectorResolutionMetrics);
            console.log('[BACKGROUND] Resolution metrics loaded:', selectorResolutionMetrics);
        }
    } catch (e) {
        console.warn('[BACKGROUND] Failed to load resolution metrics:', e);
    }
};

const persistResolutionMetrics = async () => {
    try {
        await chrome.storage.local.set({ selectorResolutionMetrics });
    } catch (e) {
        console.warn('[BACKGROUND] Failed to persist resolution metrics:', e);
    }
};

const recordResolutionMetric = async ({ modelName, elementType, layer }) => {
    if (!modelName || !elementType || !layer) return;
    const level = RESOLUTION_LAYER_MAP[layer] || layer;
    const key = `${modelName}_${elementType}_${level}`;
    selectorResolutionMetrics[key] = (selectorResolutionMetrics[key] || 0) + 1;
    appendLogEntry(modelName, {
        type: 'SELECTOR',
        label: `${elementType}: слой ${level}`,
        details: '',
        level: level === 'L4' ? 'warning' : 'info',
        meta: { elementType, layer: level }
    });
    await persistResolutionMetrics();
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

// --- V2.0 START: Health Check System ---
const HEALTH_CHECK_INTERVAL_MS = 30000; // 30 секунд
const HEALTH_CHECK_TIMEOUT_MS = 5000;   // 5 секунд

let healthCheckTimer = null;
let pendingPings = new Map();

function startHealthChecker() {
    if (healthCheckTimer) clearInterval(healthCheckTimer);
    console.log('[HEALTH-CHECK] Starting health checker...');
    healthCheckTimer = setInterval(runHealthChecks, HEALTH_CHECK_INTERVAL_MS);
}

function stopHealthChecker() {
    if (healthCheckTimer) {
        clearInterval(healthCheckTimer);
        healthCheckTimer = null;
        console.log('[HEALTH-CHECK] Health checker stopped.');
    }
}

function runHealthChecks() {
    const activeTabs = Object.entries(llmTabMap);
    if (activeTabs.length === 0) {
        stopHealthChecker();
        return;
    }

    console.log('[HEALTH-CHECK] Running checks for active tabs.');
    activeTabs.forEach(([llmName, tabId]) => {
        const pingId = `${llmName}-${Date.now()}`;
        pendingPings.set(pingId, { llmName, tabId });

        chrome.tabs.sendMessage(tabId, { type: 'HEALTH_CHECK_PING', pingId: pingId }, (response) => {
            if (chrome.runtime.lastError) {
                console.error(`[HEALTH-CHECK] Immediate error pinging ${llmName} (tab ${tabId}).`, chrome.runtime.lastError.message);
            }
        });

        setTimeout(() => {
            if (pendingPings.has(pingId)) {
                console.error(`[HEALTH-CHECK] Timeout: No PONG received from ${llmName} (tab ${tabId}). Marking as unresponsive.`);
                pendingPings.delete(pingId);
                updateModelState(llmName, 'UNRESPONSIVE', { message: `Tab for ${llmName} is unresponsive.` });
                handleLLMResponse(llmName, `Error: Tab for ${llmName} is unresponsive.`, { type: 'health_check_failed' });
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
    heartbeatTimer = setInterval(() => {
        Object.entries(llmTabMap).forEach(([llmName, tabId]) => {
            chrome.tabs.sendMessage(tabId, { type: 'HEARTBEAT' }, (response) => {
                if (chrome.runtime.lastError) {
                    console.warn(`[HEARTBEAT] No response from ${llmName}, may be inactive`);
                }
            });
        });
    }, HEARTBEAT_INTERVAL);
}

function stopHeartbeatMonitor() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        console.log('[HEARTBEAT] Monitor stopped');
    }
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
        const tabs = await chrome.tabs.query({ url: LLM_URL_PATTERNS });
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
    
    //-- 4.4. Cleanup при закрытии вкладок --//
    // Проверяем LLM вкладки
    for (const llmName in llmTabMap) {
        if (llmTabMap[llmName] === tabId) {
            console.log(`[BACKGROUND] LLM вкладка ${llmName} закрыта, отправляем cleanup...`);
            chrome.tabs.sendMessage(tabId, { type: 'STOP_AND_CLEANUP' }).catch(() => {});
            delete llmTabMap[llmName];
            saveTabMapToStorage();
            break;
        }
    }
    
    // Проверяем evaluator tab
    if (evaluatorTabId === tabId) {
        console.log(`[BACKGROUND] Evaluator tab закрыта.`);
        chrome.tabs.sendMessage(tabId, { type: 'STOP_AND_CLEANUP' }).catch(() => {});
        evaluatorTabId = null;
    }
    
    // Проверяем results tab
    if (resultsTabId === tabId) {
        console.log(`[BACKGROUND] Results tab закрыта, очищаем все LLM сессии...`);
        Object.entries(llmTabMap).forEach(([llmName, llmTabId]) => {
            chrome.tabs.sendMessage(llmTabId, { type: 'STOP_AND_CLEANUP' }).catch(() => {});
        });
        resultsTabId = null;
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("[BACKGROUND] Received message:", message);

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
                handleLLMResponse(message.llmName, message.answer, message.error || null);
                sendResponse({ status: 'response_handled' });
                break;
                
            case 'CONTENT_CLEANING_STATS':
                console.log(`[BACKGROUND] Cleaning stats from ${message.llmName}:`, message.stats);
                sendResponse({ status: 'stats_received' });
                break;

            case 'METRICS_REPORT':
                console.log(`[BACKGROUND] Metrics report from ${message.llmName}:`, message.metrics);
                sendResponse({ status: 'metrics_received' });
                break;

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
                    const states = Array.from(best.values())
                        .map((v) => { const { __score, ...rest } = v || {}; return rest; })
                        .sort((a, b) => (b?.updatedAt || 0) - (a?.updatedAt || 0));
                    sendResponse({ success: true, states });
                });
                return true;
            }

            case 'SUBMIT_PROMPT': {
                (async () => {
                    const commandId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                    const command = {
                        id: commandId,
                        action: 'submit_prompt',
                        payload: { prompt: message.prompt, platforms: message.platforms },
                        createdAt: Date.now()
                    };
                    const delivery = await broadcastCommandToLlmTabs(command);
                    await chrome.storage.local.set({ pending_command: command });
                    sendResponse({ success: true, commandId, delivered: delivery.sent });
                })();
                return true;
            }

            case 'STOP_ALL': {
                (async () => {
                    const cmd = { action: 'STOP_ALL', timestamp: Date.now(), platforms: message.platforms };
                    await chrome.storage.local.set({ global_command: cmd });
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
                        const { commandId } = message || {};
                        const res = await chrome.storage.local.get('pending_command');
                        if (res?.pending_command?.id === commandId) {
                            await chrome.storage.local.remove('pending_command');
                        }
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
                        const all = await chrome.storage.local.get(null);
                        const pending = all?.pending_command || null;
                        const platforms = Array.isArray(message.platforms) ? message.platforms : null;
                        const acks = Object.entries(all || {})
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
            
            case 'SAVE_SELECTOR_OVERRIDE': {
                (async () => {
                    try {
                        const overrides = await saveManualSelectorOverride(message.modelName, message.elementType, message.selector);
                        sendResponse({ status: 'ok', overrides: overrides[message.modelName] || {} });
                    } catch (err) {
                        sendResponse({ status: 'error', error: err?.message || 'Failed to save override' });
                    }
                })();
                return true;
            }

            case 'HIGHLIGHT_SELECTOR': {
                const { modelName, selector } = message;
                const tabId = llmTabMap[modelName];
                if (!tabId) {
                    sendResponse({ status: 'error', error: 'Model tab not active' });
                    break;
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
                return true;
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
                    const pairs = Object.entries(llmTabMap);
                    if (!pairs.length) {
                        sendResponse({ status: 'error', error: 'Нет активных LLM-вкладок для проверки' });
                        return;
                    }
                    const results = await Promise.all(pairs.map(([llmName, tabId]) => runSelectorHealthCheckForTab(llmName, tabId)));
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
                    console.log(`[HEALTH-CHECK] PONG received from ${pendingPings.get(message.pingId).llmName}`);
                    pendingPings.delete(message.pingId);
                }
                sendResponse({ status: 'pong_received' });
                break;

            case 'CLOSE_ALL_SESSIONS':
                closeAllSessions();
                sendResponse({ status: 'sessions_closed' });
                break;
                
            //-- 4.5. Ручная команда cleanup из UI --//
        case 'CLEAR_ALL_SESSIONS':
            Object.entries(llmTabMap).forEach(([llmName, tabId]) => {
                chrome.tabs.sendMessage(tabId, { type: 'STOP_AND_CLEANUP' }).catch(() => {});
            });
            llmTabMap = {};
            jobState = {};
            clearAllDeferredAnswerTimers();
            stopHumanPresenceLoop();
            humanPresencePaused = false;
            humanPresenceManuallyStopped = false;
            Object.keys(llmActivityMap).forEach((tabId) => delete llmActivityMap[tabId]);
            clearActiveListeners();
            sendResponse({ status: 'all_sessions_cleared' });
            break;

            case 'MANUAL_RESPONSE_PING': {
                const result = handleManualResponsePing(message.llmName);
                sendResponse(result);
                break;
            }

            case 'LLM_DIAGNOSTIC_EVENT': {
                if (!message.llmName) {
                    sendResponse({ status: 'diagnostic_missing_llm' });
                    break;
                }
                broadcastDiagnostic(message.llmName, message.event || {});
                sendResponse({ status: 'diagnostic_logged' });
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
    jobState = {
        prompt: prompt,
        llms: {},
        responsesCollected: 0,
        evaluationStarted: false,
        useApiFallback,
        session: {
            startTime: Date.now(),
            totalModels: selectedLLMs.length,
            completed: 0,
            failed: 0
        },
        attachments
    };
    humanPresencePaused = false;
    humanPresenceManuallyStopped = false;
    saveJobState(jobState);

    initializeCircuitBreakers(selectedLLMs);
    //-- 14.2. Запуск heartbeat мониторинга --//
    startHeartbeatMonitor();

    selectedLLMs.forEach(llmName => {
        jobState.llms[llmName] = {
            ...(LLM_TARGETS[llmName] || {}),
            tabId: null,
            answer: null,
            messageSent: false,
            status: 'IDLE',
            logs: [],
            humanVisits: 0,
            humanStalled: false,
            skipHumanLoop: false
        };
        updateModelState(llmName, 'IDLE', { apiStatus: 'idle' });
    });
    broadcastHumanVisitStatus();

    selectedLLMs.forEach(llmName => {
        startModelForLLM(llmName, prompt, forceNewTabs, attachments);
    });
}

function startModelForLLM(llmName, prompt, forceNewTabs, attachments = []) {
    (async () => {
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
    })().catch((err) => {
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

    const tabId = llmTabMap[llmName];
    if (tabId) {
        chrome.tabs.get(tabId, async (tab) => {
            if (chrome.runtime.lastError) {
                console.log(`[BACKGROUND] Tab for ${llmName} was closed. Creating a new one.`);
                delete llmTabMap[llmName];
                saveTabMapToStorage();
                tryAttachExistingTab(llmName, prompt, attachments).then(attached => {
                    if (!attached) {
                        createNewLlmTab(llmName, prompt, attachments);
                    }
                });
            } else {
                console.log(`[BACKGROUND] Reusing tab ${tabId} for ${llmName}.`);

                try {
                    await prepareTabForUse(tabId, llmName);

                    initRequestMetadata(llmName, tabId, tab?.url || (LLM_TARGETS[llmName]?.url) || '');
                    jobState.llms[llmName].tabId = tabId;
                    chrome.tabs.update(tabId, { active: true });
                    jobState.llms[llmName].messageSent = true;
                    sendMessageSafely(tabId, llmName, { type: 'GET_ANSWER', prompt: prompt, attachments });
                } catch (err) {
                    console.error(`[BACKGROUND] Failed to prepare tab for ${llmName}:`, err);
                    delete llmTabMap[llmName];
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
    const tabId = llmTabMap[llmName];
    if (!tabId) return;
    console.log(`[BACKGROUND] Detaching existing tab ${tabId} for ${llmName}`);
    chrome.tabs.sendMessage(tabId, { type: 'STOP_AND_CLEANUP' }).catch(() => {});
    removeActiveListenerForTab(tabId);
    delete llmTabMap[llmName];
    saveTabMapToStorage();
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

fetchRemoteSelectors();

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
        const fallback = initRequestMetadata(llmName, llmTabMap[llmName], updates.url || '');
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

    chrome.tabs.create({ url: llmConfig.url, active: false }, (tab) => {
        llmTabMap[llmName] = tab.id;
        saveTabMapToStorage();
        jobState.llms[llmName].tabId = tab.id;
        console.log(`[BACKGROUND] Создана и сохранена вкладка для ${llmName}: ${tab.id}`);

        initRequestMetadata(llmName, tab.id, tab.url || llmConfig.url || '');
        broadcastHumanVisitStatus();

        const listener = (tabId, changeInfo) => {
            if (tabId === tab.id && changeInfo.status === 'complete') {
                if (!jobState.llms[llmName].messageSent) {
                    console.log(`[BACKGROUND] Вкладка ${llmName} загружена, отправляем промпт.`);
                    jobState.llms[llmName].messageSent = true;
                    const delay = Math.min(llmConfig.delay || SEND_PROMPT_DELAY_MS, SEND_PROMPT_DELAY_MS);
                    setTimeout(() => {
                        sendMessageSafely(tab.id, llmName, { type: 'GET_ANSWER', prompt, attachments });
                    }, delay);
                }
                removeActiveListenerForTab(tab.id);
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
        const timeoutId = setTimeout(() => {
            if (!activeListeners.has(tab.id)) {
                return;
            }
            console.warn(`[BACKGROUND] Tab ${tab.id} for ${llmName} did not finish loading in time, cleaning listener`);
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
                    const retryDelay = 2000 * attempt;
                    console.warn(`[BACKGROUND] Retrying message to ${llmName} in ${retryDelay}ms (attempt ${attempt + 1})`);
                    setTimeout(() => sendMessageSafely(tabId, llmName, message, attempt + 1), retryDelay);
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
        chrome.tabs.query({ url: patterns }, async (tabs) => {
            if (chrome.runtime.lastError || !tabs || !tabs.length) {
                resolve(false);
                return;
            }
            tabs.sort((a, b) => {
                const aTime = typeof a.lastAccessed === 'number' ? a.lastAccessed : 0;
                const bTime = typeof b.lastAccessed === 'number' ? b.lastAccessed : 0;
                return bTime - aTime;
            });
            const candidate = tabs[0];
            try {
                await prepareTabForUse(candidate.id, llmName);
                llmTabMap[llmName] = candidate.id;
                saveTabMapToStorage();
                initRequestMetadata(llmName, candidate.id, candidate?.url || (LLM_TARGETS[llmName]?.url) || '');
                jobState.llms[llmName].tabId = candidate.id;
                jobState.llms[llmName].messageSent = true;
                sendMessageSafely(candidate.id, llmName, { type: 'GET_ANSWER', prompt, attachments });
                broadcastHumanVisitStatus();
                resolve(true);
            } catch (err) {
                console.warn(`[BACKGROUND] Unable to reuse existing tab for ${llmName}:`, err?.message || err);
                resolve(false);
            }
        });
    });
}

function collectResponses() {
    console.log('[BACKGROUND] Collecting responses');
    Object.keys(jobState.llms).forEach(llmName => {
        if (jobState.llms[llmName].tabId && !jobState.llms[llmName].messageSent) {
            jobState.llms[llmName].messageSent = true;
            sendMessageSafely(jobState.llms[llmName].tabId, llmName, { type: 'GET_ANSWER', prompt: jobState.prompt, attachments: jobState.attachments || [] });
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
        ] });
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
    const tabId = llmTabMap[llmName];
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
    llmEntry.messageSent = true;
    sendMessageSafely(tabId, llmName, { type: 'GET_ANSWER', prompt, meta: { manualResend: true } });
    return { status: 'manual_resend_dispatched' };
}

//-- 4.1. Команда завершения работы content script --//
function sendCleanupCommand(llmName) {
    const tabId = llmTabMap[llmName];
    if (!tabId) return;
    
    chrome.tabs.sendMessage(tabId, { type: 'STOP_AND_CLEANUP' }, (response) => {
        if (chrome.runtime.lastError) {
            console.warn(`[BACKGROUND] Cleanup command failed for ${llmName}:`, chrome.runtime.lastError.message);
        } else {
            console.log(`[BACKGROUND] Cleanup command sent to ${llmName}, response:`, response);
        }
    });
}

function handleLLMResponse(llmName, answer, error = null) {
    // --- V2.0: API Fallback Trigger ---
    if (error && (error.type === 'rate_limit' || error.type === 'captcha_detected')) {
        console.log(`[API-FALLBACK] Triggered for ${llmName} due to error: ${error.type}`);
        executeApiFallback(llmName, jobState.prompt)
            .then((started) => {
                if (!started) {
                    handleLLMResponse(
                        llmName,
                        answer || `Error: ${error?.message || 'API fallback unavailable'}`,
                        { type: 'fallback_unavailable' }
                    );
                }
            })
            .catch((fallbackError) => {
                console.error('[API-FALLBACK] Failed to execute fallback:', fallbackError);
                handleLLMResponse(llmName, `Error: ${fallbackError?.message || 'API fallback failed'}`, { type: 'fallback_failed' });
            });
        return;
    }
    closePingWindowForLLM(llmName);
    clearPostSuccessScrollAudit(llmName);
    const normalizedAnswer = typeof answer === 'string' ? answer : (answer ?? '');
    const isSuccess = !error && !normalizedAnswer.startsWith('Error:');
    console.log(`[BACKGROUND] Handling response from ${llmName}. Success: ${isSuccess}`);
    appendLogEntry(llmName, {
        type: 'RESPONSE',
        label: isSuccess ? 'Ответ получен' : 'Ошибка ответа',
        details: isSuccess ? '' : (error?.message || normalizedAnswer),
        level: isSuccess ? 'success' : 'error'
    });

    updateCircuitBreaker(llmName, isSuccess);
    if (isSuccess) {
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
        dataPayload.message = answer;
    } else if (error?.type === 'health_check_failed') {
        status = 'UNRESPONSIVE';
        dataPayload.message = answer;
    } else if (isSuccess) {
        status = 'COPY_SUCCESS';
    } else {
        dataPayload.message = normalizedAnswer;
    }

    updateModelState(llmName, status, dataPayload);

    jobState.llms[llmName].answer = normalizedAnswer;
    if (isFirstResponse) {
        jobState.responsesCollected++;
        console.log(`[BACKGROUND] Recorded response from ${llmName}. Total: ${jobState.responsesCollected}/${Object.keys(jobState.llms).length}`);
        if (jobState.session && jobState.responsesCollected >= (jobState.session.totalModels || 0)) {
            focusResultsTab();
        }
    }
    broadcastHumanVisitStatus();
    llmEntry.manualResendActive = false;

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
    const tabId = llmTabMap[llmName];
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
            answer,
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
    if (jobState?.llms?.[llmName]) {
        jobState.llms[llmName].status = normalizedStatus;
        jobState.llms[llmName].statusData = data;
    }
    const severity = (() => {
        if (['CRITICAL_ERROR', 'API_FAILED'].includes(normalizedStatus)) return 'error';
        if (['RECOVERABLE_ERROR', 'ERROR', 'UNRESPONSIVE', 'CIRCUIT_OPEN'].includes(normalizedStatus)) return 'warning';
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
    humanPresencePaused = false;
    humanPresenceManuallyStopped = false;
    
    // Сначала отправляем команду cleanup во все вкладки
    Object.entries(llmTabMap).forEach(([llmName, tabId]) => {
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
        const tabIdsToClose = Object.values(llmTabMap);

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

        llmTabMap = {};
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

// Проверка, жив ли скрипт
async function checkScriptHealth(tabId, llmName) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: 'HEALTH_PING' }, (response) => {
            if (chrome.runtime.lastError || !response) {
                console.warn(`[BACKGROUND] Script health check failed for ${llmName}`);
                resolve(false);
            } else {
                console.log(`[BACKGROUND] ✅ Script healthy for ${llmName}`);
                resolve(true);
            }
        });
    });
}

// Принудительная переинъекция
async function reinjectScript(tabId, llmName) {
    const scriptFile = SCRIPT_MAP[llmName];
    if (!scriptFile) {
        console.error(`[BACKGROUND] No script mapping for ${llmName}`);
        return false;
    }

    console.log(`[BACKGROUND] 🔄 Reinjecting ${scriptFile} into tab ${tabId}...`);
    
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
                    resolve(true);
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
            
            // Таймаут на случай проблем
            setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve(false);
            }, 30000);
        });
    } catch (err) {
        console.error(`[BACKGROUND] ❌ Reinject failed for ${llmName}:`, err);
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
        
        chrome.tabs.query({ url: llmUrls }, (tabs) => {
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
    chrome.alarms.create(REMOTE_SELECTORS_ALARM, { periodInMinutes: REMOTE_SELECTORS_REFRESH_MS / 60000 });
    fetchRemoteSelectors();
});
chrome.runtime.onStartup.addListener(() => {
    chrome.alarms.create(REMOTE_SELECTORS_ALARM, { periodInMinutes: REMOTE_SELECTORS_REFRESH_MS / 60000 });
    fetchRemoteSelectors();
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
        fetchRemoteSelectors();
        return;
    }
    if (alarm.name === VERSION_STATUS_ALARM) {
        updateVersionStatusSnapshot();
        return;
    }
    if (alarm.name === ANTI_SLEEP_ALARM) {
        handleAntiSleepAlarm();
        return;
    }
});

//-- 9.1. Очистка при остановке Service Worker --//
chrome.runtime.onSuspend.addListener(() => {
    console.log('[BACKGROUND] Service Worker suspending, cleaning up...');
    
    // Отправляем команду cleanup во все активные вкладки
    Object.entries(llmTabMap).forEach(([llmName, tabId]) => {
        chrome.tabs.sendMessage(tabId, { type: 'STOP_AND_CLEANUP' }).catch(() => {});
    });
    
    // Очищаем локальное состояние
    llmTabMap = {};
    jobState = {};
    clearAllDeferredAnswerTimers();
    circuitBreakerState = {};
    Object.keys(llmActivityMap).forEach((tabId) => delete llmActivityMap[tabId]);
    clearActiveListeners();
    persistCircuitBreakerState();
    
    // Останавливаем health checker
    stopHealthChecker();
    
    // Останавливаем heartbeat monitor
    stopHeartbeatMonitor();
    
    console.log('[BACKGROUND] Cleanup complete on suspend');
});

// --- V4.0: Global Anti-Sleep Heartbeat ---
const LLM_URL_PATTERNS = [
    '*://chat.openai.com/*',
    '*://gemini.google.com/*',
    '*://claude.ai/*',
    '*://grok.com/*',
    '*://x.com/*',
    '*://chat.qwen.ai/*',
    '*://chat.deepseek.com/*',
    '*://www.perplexity.ai/*',
    '*://chat.mistral.ai/*'
];

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
    for (const [name, mappedId] of Object.entries(llmTabMap)) {
        if (mappedId === tabId) return name;
    }
    return null;
}

function isTabSessionCompleted(tabId) {
    const llmName = getLlmNameByTabId(tabId);
    if (!llmName) return false;
    const status = jobState?.llms?.[llmName]?.status;
    return status === 'COPY_SUCCESS' || status === 'SUCCESS' || status === 'DONE';
}

const ANTI_SLEEP_ALARM = 'anti_sleep_pulse';
chrome.alarms.create(ANTI_SLEEP_ALARM, { periodInMinutes: 0.333 }); // ~20 seconds
const STORAGE_CLEANUP_ALARM = 'pragmatist_storage_cleanup';
chrome.alarms.create(STORAGE_CLEANUP_ALARM, { periodInMinutes: 5 });

async function handleAntiSleepAlarm() {
    const logPing = (entry) => {
        try {
            console.debug('[ANTI-SLEEP]', entry);
        } catch (_) {}
    };
    try {
        const tabs = await chrome.tabs.query({ url: LLM_URL_PATTERNS });
        const hardStopped = await getHardStoppedTabs();
        for (const tab of tabs) {
            if (!isPingWindowActive(tab.id)) {
                logPing({ tabId: tab.id, action: 'skip_inactive_window' });
                continue;
            }
            if (hardStopped.has(tab.id)) {
                closePingWindowForTab(tab.id);
                delete llmActivityMap[tab.id];
                logPing({ tabId: tab.id, action: 'skip_hard_stop' });
                continue;
            }
            if (isTabSessionCompleted(tab.id)) {
                closePingWindowForTab(tab.id);
                delete llmActivityMap[tab.id];
                logPing({ tabId: tab.id, action: 'skip_completed' });
                continue;
            }
            const idleTime = getInactivityMs(tab.id);
            if (idleTime > 180000) {
                // 3-minute hard ceiling для пингов: прекращаем любой анти-sleep
                closePingWindowForTab(tab.id);
                delete llmActivityMap[tab.id];
                logPing({ tabId: tab.id, action: 'skip_idle_timeout_3m', idleTime });
                continue;
            }
            let intensity = 'soft';
            if (idleTime > 120000) {
                intensity = 'hard';
            } else if (idleTime > 30000) {
                intensity = 'medium';
            }

            if (intensity === 'soft' && Math.random() < 0.3) continue;

            chrome.tabs.sendMessage(tab.id, {
                type: 'ANTI_SLEEP_PING',
                intensity
            }).catch(() => {});
            logPing({ tabId: tab.id, action: 'ping', intensity, idleTime });
        }
    } catch (e) {
        console.warn('[ANTI-SLEEP] Alarm broadcast error:', e);
    }
}

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
