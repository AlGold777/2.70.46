// DevTools: Telemetry (Embedded Pragmatist)
(function attachPragmatistDevtools() {
    const telemetryPlatformSelect = document.getElementById('telemetry-platform-select');
    const telemetryTypeSelect = document.getElementById('telemetry-type-select');
    const telemetryPresetSelect = document.getElementById('telemetry-preset-select');
    const telemetryRefreshBtn = document.getElementById('telemetry-refresh-btn');
    const telemetryCopyBtn = document.getElementById('telemetry-copy-btn');
    const telemetryExportJsonBtn = document.getElementById('telemetry-export-json-btn');
    const telemetryResetBtn = document.getElementById('telemetry-reset-btn');
    const telemetryTimeline = document.getElementById('telemetry-timeline');
    const telemetryStatus = document.getElementById('telemetry-status');
    const telemetrySummary = document.getElementById('telemetry-summary');
    const telemetrySummaryStatus = document.getElementById('telemetry-summary-status');
    const escapeHtml = (window.ResultsShared && window.ResultsShared.escapeHtml) || ((s = '') => String(s));
    const flashButtonFeedback = window.ResultsShared?.flashButtonFeedback || null;
    const fallbackCopyViaTextarea = window.ResultsShared?.fallbackCopyViaTextarea || null;
    const normalizePlatformName = (value = '') => String(value || '').trim().toLowerCase();
    const resolveSelectedLlmNames = () => {
        const shared = window.ResultsShared?.getSelectedLLMs;
        if (typeof shared === 'function') {
            const names = shared();
            if (Array.isArray(names)) return names;
        }
        const idMap = {
            'llm-gpt': 'GPT',
            'llm-gemini': 'Gemini',
            'llm-claude': 'Claude',
            'llm-grok': 'Grok',
            'llm-lechat': 'Le Chat',
            'llm-qwen': 'Qwen',
            'llm-deepseek': 'DeepSeek',
            'llm-perplexity': 'Perplexity'
        };
        return Array.from(document.querySelectorAll('.llm-button.active'))
            .map((btn) => idMap[btn.id] || btn.textContent.trim())
            .filter(Boolean);
    };
    const getSelectedLlmSet = () => new Set(resolveSelectedLlmNames().map(normalizePlatformName));
    const resolveTelemetryPlatformName = (event) => {
        const raw = event?.platform || event?.llmName || event?.meta?.llmName || event?.meta?.platform || 'unknown';
        const cleaned = String(raw || '').trim();
        return cleaned || 'unknown';
    };
    const writeClipboardText = async (text = '', button = null) => {
        if (!text) return false;
        if (navigator?.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                if (flashButtonFeedback && button) flashButtonFeedback(button, 'success');
                return true;
            } catch (err) {
                console.warn('[devtools] clipboard writeText failed', err);
            }
        }
        if (typeof fallbackCopyViaTextarea === 'function') {
            try {
                fallbackCopyViaTextarea(text);
                if (flashButtonFeedback && button) flashButtonFeedback(button, 'success');
                return true;
            } catch (err) {
                console.warn('[devtools] clipboard fallback failed', err);
            }
        }
        if (flashButtonFeedback && button) flashButtonFeedback(button, 'error');
        return false;
    };
    let telemetryCache = [];
    let telemetryFilteredCache = [];

    const formatDuration = (ms) => {
        if (!Number.isFinite(ms) || ms < 0) return null;
        if (ms < 1000) return `${Math.round(ms)}ms`;
        const seconds = ms / 1000;
        const digits = seconds >= 10 ? 0 : 1;
        const rounded = seconds.toFixed(digits);
        return `${rounded.replace(/\.0$/, '')}s`;
    };

    const normalizeTelemetryLabel = (event) => {
        const raw = event?.label || event?.meta?.event || '';
        return String(raw).trim().toUpperCase();
    };

    const buildTelemetrySummary = (events = []) => {
        const phaseMap = {
            PREPARATION_START: ['preparation', 'start'],
            PREPARATION_DONE: ['preparation', 'end'],
            STREAMING_START: ['streaming', 'start'],
            STREAMING_DONE: ['streaming', 'end'],
            FINALIZATION_START: ['finalization', 'start'],
            FINALIZATION_DONE: ['finalization', 'end'],
            PIPELINE_START: ['pipeline', 'start'],
            PIPELINE_COMPLETE: ['pipeline', 'end']
        };
        const summaries = new Map();
        (Array.isArray(events) ? events : []).forEach((event) => {
            const requestId = event?.meta?.requestId;
            if (!requestId) return;
            const ts = Number.isFinite(event?.ts) ? event.ts : Date.now();
            const existing = summaries.get(requestId) || {
                requestId,
                platform: '',
                llmName: '',
                startTs: ts,
                endTs: ts,
                phases: {
                    preparation: {},
                    streaming: {},
                    finalization: {},
                    pipeline: {}
                },
                errors: [],
                hasSuccess: false
            };
            existing.startTs = Math.min(existing.startTs, ts);
            existing.endTs = Math.max(existing.endTs, ts);
            if (!existing.llmName) {
                existing.llmName = event?.meta?.llmName || event?.platform || event?.meta?.platform || '';
            }
            if (!existing.platform) {
                existing.platform = event?.meta?.platform || event?.platform || '';
            }
            const label = normalizeTelemetryLabel(event);
            if (label && phaseMap[label]) {
                const [phaseName, phaseKey] = phaseMap[label];
                existing.phases[phaseName] = existing.phases[phaseName] || {};
                existing.phases[phaseName][phaseKey] = ts;
            }
            if (label === 'PIPELINE_COMPLETE' || label === 'FINALIZATION_DONE' || label === 'STREAMING_DONE') {
                existing.hasSuccess = true;
            }
            const level = String(event?.level || '').toLowerCase();
            const degraded = Boolean(event?.meta?.degraded) || String(event?.meta?.degradedReason || '').toLowerCase() === 'hard_timeout';
            const isError = !degraded && (level === 'error' || label === 'PIPELINE_ERROR' || label.endsWith('_ERROR') || event?.type === 'ERROR');
            if (isError) {
                const reason = event?.meta?.message || event?.details || event?.label || 'error';
                existing.errors.push({ reason, ts });
            }
            summaries.set(requestId, existing);
        });
        return Array.from(summaries.values()).sort((a, b) => b.startTs - a.startTs);
    };

    const renderTelemetrySummary = (events = []) => {
        if (!telemetrySummary) return;
        const summaries = buildTelemetrySummary(events);
        const visible = summaries.slice(0, 12);
        if (telemetrySummaryStatus) {
            telemetrySummaryStatus.textContent = summaries.length ? `${visible.length}/${summaries.length} runs` : 'No runs';
        }
        if (!visible.length) {
            telemetrySummary.innerHTML = '<p class="diag-empty">No telemetry runs</p>';
            return;
        }
        telemetrySummary.innerHTML = visible.map((summary) => {
            const platform = escapeHtml(String(summary.llmName || summary.platform || 'unknown'));
            const time = summary.startTs ? new Date(summary.startTs).toLocaleTimeString() : '';
            const prepMs = formatDuration(summary.phases.preparation?.end - summary.phases.preparation?.start);
            const streamMs = formatDuration(summary.phases.streaming?.end - summary.phases.streaming?.start);
            const finalMs = formatDuration(summary.phases.finalization?.end - summary.phases.finalization?.start);
            const totalMs = formatDuration(summary.endTs - summary.startTs);
            const phaseParts = [];
            if (prepMs) phaseParts.push(`prep ${prepMs}`);
            if (streamMs) phaseParts.push(`stream ${streamMs}`);
            if (finalMs) phaseParts.push(`final ${finalMs}`);
            const phaseText = phaseParts.length ? phaseParts.join(' • ') : (totalMs ? `total ${totalMs}` : '-');
            const lastError = summary.errors.slice().sort((a, b) => b.ts - a.ts)[0];
            let status = 'running';
            if (summary.errors.length && summary.hasSuccess) {
                status = 'partial';
            } else if (summary.errors.length) {
                status = 'error';
            } else if (summary.hasSuccess) {
                status = 'success';
            }
            const statusClass = status === 'error'
                ? 'is-error'
                : (status === 'partial' ? 'is-warning' : (status === 'success' ? 'is-success' : ''));
            const reason = summary.errors.length ? String(lastError?.reason || '').trim() : 'ok';
            const reasonText = escapeHtml(reason || 'ok');
            return `<div class="telemetry-summary-row ${statusClass}" title="requestId: ${escapeHtml(summary.requestId)}">
                <span class="telemetry-summary-time">${escapeHtml(time)}</span>
                <span class="telemetry-summary-platform">${platform}</span>
                <span class="telemetry-summary-status">${escapeHtml(status)}</span>
                <span class="telemetry-summary-phase">${escapeHtml(phaseText)}</span>
                <span class="telemetry-summary-reason">${reasonText}</span>
            </div>`;
        }).join('');
    };

    const buildTelemetryTypeOptions = (events = []) => {
        const types = new Set(['all', 'TIMING', 'COMPOSER', 'SEND', 'ERROR', 'INFO']);
        events.forEach((e) => {
            const type = (e?.type || '').toString().trim();
            if (type) types.add(type);
        });
        return Array.from(types);
    };

    const buildTelemetryPlatformOptions = (events = []) => {
        const selectedNames = resolveSelectedLlmNames();
        const options = [];
        const seen = new Set();
        const pushOption = (name) => {
            const label = String(name || '').trim();
            if (!label) return;
            const value = normalizePlatformName(label);
            if (!value || seen.has(value)) return;
            seen.add(value);
            options.push({ value, label });
        };
        if (selectedNames.length) {
            selectedNames.forEach(pushOption);
        }
        return options;
    };

    const getTelemetryFilteredEvents = (events = []) => {
        const selectedSet = getSelectedLlmSet();
        if (!selectedSet.size) {
            return { filtered: [], hasSelection: false };
        }
        const platformFilter = normalizePlatformName(telemetryPlatformSelect?.value || 'all');
        const typeFilter = normalizePlatformName(telemetryTypeSelect?.value || 'all');
        const presetFilter = (telemetryPresetSelect?.value || 'all').toLowerCase().trim();
        let filtered = Array.isArray(events) ? events.slice() : [];
        filtered = filtered.filter((event) => selectedSet.has(
            normalizePlatformName(event?.platform || event?.llmName)
        ));
        if (platformFilter !== 'all') {
            filtered = filtered.filter((event) => (
                normalizePlatformName(event?.platform || event?.llmName) === platformFilter
            ));
        }
        if (typeFilter !== 'all') {
            filtered = filtered.filter((event) => normalizePlatformName(event?.type) === typeFilter);
        }
        if (presetFilter && presetFilter !== 'all') {
            filtered = filtered.filter((event) => JSON.stringify(event).toLowerCase().includes(presetFilter));
        }
        filtered = filtered.slice(-250);
        return { filtered, hasSelection: true };
    };

    const groupTelemetryByPlatform = (events = []) => {
        const grouped = {};
        const orderedNames = [];
        const seen = new Set();
        const rememberName = (name) => {
            const label = String(name || '').trim() || 'unknown';
            const key = normalizePlatformName(label);
            if (!key || seen.has(key)) return;
            seen.add(key);
            orderedNames.push(label);
        };
        const selectedNames = resolveSelectedLlmNames();
        if (selectedNames.length) {
            selectedNames.forEach(rememberName);
        }
        (Array.isArray(events) ? events : []).forEach((event) => {
            rememberName(resolveTelemetryPlatformName(event));
        });
        orderedNames.forEach((name) => {
            grouped[`<${name}>`] = [];
        });
        (Array.isArray(events) ? events : []).forEach((event) => {
            const name = resolveTelemetryPlatformName(event);
            const tag = `<${name || 'unknown'}>`;
            if (!grouped[tag]) grouped[tag] = [];
            grouped[tag].push(event);
        });
        return grouped;
    };

    const syncTelemetryPlatformOptions = (events = []) => {
        if (!telemetryPlatformSelect) return;
        const current = telemetryPlatformSelect.value;
        const platformOptions = buildTelemetryPlatformOptions(events);
        const optionValues = ['all', ...platformOptions.map((opt) => opt.value)];
        telemetryPlatformSelect.innerHTML = [
            '<option value="all">All platforms</option>',
            ...platformOptions.map((opt) => (
                `<option value="${opt.value}">${escapeHtml(opt.label)}</option>`
            ))
        ].join('');
        telemetryPlatformSelect.value = optionValues.includes(current) ? current : 'all';
    };

    const syncTelemetryTypeOptions = (events = []) => {
        if (!telemetryTypeSelect) return;
        const currentType = telemetryTypeSelect.value;
        const selectedSet = getSelectedLlmSet();
        const typeSource = selectedSet.size
            ? (Array.isArray(events) ? events : []).filter((event) => selectedSet.has(
                normalizePlatformName(event?.platform || event?.llmName)
            ))
            : [];
        const types = buildTelemetryTypeOptions(typeSource);
        telemetryTypeSelect.innerHTML = types.map((t) => (
            `<option value="${t}">${t === 'all' ? 'All types' : t}</option>`
        )).join('');
        if (types.includes(currentType)) telemetryTypeSelect.value = currentType;
    };

    const renderTelemetry = (events = []) => {
        if (!telemetryTimeline) return;
        const { filtered, hasSelection } = getTelemetryFilteredEvents(events);
        telemetryFilteredCache = filtered;
        renderTelemetrySummary(filtered);
        if (!hasSelection) {
            if (telemetryStatus) {
                telemetryStatus.textContent = 'No selected models';
            }
            telemetryTimeline.innerHTML = '<p class="diag-empty">No selected models</p>';
            return;
        }
        if (telemetryStatus) {
            telemetryStatus.textContent = `${filtered.length} events`;
        }
        if (!filtered.length) {
            telemetryTimeline.innerHTML = '<p class="diag-empty">No telemetry events</p>';
            return;
        }
        telemetryTimeline.innerHTML = filtered.map((e) => {
            const ts = e.ts ? new Date(e.ts).toLocaleTimeString() : '';
            const platform = escapeHtml(String(e.platform || e.llmName || 'unknown'));
            const type = escapeHtml(String(e.type || 'EVENT'));
            const label = escapeHtml(String(e.label || '').trim());
            const details = escapeHtml(String(e.details || '').trim());
            const detailText = [label, details].filter(Boolean).join(' — ');
            const level = String(e.level || '').toLowerCase();
            const levelClass = level === 'error'
                ? 'is-error'
                : (level === 'warning' ? 'is-warning' : (level === 'success' ? 'is-success' : ''));
            return `<div class="telemetry-row ${levelClass}">
                <span class="telemetry-time">${ts}</span>
                <span class="telemetry-platform">${platform}</span>
                <span class="telemetry-type">${type}</span>
                <span class="telemetry-details">${detailText || '-'}</span>
            </div>`;
        }).join('');
    };

    const refreshTelemetry = () => {
        try {
            chrome.runtime.sendMessage({ type: 'GET_DIAG_EVENTS', limit: 400 }, (resp) => {
                if (resp?.success) {
                    telemetryCache = resp.events || [];
                    syncTelemetryPlatformOptions(telemetryCache);
                    syncTelemetryTypeOptions(telemetryCache);
                    renderTelemetry(telemetryCache);
                } else {
                    telemetryCache = [];
                    renderTelemetry([]);
                }
            });
        } catch (err) {
            console.warn('[devtools] telemetry refresh error', err);
            telemetryCache = [];
            renderTelemetry([]);
        }
    };

    telemetryRefreshBtn && telemetryRefreshBtn.addEventListener('click', refreshTelemetry);
    telemetryPresetSelect && telemetryPresetSelect.addEventListener('change', () => {
        if (telemetryPresetSelect.value && telemetryPresetSelect.value !== 'all') {
            if (telemetryTypeSelect) telemetryTypeSelect.value = 'all';
        }
        renderTelemetry(telemetryCache);
    });
    telemetryPlatformSelect && telemetryPlatformSelect.addEventListener('change', () => renderTelemetry(telemetryCache));
    telemetryTypeSelect && telemetryTypeSelect.addEventListener('change', () => renderTelemetry(telemetryCache));
    telemetryResetBtn && telemetryResetBtn.addEventListener('click', () => {
        if (telemetryPlatformSelect) telemetryPlatformSelect.value = 'all';
        if (telemetryTypeSelect) telemetryTypeSelect.value = 'all';
        if (telemetryPresetSelect) telemetryPresetSelect.value = 'all';
        renderTelemetry(telemetryCache);
    });
    telemetryExportJsonBtn && telemetryExportJsonBtn.addEventListener('click', () => {
        try {
            const { filtered } = getTelemetryFilteredEvents(telemetryCache);
            const exportEvents = telemetryFilteredCache.length ? telemetryFilteredCache : filtered;
            if (!exportEvents.length) return;
            const grouped = groupTelemetryByPlatform(exportEvents);
            const json = JSON.stringify(grouped, null, 2);
            if (!json || json === '{}') return;
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `telemetry-${Date.now()}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (err) {
            console.warn('[devtools] telemetry export json error', err);
        }
    });
    telemetryCopyBtn && telemetryCopyBtn.addEventListener('click', async () => {
        try {
            const { filtered } = getTelemetryFilteredEvents(telemetryCache);
            const copyEvents = telemetryFilteredCache.length ? telemetryFilteredCache : filtered;
            const text = copyEvents.map((e) => JSON.stringify(e)).join('\n');
            if (!text) return;
            await writeClipboardText(text, telemetryCopyBtn);
        } catch (err) {
            console.warn('[devtools] telemetry copy error', err);
        }
    });
    document.addEventListener('llm-selection-change', () => {
        syncTelemetryPlatformOptions(telemetryCache);
        syncTelemetryTypeOptions(telemetryCache);
        renderTelemetry(telemetryCache);
    });

    const telemetryTab = document.getElementById('telemetry-tab');
    telemetryTab && telemetryTab.addEventListener('click', refreshTelemetry);
    let telemetryAutoRefreshTimer = null;
    const startTelemetryAutoRefresh = () => {
        if (!telemetryTimeline) return;
        if (telemetryAutoRefreshTimer) return;
        refreshTelemetry();
        telemetryAutoRefreshTimer = setInterval(() => {
            refreshTelemetry();
        }, 2500);
    };
    const stopTelemetryAutoRefresh = () => {
        if (telemetryAutoRefreshTimer) {
            clearInterval(telemetryAutoRefreshTimer);
            telemetryAutoRefreshTimer = null;
        }
    };

    const isTelemetryTabActive = () => telemetryTab?.classList.contains('is-active');
    if (telemetryTimeline && isTelemetryTabActive()) {
        startTelemetryAutoRefresh();
    }

    const devtoolsTabs = Array.from(document.querySelectorAll('.devtools-tab'));
    devtoolsTabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            if (telemetryTab && telemetryTimeline) {
                if (tab === telemetryTab) {
                    startTelemetryAutoRefresh();
                } else if (!isTelemetryTabActive()) {
                    stopTelemetryAutoRefresh();
                }
            }
        });
    });
    const telemetryCardToggle = (card, header) => {
        const collapsed = card.classList.contains('is-collapsed');
        const nextCollapsed = !collapsed;
        card.classList.toggle('is-collapsed', nextCollapsed);
        const expanded = !nextCollapsed;
        if (header) {
            header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            header.setAttribute('title', expanded ? 'Double-click to collapse' : 'Double-click to expand');
        }
    };

    const setupTelemetryCollapsibles = () => {
        const collapsibleCards = Array.from(document.querySelectorAll('#telemetry-tabpanel .devtools-card[data-collapsible]'));
        collapsibleCards.forEach((card) => {
            const header = card.querySelector('.devtools-card-header');
            if (!header) return;
            header.setAttribute('role', 'button');
            header.setAttribute('tabindex', '0');
            const isCollapsed = card.classList.contains('is-collapsed');
            header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
            header.addEventListener('dblclick', () => telemetryCardToggle(card, header));
        });
    };

    setupTelemetryCollapsibles();
})();
