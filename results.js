// Prevent double-init when the page is opened or injected twice
if (window.__RESULTS_PAGE_LOADED) {
    console.warn('[RESULTS] Initialization skipped: already loaded');
} else {
    window.__RESULTS_PAGE_LOADED = true;

document.addEventListener('DOMContentLoaded', async () => {
    const shared = window.ResultsShared || {};
    const {
        escapeHtml = (s = '') => String(s),
        stripHtmlToPlainText = (html = '') => String(html),
        buildResponseCopyHtmlBlock = () => '',
        wrapResponsesHtmlBundle = (sections = '') => sections,
        fallbackCopyViaTextarea = () => {},
        flashButtonFeedback = () => {},
        writeRichContentToClipboard = async () => {}
    } = shared;
    //-- 2.1. Логика для переключения и сохранения состояния Pro-режима --//
    const proLink = document.getElementById('pro-header');
    const proModeStorageKey = 'llmComparatorProModeActive';

    //-- 2.2. Улучшенная логика переключения Pro: помимо pro-features-hidden, ставим явный флаг pro-active --//
const updateProModeUI = (isActive) => {
    // Сохраняем существующую логику скрытия/показа секций (обратная семантика — ok)
    document.body.classList.toggle('pro-features-hidden', !isActive);

    // Добавляем явный флаг активности Pro — удобнее для CSS и будущих селекторов
    document.body.classList.toggle('pro-active', isActive);

    // Обновляем атрибут состояния кнопки (доступность)
    proLink.setAttribute('aria-pressed', String(isActive));
};

    const storedData = await new Promise(resolve => {
        chrome.storage.local.get(proModeStorageKey, data => resolve(data));
    });

    let isProModeActive = storedData[proModeStorageKey] || false;
    updateProModeUI(isProModeActive);

    proLink.addEventListener('click', (event) => {
        event.preventDefault();
        isProModeActive = !isProModeActive;
        chrome.storage.local.set({ [proModeStorageKey]: isProModeActive });
        updateProModeUI(isProModeActive);
    });
//-- Конец блока 2.1 --//
    const deriveOutputLabel = (element) => {
        const panelTitle = element.closest('.llm-panel')?.querySelector('.llm-title');
        if (panelTitle && panelTitle.textContent) {
            return panelTitle.textContent.trim();
        }
        const columnTitle = element.closest('.response-column')?.querySelector('h3');
        if (columnTitle && columnTitle.textContent) {
            return columnTitle.textContent.trim();
        }
        return '';
    };

    const DEFAULT_PANEL_OUTPUT_MAX_HEIGHT = '315px';
    const EXPANDED_PANEL_OUTPUT_MAX_HEIGHT = '400px';

    // Применение стилей к панелям вывода после инициализации
    const outputElements = document.querySelectorAll('.llm-panel .output, .response-content');
    outputElements.forEach(el => {
        el.style.maxHeight = DEFAULT_PANEL_OUTPUT_MAX_HEIGHT;
        el.style.overflowY = 'auto';
        el.style.overflowX = 'hidden';
        el.style.wordWrap = 'break-word';
        el.setAttribute('contenteditable', 'true');
        el.setAttribute('spellcheck', 'true');
        el.setAttribute('data-placeholder', 'Click to add or edit response');
        el.dataset.defaultMaxHeight = DEFAULT_PANEL_OUTPUT_MAX_HEIGHT;
        const label = deriveOutputLabel(el);
        const ariaLabel = label ? `${label} response (editable)` : 'Model response (editable)';
        el.setAttribute('aria-label', ariaLabel);
        el.addEventListener('input', () => {
            checkCompareButtonState();
        });
    });
    
    // --- PROMPT LOADING ---
    const DEFAULT_JUDGE_SYSTEM_PROMPTS = [
        {
            id: 'interaction_meta_synthesis',
            label: 'Meta-Синтез',
            text: 'Твоя задача — создать собственное, оригинальное решение на основе твоего профессионального суждения.\nПроанализируй все представленные версии как исходный материал, но не компилируй их. Вместо этого:\n - Сформируй своё видение правильного решения проблемы\n - Критически оцени каждое замечание на фактическую точность и релевантность\n - Извлеки ценные инсайты из разных версий, которые усиливают твоё решение\n - Отбрось слабые идеи, даже если они присутствуют во всех версиях\n - Синтезируй новый ответ, который отражает твоё понимание того, как это должно быть сделано правильно\nЭто не консенсус между версиями и не их пересказ. Это твоё собственное экспертное решение, информированное анализом предложенных вариантов.',
            order: 101
        },
        {
            id: 'interaction_critical_audit',
            label: 'Критический аудит',
            text: 'Проведи критический аудит всех ответов с позиции эксперта, выявляя то, что другие пропустили.\n1. Слепые зоны (что никто не увидел):\n - Какие важные аспекты задачи полностью проигнорированы всеми?\n - Какие очевидные (для эксперта) следствия не проговорены?\n2. Систематические ошибки (что делают неправильно):\n - Фактические неточности или устаревшая информация\n - Логические противоречия внутри ответов\n - Неверные причинно-следственные связи\n - Поверхностное понимание вместо глубокого анализа\n3. Методологические провалы (как подошли неправильно):\n - Какие критерии оценки должны были применить, но не применили?\n - Где использован неподходящий фреймворк?\n - Какие ограничения/риски решения не учтены?\n4. Формат: Каждый пункт начинай с конкретного примера, затем обобщай паттерн.\nБез вступлений, прямо к сути.',
            order: 102
        },
        {
            id: 'interaction_select_ideas',
            label: 'Select ideas',
            text: 'Извлеки все уникальные идеи из материала — даже те, которые кажутся тебе слабыми или спорными.\n1. Атомизируй содержание: раздроби каждый ответ на минимальные смысловые единицы (одна идея = один пункт)\n2. Дедупликация с сохранением нюансов:\n - Объедини идеи, если они идентичны по сути (просто разная формулировка или примеры)\n - Сохрани отдельно, если есть хоть малейшее смысловое отличие в подходе, акценте или контексте\n3. Выдай нумерованный список, ранжированный по твоей экспертной оценке значимости. Начни сразу с пункта 1 — без вступлений, пояснений или метакомментариев.',
            order: 103
        },
        {
            id: 'interaction_pattern_clustering',
            label: 'Clustering',
            text: 'Проанализируй идеи через призму их функциональной логики и создай смысловую карту.\n1. Выяви паттерны: Какие идеи атакуют одну проблему с разных сторон? Какие отражают принципиально разные философии решения?\n2. Сформируй кластеры по общему знаменателю (не по формальным признакам, а по сути подхода)\n3. Назови каждый кластер концептуально — так, чтобы название раскрывало суть парадигмы, а не просто описывало содержимое\n4. Структурируй вывод\n - Название кластера (жирным)\n - Краткая суть подхода (1 предложение)\n - Список идей, входящих в него\n\nНачинай без преамбулы.',
            order: 104
        }
    ];
    let prompts = {};

    async function loadPrompts() {
        try {
            const response = await fetch(chrome.runtime.getURL('prompts.json'));
            if (!response.ok) {
                throw new Error(`Failed to fetch prompts: ${response.statusText}`);
            }
            prompts = await response.json();
            console.log('[RESULTS] Prompts loaded successfully:', prompts);
        } catch (error) {
            console.error('[RESULTS] Could not load prompts.json:', error);
            // Используем дефолтный шаблон вместо текста ошибки
            prompts = {
                shortModeSuffix: "\n\nProvide a very short and concise answer.",
                evaluationTemplate: "Compare the following responses to the question: \"{originalPrompt}\".\n\nResponses for analysis:\n\n{responsesList}\n\nSelect the best response, briefly explain why, and present the result as a detailed, structured bulleted list. The evaluation must be comprehensive, considering relevance, detail, usefulness, and accuracy.",
                judgeSystemPrompts: DEFAULT_JUDGE_SYSTEM_PROMPTS
            };
            console.log('[RESULTS] Using default evaluation template');
        }
    }
    
    await loadPrompts();

    let judgeSystemPrompts = Array.isArray(prompts.judgeSystemPrompts) && prompts.judgeSystemPrompts.length
        ? prompts.judgeSystemPrompts.slice()
        : DEFAULT_JUDGE_SYSTEM_PROMPTS.slice();

    let lastEvaluationPromptNormalized = '';
    let lastEvaluationPrefixNormalized = '';
    let lastEvaluationSuffixNormalized = '';
    let lastResponsesListNormalized = '';
    let pendingJudgeAnswer = '';
    let pendingJudgeHTML = '';
    const llmResponseMetadata = Object.create(null);

    function mergeLLMMetadata(llmName, patch = {}, options = {}) {
        if (!llmName) return;
        const shouldReset = options.reset === true;
        const base = shouldReset ? {} : { ...(llmResponseMetadata[llmName] || {}) };
        Object.entries(patch || {}).forEach(([key, value]) => {
            if (typeof value === 'undefined') {
                return;
            }
            base[key] = value;
        });
        llmResponseMetadata[llmName] = base;
    }

    function formatResponseTimestamp(timestamp) {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) return '';
        const pad = (value) => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}`;
    }

    function buildMetadataLine(llmName) {
        const meta = llmResponseMetadata[llmName];
        if (!meta) return '';
        const timestamp = formatResponseTimestamp(meta.completedAt || meta.createdAt);
        const url = (meta.url || '').trim();
        if (!timestamp && !url) return '';
        return [timestamp, url].filter(Boolean).join('  ');
    }

    function resolveResponseSource(llmName) {
        const meta = llmResponseMetadata[llmName] || {};
        const url = String(meta.url || '').trim();
        const timestamp = meta.completedAt || meta.createdAt || null;
        return {
            url: url || location.href,
            timestamp: typeof timestamp === 'number' ? timestamp : Date.now()
        };
    }

    const promptPasteBlockSelector = [
        'p',
        'div',
        'section',
        'article',
        'header',
        'footer',
        'main',
        'nav',
        'aside',
        'blockquote',
        'pre',
        'ul',
        'ol',
        'li',
        'table',
        'thead',
        'tbody',
        'tfoot',
        'tr',
        'td',
        'th',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'figure',
        'figcaption'
    ].join(',');

    const getListDepth = (node) => {
        let depth = 0;
        let current = node?.parentElement || null;
        while (current) {
            if (current.tagName === 'UL' || current.tagName === 'OL') {
                depth += 1;
            }
            current = current.parentElement;
        }
        return Math.max(0, depth - 1);
    };

    const getListPrefix = (node) => {
        const parent = node?.parentElement || null;
        if (!parent) return '- ';
        if (parent.tagName === 'OL') {
            const items = Array.from(parent.children || []).filter((child) => child.tagName === 'LI');
            const index = items.indexOf(node);
            if (index >= 0) {
                return `${index + 1}. `;
            }
        }
        return '- ';
    };

    const plainTextFromHtml = (html) => {
        if (!html) return '';
        const container = document.createElement('div');
        container.innerHTML = html;
        container.querySelectorAll('script, style, noscript').forEach((node) => node.remove());
        container.querySelectorAll('br').forEach((node) => node.replaceWith('\n'));
        container.querySelectorAll('li').forEach((node) => {
            const indent = '  '.repeat(getListDepth(node));
            node.insertAdjacentText('afterbegin', `${indent}${getListPrefix(node)}`);
        });
        container.querySelectorAll(promptPasteBlockSelector).forEach((node) => {
            node.insertAdjacentText('beforebegin', '\n');
            node.insertAdjacentText('afterend', '\n');
        });
        let text = container.textContent || '';
        text = text.replace(/\u00a0/g, ' ');
        text = text.replace(/\r\n/g, '\n');
        text = text.replace(/[ \t]+\n/g, '\n');
        text = text.replace(/\n[ \t]+/g, '\n');
        text = text.replace(/\n{3,}/g, '\n\n');
        return text.trim();
    };

    const sanitizeInlineHtml = (html) => {
        if (!html) return '';
        const container = document.createElement('div');
        container.innerHTML = html;
        container.querySelectorAll('script, style, noscript').forEach((node) => node.remove());
        container.querySelectorAll('*').forEach((node) => {
            Array.from(node.attributes || []).forEach((attr) => {
                if (/^on/i.test(attr.name)) {
                    node.removeAttribute(attr.name);
                }
                const attrName = attr.name.toLowerCase();
                if (attrName === 'style') {
                    const cleaned = (attr.value || '')
                        .split(';')
                        .map((part) => part.trim())
                        .filter((part) => part && !part.toLowerCase().startsWith('text-align'))
                        .join('; ');
                    if (cleaned) {
                        node.setAttribute('style', cleaned);
                    } else {
                        node.removeAttribute('style');
                    }
                }
                if (attrName === 'align') {
                    node.removeAttribute('align');
                }
            });
        });
        return container.innerHTML;
    };

    const buildHtmlFromText = (text) => escapeHtml(String(text || '')).replace(/\n/g, '<br>');

    const looksLikeHtml = (value) =>
        /<(?:p|div|span|pre|code|br|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|blockquote|h[1-6])\b/i.test(String(value || ''));

    const insertTextAtCursor = (input, text) => {
        if (!input) return;
        const value = input.value || '';
        const start = typeof input.selectionStart === 'number' ? input.selectionStart : value.length;
        const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : value.length;
        const nextValue = value.slice(0, start) + text + value.slice(end);
        input.value = nextValue;
        const nextPos = start + text.length;
        input.setSelectionRange(nextPos, nextPos);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    };


const layoutModifierMasonry = () => {
    document.querySelectorAll('.modifier-cards-wrapper').forEach(wrapper => {
        const styles = window.getComputedStyle(wrapper);
        const rowHeight = parseFloat(styles.getPropertyValue('grid-auto-rows')) || 1;
        const rowGap = parseFloat(styles.getPropertyValue('row-gap')) || 0;
        wrapper.querySelectorAll('.modifier-group-card').forEach(card => {
            card.style.gridRowEnd = 'span 1';
            const cardHeight = card.offsetHeight + rowGap;
            const span = Math.max(1, Math.ceil(cardHeight / (rowHeight + rowGap)));
            card.style.gridRowEnd = `span ${span}`;
        });
    });
};

const updateModifierGroupHighlights = () => {
    document.querySelectorAll('.modifier-group-card').forEach(card => {
        const title = card.querySelector('.modifier-group-title');
        if (!title) return;
        const hasSelection = Array.from(card.querySelectorAll('input[type="checkbox"]')).some(cb => cb.checked);
        title.classList.toggle('has-selection', hasSelection);
    });
};

//-- 3.1. Полностью переработанная функция рендеринга с разделением на основные/второстепенные категории --//
//-- 2.1. Новая функция рендеринга с логикой "3 видимых" и "аккордеон" --//
//-- 2.1. Финальная версия функции рендеринга с усечением и title --//
function renderModifiersRow(modifiers) {
    const primaryPrefixContainer = document.getElementById('prefix-cards-container');
    const secondaryPrefixContainer = document.getElementById('secondary-prefix-cards-container');
    const primarySuffixContainer = document.getElementById('suffix-cards-container');
    const secondarySuffixContainer = document.getElementById('secondary-suffix-cards-container');

    if (!primaryPrefixContainer || !secondaryPrefixContainer || !primarySuffixContainer || !secondarySuffixContainer) return;
    
    [primaryPrefixContainer, secondaryPrefixContainer, primarySuffixContainer, secondarySuffixContainer].forEach(c => c.innerHTML = '');

    const groups = modifiers.reduce((acc, mod) => { 
        const groupKey = mod.exclusiveGroup || `single-${mod.id}`;
        if (!acc[groupKey]) acc[groupKey] = [];
        acc[groupKey].push(mod);
        return acc;
    }, {});

    const renderGroupsToContainer = (container, groupsToRender) => {
        groupsToRender.forEach(group => {
            const isAccordion = group.some(mod => mod.isSecondary);
            const card = document.createElement('div');
            card.className = 'modifier-group-card';
            
            const title = document.createElement('h4');
            title.className = 'modifier-group-title';
            const groupHasSelection = group.some(mod => selectedModifierIds.includes(mod.id));
            
            const fullGroupLabel = group[0].groupLabel || '';
            if (fullGroupLabel.length > 15) {
                title.textContent = fullGroupLabel.substring(0, 15) + '…';
            } else {
                title.textContent = fullGroupLabel;
            }
            title.title = fullGroupLabel;
            title.dataset.tooltip = fullGroupLabel;
            registerTooltipTarget(title);
            
            title.classList.toggle('has-selection', groupHasSelection);

            const optionsContainer = document.createElement('div');
            optionsContainer.className = 'modifier-options';

            group.forEach((mod, index) => {
            const label = document.createElement('label');
            label.className = 'modifier-checkbox-label';
            const tooltipText = getEffectiveModifierText(mod) || mod.id;
            label.dataset.placeholder = (mod.placeholder || '').trim();

            if (!isAccordion && index >= 3) {
                label.classList.add('is-hidden');
            }

                const input = document.createElement('input');
                input.type = 'checkbox';
                input.dataset.modId = mod.id;
                input.checked = selectedModifierIds.includes(mod.id);

                input.addEventListener('change', () => {
                    const currentModId = mod.id;
                    const isChecked = input.checked;

                    // Ограничиваем взаимоисключение только в рамках подкатегории;
                    // если subgroup === null/undefined, разрешаем множественный выбор внутри категории.
                    const subgroup = mod.subgroup;
                    const enforceExclusivity = mod.exclusiveGroup && subgroup !== null && subgroup !== undefined && subgroup !== '';
                    if (enforceExclusivity) {
                        group.forEach(gMod => {
                            const sameSubgroup = gMod.subgroup === subgroup;
                            if (gMod.id !== currentModId && sameSubgroup) {
                                selectedModifierIds = selectedModifierIds.filter(id => id !== gMod.id);
                                resetModifierOverride(gMod.id);
                            }
                        });
                    }

                    selectedModifierIds = selectedModifierIds.filter(id => id !== currentModId);
                    if (isChecked) {
                        selectedModifierIds.push(currentModId);
                    } else {
                        resetModifierOverride(currentModId);
                    }
                    
                    document.querySelectorAll('#modifiers-container input[type="checkbox"]').forEach(cb => {
                        cb.checked = selectedModifierIds.includes(cb.dataset.modId);
                    });

                    persistModifierSelections();
                    renderActiveModifiers();
                    updateModifierGroupHighlights();
                    requestAnimationFrame(layoutModifierMasonry);
            });
            label.addEventListener('mouseenter', () => {
                adjustModifierTooltipPosition(label);
                hoveredModifierId = mod.id;
                updatePromptPlaceholder();
            });
            label.addEventListener('mouseleave', () => {
                if (hoveredModifierId === mod.id) {
                    hoveredModifierId = null;
                    updatePromptPlaceholder();
                }
                label.style.removeProperty('--tooltip-shift');
            });

            const span = document.createElement('span');
            const fullModLabel = mod.label || mod.id;
            if (fullModLabel.length > 15) {
                span.textContent = fullModLabel.substring(0, 14) + '…';
            } else {
                span.textContent = fullModLabel;
            }
            span.title = fullModLabel;

            const tooltip = document.createElement('div');
            tooltip.className = 'modifier-tooltip';
            const tooltipTitle = document.createElement('div');
            tooltipTitle.className = 'modifier-tooltip-title';
            tooltipTitle.textContent = fullModLabel;
            tooltip.appendChild(tooltipTitle);

            if (tooltipText) {
                const tooltipBody = document.createElement('div');
                tooltipBody.className = 'modifier-tooltip-body';
                tooltipBody.textContent = tooltipText;
                tooltip.appendChild(tooltipBody);
            }

                label.appendChild(input);
                label.appendChild(span);
                label.appendChild(tooltip);
                optionsContainer.appendChild(label);
            });
            
            if (title.textContent) card.appendChild(title);
            card.appendChild(optionsContainer);
            
            const collapseBtn = document.createElement('button');
            collapseBtn.className = 'show-more-btn';
            title.appendChild(collapseBtn);

            if (isAccordion) {
                card.classList.add('is-collapsible', 'is-collapsed');
                title.addEventListener('click', () => {
                    card.classList.toggle('is-collapsed');
                    requestAnimationFrame(layoutModifierMasonry);
                });
            } else {
                if (group.length > 3) {
                    card.classList.add('is-expandable');
                    title.addEventListener('click', () => {
                        card.classList.toggle('is-expanded');
                        requestAnimationFrame(layoutModifierMasonry);
                    });
                } else {
                    collapseBtn.style.display = 'none';
                }
            }
            container.appendChild(card);
        });
    };

    const allGroups = Object.values(groups);
    const primaryGroups = allGroups.filter(g => !g.some(m => m.isSecondary));
    const secondaryGroups = allGroups.filter(g => g.some(m => m.isSecondary));

    const isPrefix = (g) => g.some(m => ['prefix', 'wrap'].includes(m.type));
    const isSuffix = (g) => g.some(m => m.type === 'suffix');

    renderGroupsToContainer(primaryPrefixContainer, primaryGroups.filter(isPrefix));
    renderGroupsToContainer(secondaryPrefixContainer, secondaryGroups.filter(isPrefix));
    renderGroupsToContainer(primarySuffixContainer, primaryGroups.filter(isSuffix));
    renderGroupsToContainer(secondarySuffixContainer, secondaryGroups.filter(isSuffix));
    requestAnimationFrame(layoutModifierMasonry);
    updateModifierGroupHighlights();
}
    const getDefaultModifierText = (mod = {}) => {
        if (!mod) return '';
        return (mod.text || '')
            .replace(/\{USER_PROMPT\}/gi, '')
            .replace(/Prompt:/gi, '')
            .replace(/\\n/g, '\n')
            .trim();
    };

    const getEffectiveModifierText = (mod = {}) => {
        if (!mod) return '';
        const override = modifierCustomText[mod.id];
        if (typeof override === 'string') {
            const trimmed = override.trim();
            if (trimmed) return trimmed;
        }
        return getDefaultModifierText(mod);
    };

    const resetModifierOverride = (modId) => {
        if (modId && Object.prototype.hasOwnProperty.call(modifierCustomText, modId)) {
            delete modifierCustomText[modId];
        }
    };

//-- 3.4. Новая функция для рендеринга "чипов" и обработчик их удаления --//
function renderActiveModifiers() {
    const prefixContainer = document.getElementById('prefix-container');
    const suffixContainer = document.getElementById('suffix-container');

    if (!prefixContainer || !suffixContainer) return;

    // Очищаем контейнеры перед рендерингом
    prefixContainer.innerHTML = '';
    suffixContainer.innerHTML = '';

    // Проходимся по упорядоченному массиву ID
    selectedModifierIds.forEach(modId => {
        const mod = modifiersById[modId];
        if (!mod) return;

        // Создаем "чип"
        const chip = document.createElement('div');
        chip.className = 'modifier-chip';
        if (mod.type === 'suffix') {
            chip.classList.add('modifier-chip-suffix');
        } else {
            chip.classList.add('modifier-chip-prefix');
        }

        const chipContent = document.createElement('div');
        chipContent.className = 'chip-content';

        const chipTitle = document.createElement('span');
        chipTitle.className = 'chip-modifier-title';
        chipTitle.textContent = `${mod.label || mod.id}:`;

        const chipText = document.createElement('span');
        chipText.className = 'chip-modifier-text';
        chipText.contentEditable = 'true';
        chipText.spellcheck = false;
        chipText.dataset.modId = mod.id;

        //-- 1.1. Финальная, надежная очистка текста перед отображением --//
        chipText.textContent = getEffectiveModifierText(mod) || mod.id;

        chipText.addEventListener('input', () => {
            modifierCustomText[mod.id] = chipText.textContent || '';
        });
        chipText.addEventListener('blur', () => {
            const current = (chipText.textContent || '').trim();
            if (!current) {
                resetModifierOverride(mod.id);
                chipText.textContent = getEffectiveModifierText(mod) || mod.id;
            } else {
                modifierCustomText[mod.id] = current;
            }
        });
        chipText.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                chipText.blur();
            }
        });

        const tooltip = document.createElement('div');
        tooltip.className = 'modifier-tooltip modifier-chip-tooltip';
        const tooltipTitle = document.createElement('div');
        tooltipTitle.className = 'modifier-tooltip-title';
        tooltipTitle.textContent = mod.label || mod.id;
        tooltip.appendChild(tooltipTitle);
        const tooltipBody = document.createElement('div');
        tooltipBody.className = 'modifier-tooltip-body';
        tooltipBody.textContent = getEffectiveModifierText(mod) || mod.id;
        tooltip.appendChild(tooltipBody);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'chip-remove-btn';
        removeBtn.innerHTML = '&times;';
        removeBtn.title = 'Remove this modifier';
        removeBtn.dataset.modId = modId; // Важно для удаления

        chipContent.appendChild(chipTitle);
        chipContent.appendChild(chipText);
        chip.appendChild(chipContent);
        chip.appendChild(tooltip);
        chip.appendChild(removeBtn);

        chip.addEventListener('mouseenter', () => {
            adjustModifierTooltipPosition(chip);
        });
        chip.addEventListener('mouseleave', () => {
            chip.style.removeProperty('--tooltip-shift');
        });
        chip.addEventListener('dblclick', (event) => {
            if (event.target.closest('.chip-remove-btn')) return;
            chip.classList.toggle('is-expanded');
        });

        // Добавляем "чип" в нужный контейнер
        if (mod.type === 'prefix' || mod.type === 'wrap') {
            prefixContainer.appendChild(chip);
        } else if (mod.type === 'suffix') {
            suffixContainer.appendChild(chip);
        }
    });
    updateModifierHeaders();
    updatePromptPlaceholder();
}

function updateModifierHeaders() {
    if (!prefixToggleLabel && !suffixToggleLabel) return;
    let hasPrefix = false;
    let hasSuffix = false;
    let hasAny = false;

    if (selectedModifierIds && selectedModifierIds.length > 0) {
        hasAny = true;
        selectedModifierIds.forEach(modId => {
            const mod = modifiersById[modId];
            if (!mod) return;
            if (mod.type === 'suffix') {
                hasSuffix = true;
            } else if (mod.type === 'prefix' || mod.type === 'wrap') {
                hasPrefix = true;
            }
        });
    }

    if (prefixToggleLabel) {
        prefixToggleLabel.classList.toggle('active', hasAny);
    }
    if (suffixToggleLabel) {
        suffixToggleLabel.classList.toggle('active', hasSuffix);
    }
}

// Handler for diagnostics "Copy all logs" button
document.addEventListener('click', async (event) => {
    const btn = event.target.closest('#copy-diagnostics-logs');
    if (!btn) return;

    const selectedModels = getSelectedLLMs();
    const sources = selectedModels.filter((name) => (llmLogs[name] || []).length);
    if (!sources.length) {
        flashButtonFeedback(btn, 'warn');
        return;
    }

    const combined = sources.map(name => {
        const entries = llmLogs[name] || [];
        const body = entries.map(e => {
            const time = formatDiagTimestamp(e.ts);
            const label = e.label || '';
            const details = e.details ? ` – ${e.details}` : '';
            return `[${time}] ${label}${details}`;
        }).join('\n');
        return `<Logs ${name}>\n${body}\n</>`;
    }).join('\n\n');

    try {
        if (navigator.clipboard && combined) {
            await navigator.clipboard.writeText(combined);
            flashButtonFeedback(btn, 'success');
        }
    } catch (err) {
        console.error('[Diagnostics Copy All] error', err);
        flashButtonFeedback(btn, 'error');
    }
});

let hoveredModifierId = null;

function determineModifierPlaceholder() {
    if (hoveredModifierId) {
        const hovered = modifiersById[hoveredModifierId];
        if (hovered && typeof hovered.placeholder === 'string') {
            const trimmed = hovered.placeholder.trim();
            if (trimmed) return trimmed;
        }
    }
    if (!Array.isArray(selectedModifierIds) || !selectedModifierIds.length) {
        return '';
    }
    for (let i = selectedModifierIds.length - 1; i >= 0; i--) {
        const modId = selectedModifierIds[i];
        const mod = modifiersById[modId];
        if (!mod || typeof mod.placeholder !== 'string') continue;
        const trimmed = mod.placeholder.trim();
        if (trimmed) return trimmed;
    }
    return '';
}

function updatePromptPlaceholder(forceDefault = false) {
    if (!promptInput) return;
    let nextPlaceholder;
    if (forceDefault) {
        nextPlaceholder = defaultPromptPlaceholder;
    } else {
        const candidate = determineModifierPlaceholder();
        nextPlaceholder = candidate || defaultPromptPlaceholder;
    }
    if (promptInput.getAttribute('placeholder') !== nextPlaceholder) {
        promptInput.setAttribute('placeholder', nextPlaceholder);
    }
}

function adjustModifierTooltipPosition(labelEl) {
    if (!labelEl) return;
    const tooltipEl = labelEl.querySelector('.modifier-tooltip');
    if (!tooltipEl) return;
    const rect = labelEl.getBoundingClientRect();
    const tooltipRect = tooltipEl.getBoundingClientRect();
    let tooltipWidth = tooltipRect.width;
    if (!tooltipWidth) {
        const computed = window.getComputedStyle(tooltipEl);
        tooltipWidth = parseFloat(computed.width) || parseFloat(computed.maxWidth) || 320;
    }
    tooltipWidth = Math.min(tooltipWidth || 320, window.innerWidth * 0.7);
    const margin = 12;
    const halfWidth = tooltipWidth / 2;
    const center = rect.left + rect.width / 2;
    let shift = 0;
    if (center - halfWidth < margin) {
        shift = margin - (center - halfWidth);
    } else if (center + halfWidth > window.innerWidth - margin) {
        shift = (window.innerWidth - margin) - (center + halfWidth);
    }
    labelEl.style.setProperty('--tooltip-shift', `${shift}px`);

    const tooltipHeight = tooltipRect.height || tooltipEl.offsetHeight || 0;
    const spaceAbove = rect.top;
    const topMargin = 12;
    const needsFlip = tooltipHeight && (spaceAbove - tooltipHeight - topMargin < 0);
    if (needsFlip) {
        tooltipEl.dataset.position = 'below';
    } else {
        delete tooltipEl.dataset.position;
    }
}

//-- 2.1. Исправляем селектор и подтверждаем отправку события 'change' --//
// Делегированный обработчик для кнопок удаления "чипов"
document.addEventListener('click', (event) => {
    const removeBtn = event.target.closest('.chip-remove-btn');
    if (!removeBtn) return;

    const modId = removeBtn.dataset.modId;
    if (!modId) return;

    // Находим соответствующий чекбокс в правильном контейнере (#modifiers-container)
        const checkbox = document.querySelector(`#modifiers-container input[data-mod-id="${modId}"]`);
    if (checkbox) {
        checkbox.checked = false;
        // Искусственно вызываем событие 'change', которое теперь будет поймано нужным обработчиком
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }
    resetModifierOverride(modId);
});

    async function loadSystemTemplates() {
        try {
            const indexResponse = await fetch(chrome.runtime.getURL('system_templates/index.json'));
            if (!indexResponse.ok) throw new Error('System template index not found.');

            const templateFiles = await indexResponse.json();

            const fetchPromises = templateFiles.map(file =>
                fetch(chrome.runtime.getURL(`system_templates/${file}`)).then(res => res.json())
            );

            const loadedTemplates = await Promise.all(fetchPromises);

            systemTemplates = { templates: {}, variables: {} };

            loadedTemplates.forEach(data => {
                Object.assign(systemTemplates.templates, data.templates);
                Object.assign(systemTemplates.variables, data.variables);
            });

            updateSystemTemplatesList();
            console.log('[RESULTS] System templates loaded successfully:', systemTemplates);

        } catch (error) {
            console.error('[RESULTS] Could not load system templates:', error);
        }
    }

        // --- MODIFIERS LOADING ---
        let modifiersDefaults = [];
        let userModifiers = [];
        //-- 3.1. Меняем Set на Array для сохранения порядка выбора --//
        let selectedModifierIds = []; // сохраняем выбранные
        let modifiersById = {};
        const modifierCustomText = {};
        let modifierPresetSelect = null;
        let modifierPresets = [];
        let modifierSelectionsMap = {};
        let currentModifierPresetId = 'base';
        let modifierPresetSelectBound = false;
        const MODIFIER_PRESET_STORAGE_KEY = 'llmComparatorModifierPreset';
        const MODIFIER_SELECTIONS_STORAGE_KEY = 'llmComparatorSelectedByPreset';

        const clearModifierOverrides = () => {
            Object.keys(modifierCustomText).forEach((key) => delete modifierCustomText[key]);
        };

        const clearAllSelectedModifiers = () => {
            if (!selectedModifierIds.length) return;
            selectedModifierIds = [];
            clearModifierOverrides();
            document.querySelectorAll('input[data-mod-id]').forEach(cb => {
                cb.checked = false;
            });
            renderActiveModifiers();
            persistModifierSelections();
            updateModifierGroupHighlights();
            updatePromptPlaceholder();
        };

        const getModifierPresetMeta = (presetId) => {
            if (Array.isArray(modifierPresets) && modifierPresets.length) {
                return modifierPresets.find((preset) => preset.id === presetId) || modifierPresets[0];
            }
            return { id: 'base', label: 'Базовый набор', file: 'modifiers.json' };
        };

        const updateModifierSectionLabels = () => {
            const prefixLabelTextEl = document.querySelector('.modifiers-toggle-label-console');
            const suffixLabelTextEl = document.querySelector('.modifiers-toggle-label-pro');
            if (prefixLabelTextEl) {
                prefixLabelTextEl.textContent = 'Tuning Console';
            }
            if (suffixLabelTextEl) {
                suffixLabelTextEl.textContent = 'LLM Stream';
            }
        };

        const persistModifierSelections = () => {
            if (!currentModifierPresetId) return;
            if (!modifierSelectionsMap || typeof modifierSelectionsMap !== 'object') {
                modifierSelectionsMap = {};
            }
            modifierSelectionsMap[currentModifierPresetId] = [...selectedModifierIds];
            chrome.storage.local.set({
                [MODIFIER_SELECTIONS_STORAGE_KEY]: modifierSelectionsMap,
                llmComparatorSelected: selectedModifierIds
            });
        };

        async function loadModifiers(presetId = currentModifierPresetId) {
            try {
                const presetMeta = getModifierPresetMeta(presetId);
                currentModifierPresetId = presetMeta.id;
                updateModifierSectionLabels();
                const presetSelectEl = modifierPresetSelect || document.getElementById('modifier-preset-select');
                if (presetSelectEl) {
                    modifierPresetSelect = presetSelectEl;
                    modifierPresetSelect.value = currentModifierPresetId;
                }

                const presetFile = presetMeta.file || 'modifiers.json';
                const presetPath = presetFile.startsWith('Modifiers/') ? presetFile : `Modifiers/${presetFile}`;
                const resp = await fetch(chrome.runtime.getURL(presetPath));
                if (!resp.ok) throw new Error(`${presetPath} not found`);
                modifiersDefaults = await resp.json();

                // Подгружаем пользовательские (если уже есть)
                const stored = await new Promise(resolve =>
                    chrome.storage.local.get(['llmComparatorModifiers', 'llmComparatorSelected', MODIFIER_SELECTIONS_STORAGE_KEY], resolve)
                );

                userModifiers = Array.isArray(stored.llmComparatorModifiers) ? stored.llmComparatorModifiers : [];
                modifierSelectionsMap = stored[MODIFIER_SELECTIONS_STORAGE_KEY] && typeof stored[MODIFIER_SELECTIONS_STORAGE_KEY] === 'object'
                    ? stored[MODIFIER_SELECTIONS_STORAGE_KEY]
                    : {};

                // Мердж по id: приоритет у userModifiers (могут перезаписать text/label/type)
                const map = new Map();
                [...modifiersDefaults, ...userModifiers].forEach(m => map.set(m.id, m));
                const merged = [...map.values()].sort((a,b) => (a.order||999)-(b.order||999));

                //-- 3.2. Обновляем логику загрузки для работы с Array --//
                const presetSelections = modifierSelectionsMap[currentModifierPresetId];
                if (Array.isArray(presetSelections) && presetSelections.length) {
                    selectedModifierIds = presetSelections;
                } else if (currentModifierPresetId === 'base' && Array.isArray(stored.llmComparatorSelected) && stored.llmComparatorSelected.length) {
                    selectedModifierIds = stored.llmComparatorSelected;
                } else {
                    selectedModifierIds = merged.filter(m => m.defaultSelected).map(m => m.id);
                }
                persistModifierSelections();

                // Индекс
                modifiersById = {};
                merged.forEach(m => { modifiersById[m.id] = m; });

                clearModifierOverrides();
                renderModifiersRow(merged);
                renderActiveModifiers(); // <-- 3.6. Добавить эту строку
                console.log(`[RESULTS] Modifiers loaded for preset ${currentModifierPresetId}`, merged);
            } catch (e) {
                console.error('[RESULTS] Could not load modifiers:', e);
                renderModifiersRow([]); // пусто, чтобы UI не ломался
            }
        }

        async function loadModifierPresets() {
            modifierPresetSelect = modifierPresetSelect || document.getElementById('modifier-preset-select');
            try {
                const presetIndexPath = 'Modifiers/modifier-presets.json';
                const resp = await fetch(chrome.runtime.getURL(presetIndexPath));
                if (resp.ok) {
                    const data = await resp.json();
                    if (Array.isArray(data) && data.length) {
                        modifierPresets = data;
                    }
                } else {
                    console.warn('[RESULTS] Could not load modifier-presets.json, using fallback.');
                }
            } catch (error) {
                console.warn('[RESULTS] Failed to fetch modifier presets:', error);
            }
            if (!Array.isArray(modifierPresets) || !modifierPresets.length) {
                modifierPresets = [{ id: 'base', label: 'Базовый набор', file: 'modifiers.json' }];
            }
            const storedPreset = await new Promise(resolve =>
                chrome.storage.local.get(MODIFIER_PRESET_STORAGE_KEY, resolve)
            );
            const storedPresetId = storedPreset?.[MODIFIER_PRESET_STORAGE_KEY];
            if (storedPresetId && modifierPresets.some(preset => preset.id === storedPresetId)) {
                currentModifierPresetId = storedPresetId;
            } else {
                currentModifierPresetId = modifierPresets[0].id;
            }
            if (modifierPresetSelect) {
                modifierPresetSelect.innerHTML = modifierPresets
                    .map(preset => `<option value="${preset.id}">${preset.label}</option>`)
                    .join('');
                modifierPresetSelect.value = currentModifierPresetId;
                if (!modifierPresetSelectBound) {
                    modifierPresetSelect.addEventListener('change', (event) => {
                        const nextPresetId = event.target.value;
                        if (!nextPresetId || nextPresetId === currentModifierPresetId) return;
                        chrome.storage.local.set({ [MODIFIER_PRESET_STORAGE_KEY]: nextPresetId });
                        loadModifiers(nextPresetId);
                    });
                    modifierPresetSelectBound = true;
                }
            }
            await loadModifiers(currentModifierPresetId);
        }




    // --- MAIN PAGE ELEMENTS ---
    const startButton = document.getElementById('start-button');
    const promptInput = document.getElementById('prompt-input');
    const promptNoteView = document.getElementById('prompt-note-view');
    const promptContainer = document.querySelector('.prompt-container.prompt-sandwich') || document.querySelector('.prompt-container');
    let useInputRichMode = false;
    let editorState = null;
    let applyRichInputContent = null;
    let syncPromptViewMode = null;
    let syncRichViewFromPrompt = null;
    let syncPromptFromRichView = null;
    let setPromptEditorMode = null;
    const defaultPromptPlaceholder = promptInput
        ? (promptInput.dataset.defaultPlaceholder || promptInput.getAttribute('placeholder') || '')
        : '';
    if (promptInput) {
        requestAnimationFrame(() => {
            promptInput.focus();
            try {
                promptInput.setSelectionRange(0, 0);
            } catch (err) {
                // ignore for non-supporting inputs
            }
        });
    }
    // Rich input is activated automatically when Use in input is pressed.
    const llmButtons = document.querySelectorAll('.llm-button');
    const llmNames = Array.from(llmButtons).map(btn => btn.textContent.trim()).filter(Boolean);
    const llmPanels = document.querySelectorAll('.llm-panel');
    const llmResultsContainer = document.querySelector('.llm-results');
    const comparisonPanel = document.getElementById('comparison-panel');
    const comparisonOutput = document.getElementById('comparison-output');
    const comparisonSpinner = document.getElementById('comparison-spinner');
    const getItButton = document.getElementById('get-it-button');
    const compareButton = document.getElementById('compare-button');
    const smartCompareButton = document.getElementById('smart-compare-button');
    const judgeSystemPromptSelect = document.getElementById('judge-system-prompt-select');
    const evaluatorSelect = document.getElementById('evaluator-select');
    const viewGridBtn = document.getElementById('view-grid-btn');
    const viewStackBtn = document.getElementById('view-stack-btn');
    const autoCheckbox = document.getElementById('auto-checkbox');
    const prefixToggleLabel = document.querySelector('.modifiers-toggle-label[data-mod-type="prefix"]');
    const suffixToggleLabel = document.querySelector('.modifiers-toggle-label[data-mod-type="suffix"]');
    const proSection = document.getElementById('pro-section');
    const newPagesCheckbox = document.getElementById('new-pages-checkbox');
    const apiModeCheckbox = document.getElementById('api-mode-checkbox');
    const autoToggleBtn = document.getElementById('auto-toggle');
    const apiToggleBtn = document.getElementById('api-toggle');
    const leftSidebarToggleBtn = document.getElementById('left-sidebar-toggle');
    const leftSidebarCloseBtn = document.getElementById('left-sidebar-close');
    const leftSidebarResizer = document.getElementById('left-sidebar-resizer');
    const rightSidebarToggleBtn = document.getElementById('right-sidebar-toggle');
    const rightSidebar = document.getElementById('pipeline-sidebar');
    const promptSaveBtn = document.getElementById('prompt-save-btn');
    const saveSessionBtn = document.getElementById('save-session-btn');
    const responseSaveButtons = Array.from(document.querySelectorAll('.panel-save-note-btn'));
    const notesTextarea = document.getElementById('notes-textarea');
    const notesSidebar = document.getElementById('notes-sidebar');
    const notesTree = document.getElementById('notes-tree');
    const notesAddRootBtn = document.getElementById('notes-add-root');
    const notesTabs = document.getElementById('notes-tabs');
    const notesTabAdd = document.getElementById('notes-tab-add');
    const notesSessionsTab = document.getElementById('notes-sessions-tab');
    const notesSearch = document.getElementById('notes-search');
    const notesSearchClear = document.getElementById('notes-search-clear');
    const notesSelectAll = document.getElementById('notes-select-all');
    const notesExportBtn = document.getElementById('notes-export-btn');
    const notesMergeBtn = document.getElementById('notes-merge-btn');
    const notesDeleteBtn = document.getElementById('notes-delete-btn');
    const notesEmpty = document.getElementById('notes-empty');
    const notesSidebarTitle = document.querySelector('.sidebar-title');
    const notesActiveTitle = document.getElementById('notes-active-title');
    const notesStatus = document.getElementById('notes-status');
    const notesPanel = document.querySelector('.notes-panel');
    const sessionsToolbar = document.getElementById('sessions-toolbar');
    const sessionsSaveBtn = document.getElementById('sessions-save-btn');
    const sessionsRunBtn = document.getElementById('sessions-run-btn');
    const sessionsDeleteBtn = document.getElementById('sessions-delete-btn');
    const sessionsPanel = document.getElementById('sessions-panel');
    const sessionsList = document.getElementById('sessions-list');
    const sessionsEmpty = document.getElementById('sessions-empty');
    const promptAttachInput = document.getElementById('prompt-attach-input');
    const promptAttachBtn = document.getElementById('prompt-attach-btn');
    const promptAttachmentBar = document.getElementById('prompt-attachment-bar');
    const attachedFiles = [];
    const attachmentKeys = new Set();
    const MAX_ATTACHMENTS = 5;
    const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB на файл
    const MAX_TOTAL_BYTES = 25 * 1024 * 1024; // ~25MB на все вложения
    const ATTACH_CAPABILITY = {
        Claude: false
    };

    const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });

    const extractFilesFromTransfer = (transfer) => {
        if (!transfer) return [];
        const files = Array.from(transfer.files || []);
        if (transfer.items) {
            for (const item of Array.from(transfer.items)) {
                const kind = item?.kind || '';
                if (kind !== 'file') {
                    continue;
                }
                const file = item.getAsFile?.();
                if (file) {
                    files.push(file);
                    continue;
                }
                const blob = item.getAsFile?.();
                if (blob) {
                    const fallbackName = `clipboard.${(blob.type || 'bin').split('/').pop() || 'bin'}`;
                    files.push(new File([blob], fallbackName, { type: blob.type || 'application/octet-stream' }));
                }
            }
        }
        return files;
    };

    const tryAddTransferAttachments = (transfer) => {
        const files = extractFilesFromTransfer(transfer);
        if (!files.length) return false;
        addPromptAttachments(files);
        return true;
    };

    const buildAttachmentPayload = async () => {
        const slice = attachedFiles.slice(0, MAX_ATTACHMENTS);
        const payload = [];
        let total = 0;
        for (const file of slice) {
            if (!file || !file.name) continue;
            if (file.size > MAX_ATTACHMENT_BYTES) {
                showNotification(`Файл ${file.name} слишком большой (>${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB)`);
                continue;
            }
            if (total + file.size > MAX_TOTAL_BYTES) {
                showNotification(`Суммарный объём вложений превышает ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB`);
                break;
            }
            try {
                const dataUrl = await readFileAsDataUrl(file);
                payload.push({
                    name: file.name,
                    size: file.size,
                    type: file.type || 'application/octet-stream',
                    base64: dataUrl
                });
                total += file.size;
            } catch (err) {
                console.warn('[results] failed to read attachment', file?.name, err);
            }
        }
        return payload;
    };

    const sendToBackground = (payload) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(payload, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(response);
        });
    });

    const renderPromptAttachments = () => {
        if (!promptAttachmentBar) return;
        if (!attachedFiles.length) {
            promptAttachmentBar.classList.add('is-empty');
            promptAttachmentBar.innerHTML = '';
            return;
        }
        promptAttachmentBar.classList.remove('is-empty');
        promptAttachmentBar.innerHTML = attachedFiles.map((file) => {
            const name = file.name || '';
            const displayName = name.length > 12 ? `${name.slice(0, 12)}...` : name;
            const key = `${file.name}-${file.size}-${file.type}`;
            return `<span class="attachment-pill" data-attachment-key="${escapeHtml(key)}" title="${escapeHtml(file.name)}"><span class="attachment-icon">📎</span><span class="attachment-label">${escapeHtml(displayName)}</span><button class="attachment-remove" aria-label="Remove attachment" title="Remove attachment">×</button></span>`;
        }).join('');
    };

    const addPromptAttachments = (files = []) => {
        let added = false;
        files.slice(0, MAX_ATTACHMENTS).forEach((file) => {
            if (!file || !file.name) return;
            const key = `${file.name}-${file.size}-${file.type}`;
            if (attachmentKeys.has(key)) return;
            attachmentKeys.add(key);
            attachedFiles.push(file);
            added = true;
        });
        if (added) renderPromptAttachments();
    };

    renderPromptAttachments();

    promptAttachBtn?.addEventListener('click', () => {
        try {
            promptAttachInput?.click();
        } catch (err) {
            console.warn('[results] prompt attach click failed', err);
        }
    });

    promptAttachInput?.addEventListener('change', (event) => {
        const files = Array.from(event.target.files || []);
        if (!files.length) return;
        addPromptAttachments(files);
        try {
            promptAttachInput.value = '';
        } catch (_) {}
    });

    promptAttachmentBar?.addEventListener('click', (e) => {
        const btn = e.target.closest('.attachment-remove');
        if (!btn) return;
        const pill = btn.closest('.attachment-pill');
        if (!pill) return;
        const key = pill.getAttribute('data-attachment-key');
        if (!key) return;
        const idx = attachedFiles.findIndex((f) => `${f.name}-${f.size}-${f.type}` === key);
        if (idx >= 0) {
            attachedFiles.splice(idx, 1);
            attachmentKeys.delete(key);
            renderPromptAttachments();
        }
    });

    const floatingTooltip = document.createElement('div');
    floatingTooltip.className = 'floating-tooltip';
    document.body.appendChild(floatingTooltip);
    let activeTooltipTarget = null;

    const positionFloatingTooltip = (target) => {
        if (!target || !target.dataset || !target.dataset.tooltip) return;
        const message = target.dataset.tooltip.trim();
        if (!message) return;
        floatingTooltip.textContent = message;
        activeTooltipTarget = target;
        floatingTooltip.classList.add('is-visible');
        requestAnimationFrame(() => {
            const rect = target.getBoundingClientRect();
            const tooltipRect = floatingTooltip.getBoundingClientRect();
            const spacing = 12;
            let top = rect.top - tooltipRect.height - spacing;
            if (top < 8) {
                top = rect.bottom + spacing;
            }
            let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
            const viewportWidth = window.innerWidth;
            const maxLeft = viewportWidth - tooltipRect.width - 8;
            left = Math.min(Math.max(left, 8), Math.max(maxLeft, 8));
            floatingTooltip.style.top = `${top + window.scrollY}px`;
            floatingTooltip.style.left = `${left + window.scrollX}px`;
        });
    };

    const hideFloatingTooltip = (target) => {
        if (target && target !== activeTooltipTarget) return;
        activeTooltipTarget = null;
        floatingTooltip.classList.remove('is-visible');
    };
    const tooltipTargets = new Set([
        ...document.querySelectorAll('.select-tooltip[data-tooltip]'),
        ...document.querySelectorAll('.mode-pill[data-tooltip]'),
        ...document.querySelectorAll('.top-new-pages-toggle[data-tooltip]'),
        ...document.querySelectorAll('.sidebar-toggle-btn[data-tooltip]')
    ]);

    const registerTooltipTarget = (el) => {
        if (!el || !el.dataset || !el.dataset.tooltip || !el.dataset.tooltip.trim()) return;
        if (tooltipTargets.has(el)) return;
        tooltipTargets.add(el);
        el.addEventListener('mouseenter', () => positionFloatingTooltip(el));
        el.addEventListener('focus', () => positionFloatingTooltip(el));
        el.addEventListener('mouseleave', () => hideFloatingTooltip(el));
        el.addEventListener('blur', () => hideFloatingTooltip(el));
    };

    tooltipTargets.forEach(target => registerTooltipTarget(target));
    const devToolsPanel = document.getElementById('dev-tools-panel');
    const refreshOverridesBtn = document.getElementById('refresh-selector-overrides-btn');
    const clearOverridesBtn = document.getElementById('clear-selector-overrides-btn');
    const clearSelectorCacheBtn = document.getElementById('clear-selector-cache-btn');
    const runSelectorHealthcheckBtn = document.getElementById('run-selector-healthcheck-btn');
    const devToolsStatus = document.getElementById('dev-tools-status');
    const selectorHealthStatus = document.getElementById('selector-health-status');
    const selectorHealthSummary = document.getElementById('selector-health-summary');
    const selectorHealthTable = document.getElementById('selector-health-table');
    const selectorHealthRefreshBtn = document.getElementById('refresh-selector-health-btn');
    const selectorHealthCopyBtn = document.getElementById('copy-selector-health-btn');
    const selectorHealthExportBtn = document.getElementById('export-selector-health-btn');
    const telemetryRefreshBtn = document.getElementById('refresh-telemetry-btn');
    const telemetryTable = document.getElementById('selector-telemetry-table');
    const liveSelectorModelSelect = document.getElementById('live-selector-model');
    const liveSelectorElementSelect = document.getElementById('live-selector-element');
    const liveSelectorList = document.getElementById('live-selector-list');
    const selectorDetectedVersion = document.getElementById('selector-detected-version');
    const selectorDetectedRefreshBtn = document.getElementById('selector-detected-refresh-btn');
    const selectorActiveTabStatus = document.getElementById('selector-active-tab-status');
    const selectorActiveSelectors = document.getElementById('selectors0-active-selectors');
    const selectorOverrideInput = document.getElementById('selector-override-input');
    const selectorOverrideReasonInput = document.getElementById('selector-override-reason');
    const selectorValidateBtn = document.getElementById('selector-validate-btn');
    const selectorValidateActiveBtn = document.getElementById('selector-validate-active-btn');
    const selectorValidationStatus = document.getElementById('selector-validation-status');
    const selectorPickBtn = document.getElementById('selector-pick-btn');
    const selectorHighlightBtn = document.getElementById('selector-highlight-btn');
    const selectorSaveOverrideBtn = document.getElementById('selector-save-override-btn');
    const selectorAuditList = document.getElementById('selector-audit-list');
    const selectorAuditRefreshBtn = document.getElementById('selector-audit-refresh-btn');
    const selectorsSavedOverridesList = document.getElementById('selectors0-saved-overrides');
    const selectorsCandidatesList = document.getElementById('selectors0-candidates');
    const selectorsWorkbenchModelSelect = document.getElementById('selectors0-model');
    const selectorsWorkbenchList = document.querySelector('.selectors0-workbench-list');
    const selectorsWorkbenchStatus = document.getElementById('selectors-workbench-status');
    const selectorsWorkbenchFileInput = document.querySelector('.selectors0-file-input');
    const selectorsWorkbenchHeaderButtons = document.querySelectorAll('.selectors0-workbench [data-selectors-action]');
// const shortCheckbox = document.getElementById('short-checkbox'); // (deprecated — заменено системой Modifiers)
    const comparisonSection = document.getElementById('comparison-section');
    //-- 3.1. Добавляем элементы для сворачиваемого блока модификаторов --//
    const modifiersSection = document.querySelector('.modifiers-section');
    const toggleModifiersBtn = document.getElementById('toggle-modifiers-btn');
    const modifiersHeader = document.getElementById('modifiers-header');
    const modifiersContainer = document.getElementById('modifiers-container');
    const expandCollapseIcon = document.querySelector('.toggle-icon-console');
    const statusPingButtons = document.querySelectorAll('.status-ping-btn');
    const statusResendButtons = document.querySelectorAll('.status-resend-btn');
    const diagnosticsLogWrapper = document.getElementById('diagnostics-log-wrapper');
    const diagnosticsCollapseToggle = document.getElementById('toggle-diagnostics-expand');
    const clearDiagnosticsBtn = document.getElementById('clear-diagnostics-logs');
    const manualPingButtons = {};
    const manualResendButtons = {};
    const llmLogs = {};
    const diagnosticsState = {};
    const MAX_DIAGNOSTIC_ENTRIES = 60;
    let diagnosticsExpanded = true;
    const DIAG_ENTRY_LIMIT = 3;
    const DIAG_BASE_HEIGHT = 230;
    const DIAG_COLLAPSED_HEIGHT = 120;
    const DIAG_ENTRY_FALLBACK_HEIGHT = 32;
    const diagEntryHeightCache = new WeakMap();
    const apiIndicatorRegistry = new Map();
    const apiIndicatorState = {};
    let latestTelemetrySnapshot = null;
    const SELECTOR_ELEMENT_TYPES = ['composer', 'sendButton', 'response'];
    const SELECTOR_WORKBENCH_FIELDS = [
        { key: 'composer', label: 'composer' },
        { key: 'sendButton', label: 'sendButton' },
        { key: 'response', label: 'response' },
        { key: 'stopButton', label: 'stopButton' },
        { key: 'regenerate', label: 'regenerate' },
        { key: 'lastMessage', label: 'lastMessage' }
    ];
    let activeSelectorSnapshot = null;
    let activeSelectorSnapshotModel = '';
    let activeSelectorValidationMap = new Map();
    let lastSelectorValidation = null;
    let selectorHealthSnapshot = null;
    let activePickerRequestId = null;
    let activePickerEntry = null;
    let activePickerMode = null;
    let pickerTimeoutId = null;
    const selectorsWorkbenchState = {
        entries: new Map(),
        modelName: '',
        statusTimer: null
    };

    const bindToggleButton = (button, checkbox) => {
        if (!button || !checkbox) return null;
        const applyState = () => {
            const isActive = !!checkbox.checked;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-pressed', String(isActive));
        };
        button.addEventListener('click', () => {
            checkbox.checked = !checkbox.checked;
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        });
        applyState();
        return applyState;
    };

    const syncAutoToggleState = bindToggleButton(autoToggleBtn, autoCheckbox);
    const syncApiToggleState = bindToggleButton(apiToggleBtn, apiModeCheckbox);

    const parsePx = (value, fallback) => {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };

    const rootStyles = getComputedStyle(document.documentElement);
    const leftSidebarMin = parsePx(rootStyles.getPropertyValue('--sidebar-left-min'), 240);
    const leftSidebarMax = parsePx(rootStyles.getPropertyValue('--sidebar-left-max'), 360);
    const clampLeftSidebarWidth = (value) => Math.min(leftSidebarMax, Math.max(leftSidebarMin, value));
    const defaultLeftSidebarWidth = clampLeftSidebarWidth(
        parsePx(rootStyles.getPropertyValue('--sidebar-left-width'), 280)
    );
    let leftSidebarWidth = defaultLeftSidebarWidth;

    const setLeftSidebarOpen = (isOpen) => {
        document.body.classList.toggle('left-sidebar-open', isOpen);
        if (leftSidebarToggleBtn) {
            leftSidebarToggleBtn.classList.toggle('is-active', isOpen);
            leftSidebarToggleBtn.setAttribute('aria-pressed', String(isOpen));
        }
        if (isOpen) {
            document.documentElement.style.setProperty('--sidebar-left-width', `${leftSidebarWidth}px`);
        } else {
            leftSidebarWidth = defaultLeftSidebarWidth;
            document.documentElement.style.setProperty('--sidebar-left-width', `${defaultLeftSidebarWidth}px`);
        }
        if (leftSidebarResizer) {
            const widthValue = isOpen ? leftSidebarWidth : defaultLeftSidebarWidth;
            leftSidebarResizer.setAttribute('aria-valuenow', String(Math.round(widthValue)));
        }
    };

    if (leftSidebarToggleBtn) {
        const initialLeftState = document.body.classList.contains('left-sidebar-open');
        setLeftSidebarOpen(initialLeftState);
        leftSidebarToggleBtn.addEventListener('click', () => {
            const nextState = !document.body.classList.contains('left-sidebar-open');
            setLeftSidebarOpen(nextState);
        });
        if (leftSidebarCloseBtn) {
            leftSidebarCloseBtn.addEventListener('click', () => setLeftSidebarOpen(false));
        }
    }

    if (leftSidebarResizer) {
        const appShell = document.querySelector('.app-shell');
        let isResizing = false;
        let shellOffset = 0;

        const handleResizeMove = (event) => {
            if (!isResizing || !appShell) return;
            const nextWidth = clampLeftSidebarWidth(event.clientX - shellOffset);
            leftSidebarWidth = nextWidth;
            document.documentElement.style.setProperty('--sidebar-left-width', `${nextWidth}px`);
            leftSidebarResizer.setAttribute('aria-valuenow', String(Math.round(nextWidth)));
        };

        const stopResize = () => {
            if (!isResizing) return;
            isResizing = false;
            document.body.classList.remove('is-resizing');
        };

        leftSidebarResizer.addEventListener('pointerdown', (event) => {
            if (!document.body.classList.contains('left-sidebar-open')) return;
            if (!appShell) return;
            const shellRect = appShell.getBoundingClientRect();
            const shellPadding = parsePx(getComputedStyle(appShell).paddingLeft, 0);
            shellOffset = shellRect.left + shellPadding;
            event.preventDefault();
            isResizing = true;
            document.body.classList.add('is-resizing');
            leftSidebarResizer.setPointerCapture?.(event.pointerId);
        });

        window.addEventListener('pointermove', handleResizeMove);
        window.addEventListener('pointerup', stopResize);
        window.addEventListener('pointercancel', stopResize);
    }

    let rightSidebarClosing = false;
    let rightSidebarCloseHandler = null;
    const setRightSidebarOpen = (isOpen) => {
        document.body.classList.toggle('right-sidebar-open', isOpen);
        if (isOpen) {
            document.body.classList.remove('right-sidebar-closing');
            document.body.classList.remove('right-sidebar-reset');
            rightSidebarClosing = false;
            if (rightSidebar && rightSidebarCloseHandler) {
                rightSidebar.removeEventListener('transitionend', rightSidebarCloseHandler);
                rightSidebarCloseHandler = null;
            }
        }
        if (rightSidebarToggleBtn) {
            rightSidebarToggleBtn.classList.toggle('is-active', isOpen);
            rightSidebarToggleBtn.setAttribute('aria-pressed', String(isOpen));
        }
        if (rightSidebar) {
            rightSidebar.setAttribute('aria-hidden', String(!isOpen));
        }
    };

    const startRightSidebarClose = () => {
        if (!rightSidebar || !document.body.classList.contains('right-sidebar-open')) return;
        if (rightSidebarClosing) return;
        rightSidebarClosing = true;
        document.body.classList.add('right-sidebar-closing');
        if (rightSidebarCloseHandler) {
            rightSidebar.removeEventListener('transitionend', rightSidebarCloseHandler);
            rightSidebarCloseHandler = null;
        }
        const handleCloseEnd = (event) => {
            if (event.target !== rightSidebar || event.propertyName !== 'transform') return;
            rightSidebar.removeEventListener('transitionend', handleCloseEnd);
            rightSidebarClosing = false;
            document.body.classList.add('right-sidebar-reset');
            setRightSidebarOpen(false);
            document.body.classList.remove('right-sidebar-closing');
            requestAnimationFrame(() => {
                document.body.classList.remove('right-sidebar-reset');
            });
            rightSidebarCloseHandler = null;
        };
        rightSidebarCloseHandler = handleCloseEnd;
        rightSidebar.addEventListener('transitionend', handleCloseEnd);
    };

    if (rightSidebarToggleBtn && rightSidebar) {
        const initialRightState = document.body.classList.contains('right-sidebar-open');
        setRightSidebarOpen(initialRightState);
        rightSidebarToggleBtn.addEventListener('click', () => {
            if (document.body.classList.contains('right-sidebar-open')) {
                startRightSidebarClose();
            } else {
                setRightSidebarOpen(true);
            }
        });
    }

    let pipelineRunActive = false;
    const pipelineWaiter = {
        runToken: 0,
        waiting: false,
        pendingModels: new Set(),
        responses: {},
        timeoutId: null,
        waitForModels(models, { timeoutMs = 240000 } = {}) {
            const normalized = Array.isArray(models) ? models.filter(Boolean) : [];
            if (!normalized.length) {
                return Promise.resolve({ responses: {}, missing: [], timedOut: false });
            }
            this.runToken += 1;
            const token = this.runToken;
            this.waiting = true;
            this.pendingModels = new Set(normalized);
            this.responses = {};
            if (this.timeoutId) {
                clearTimeout(this.timeoutId);
                this.timeoutId = null;
            }
            return new Promise((resolve) => {
                const finalize = (timedOut = false) => {
                    if (token !== this.runToken) return;
                    const missing = normalized.filter((name) => !Object.prototype.hasOwnProperty.call(this.responses, name));
                    this.waiting = false;
                    this.pendingModels.clear();
                    if (this.timeoutId) {
                        clearTimeout(this.timeoutId);
                        this.timeoutId = null;
                    }
                    resolve({ responses: { ...this.responses }, missing, timedOut });
                };
                this.timeoutId = setTimeout(() => finalize(true), timeoutMs);
                this._finalize = finalize;
            });
        },
        handleResponse(llmName, answer) {
            if (!this.waiting || !this.pendingModels.has(llmName)) return;
            this.responses[llmName] = answer;
            const allDone = Array.from(this.pendingModels).every((name) =>
                Object.prototype.hasOwnProperty.call(this.responses, name)
            );
            if (allDone && typeof this._finalize === 'function') {
                this._finalize(false);
            }
        },
        reset() {
            this.waiting = false;
            this.pendingModels.clear();
            this.responses = {};
            if (this.timeoutId) {
                clearTimeout(this.timeoutId);
                this.timeoutId = null;
            }
            this._finalize = null;
        }
    };

    const pipelinePanel = document.getElementById('pipeline-panel');
    if (pipelinePanel) {
        const pipelineAddRoundBtn = document.getElementById('pipeline-add-round-btn');
        const pipelineRemoveRoundBtn = document.getElementById('removeRoundBtn');
        const pipelineAddBtn = document.getElementById('pipeline-add-btn');
        const pipelineResetBtn = document.getElementById('pipeline-reset-btn');
        const pipelineSaveBtn = document.getElementById('pipeline-save-btn');
        const pipelineDeleteBtn = document.getElementById('pipeline-delete-btn');
        const pipelineExportBtn = document.getElementById('pipeline-export-btn');
        const pipelineImportBtn = document.getElementById('pipeline-import-btn');
        const pipelineRunBtn = document.getElementById('pipeline-run-btn');
        const pipelineCloseBtn = document.getElementById('pipeline-close-btn');
        const pipelineItems = document.getElementById('pipelineItems');
        const pipelineName = document.getElementById('currentPipelineName');
        const insertionPoint = document.getElementById('insertionPoint');
        const entryWrapper = document.getElementById('entryWrapper');
        const pipelineList = pipelinePanel.querySelector('.pipeline-list');
        const pipelineListHeader = pipelineList ? pipelineList.querySelector('.pipeline-list-header') : null;
        const PIPELINE_STORAGE_KEY = 'llmComparatorPipelines';
        const pipelineStore = {
            version: 2,
            pipelines: {},
            order: [],
            lastSaved: '',
            active: ''
        };

        const togglePipelineListCollapsed = () => {
            if (!pipelineList) return;
            pipelineList.classList.toggle('is-collapsed');
        };

        if (pipelineListHeader) {
            pipelineListHeader.addEventListener('dblclick', (event) => {
                event.preventDefault();
                togglePipelineListCollapsed();
            });
        }

        if (pipelineItems) {
            pipelineItems.addEventListener('dblclick', (event) => {
                const nameSpan = event.target.closest('.pipeline-item-name');
                if (!nameSpan || !pipelineItems.contains(nameSpan)) return;
                event.preventDefault();
                event.stopPropagation();
                startPipelineRename(nameSpan.closest('.pipeline-item'));
            });
        }

        const normalizePipelineStore = (value) => {
            const base = { version: 2, pipelines: {}, order: [], lastSaved: '', active: '' };
            if (!value || typeof value !== 'object') return base;
            const pipelines = value.pipelines && typeof value.pipelines === 'object' ? value.pipelines : {};
            const order = Array.isArray(value.order)
                ? value.order.filter((name) => typeof name === 'string' && name.trim())
                : Object.keys(pipelines);
            return {
                ...base,
                pipelines,
                order,
                lastSaved: typeof value.lastSaved === 'string' ? value.lastSaved : '',
                active: typeof value.active === 'string' ? value.active : ''
            };
        };

        const readPipelineStore = async () => {
            let storedValue = null;
            if (chrome?.storage?.local?.get) {
                const res = await new Promise((resolve) => chrome.storage.local.get(PIPELINE_STORAGE_KEY, resolve));
                storedValue = res ? res[PIPELINE_STORAGE_KEY] : null;
            } else {
                try {
                    storedValue = JSON.parse(localStorage.getItem(PIPELINE_STORAGE_KEY) || 'null');
                } catch (_) {
                    storedValue = null;
                }
            }
            const normalized = normalizePipelineStore(storedValue);
            pipelineStore.pipelines = normalized.pipelines;
            pipelineStore.order = normalized.order;
            pipelineStore.lastSaved = normalized.lastSaved;
            pipelineStore.active = normalized.active;
        };

        const persistPipelineStore = () => {
            const payload = {
                version: pipelineStore.version,
                pipelines: pipelineStore.pipelines,
                order: pipelineStore.order,
                lastSaved: pipelineStore.lastSaved,
                active: pipelineStore.active
            };
            if (chrome?.storage?.local?.set) {
                chrome.storage.local.set({ [PIPELINE_STORAGE_KEY]: payload });
            } else {
                try {
                    localStorage.setItem(PIPELINE_STORAGE_KEY, JSON.stringify(payload));
                } catch (_) {}
            }
        };

        const buildPipelineExportPayload = () => ({
            version: pipelineStore.version,
            pipelines: pipelineStore.pipelines,
            order: pipelineStore.order,
            lastSaved: pipelineStore.lastSaved,
            active: pipelineStore.active
        });

        const PIPELINE_MODELS = [
            { name: 'Claude', defaultActive: true },
            { name: 'GPT', defaultActive: true },
            { name: 'Gemini', defaultActive: true },
            { name: 'Grok', defaultActive: false },
            { name: 'Le Chat', defaultActive: false },
            { name: 'Qwen', defaultActive: false },
            { name: 'DeepSeek', defaultActive: false },
            { name: 'Perplexity', defaultActive: false }
        ];
        const PIPELINE_ROLE_BASE = ['Synthesis', 'Critic', 'Meta', 'Advocate'];
        const DEFAULT_MODEL_INDICES = PIPELINE_MODELS.reduce((acc, model, index) => {
            if (model.defaultActive) acc.push(index);
            return acc;
        }, []);
        const DEFAULT_JUDGE_INDICES = PIPELINE_MODELS.length > 1 ? [0, 1] : [0];
        const DEFAULT_LATE_JUDGE_INDICES = [0];

        const getOrderedJudgePrompts = () => {
            const list = Array.isArray(judgeSystemPrompts) ? judgeSystemPrompts : [];
            return list
                .filter((prompt) => prompt && prompt.id && prompt.text)
                .sort((a, b) => {
                    const orderA = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
                    const orderB = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
                    if (orderA !== orderB) return orderA - orderB;
                    const labelA = String(a.label || a.id || '');
                    const labelB = String(b.label || b.id || '');
                    return labelA.localeCompare(labelB);
                });
        };

        const getJudgePromptById = (promptId) => {
            if (!promptId) return null;
            const ordered = getOrderedJudgePrompts();
            return ordered.find((prompt) => prompt.id === promptId) || null;
        };

        const getCriticalJudgePromptId = () => {
            const ordered = getOrderedJudgePrompts();
            if (!ordered.length) return null;
            const match = ordered.find((prompt) => {
                const label = String(prompt.label || '').toLowerCase();
                const id = String(prompt.id || '').toLowerCase();
                return label.includes('крит') || label.includes('crit') || id.includes('critical');
            });
            return (match || ordered[0]).id;
        };

        const resolveJudgePromptId = (value, index = 0) => {
            if (!value) return null;
            const ordered = getOrderedJudgePrompts();
            const byId = ordered.find((prompt) => prompt.id === value);
            if (byId) return byId.id;
            const lowered = String(value).toLowerCase();
            const byLabel = ordered.find((prompt) => String(prompt.label || '').toLowerCase() === lowered);
            if (byLabel) return byLabel.id;
            const roleIndex = PIPELINE_ROLE_BASE.findIndex((role) => role.toLowerCase() === lowered);
            if (roleIndex !== -1 && ordered[roleIndex]) return ordered[roleIndex].id;
            if (ordered[index % Math.max(1, ordered.length)]) return ordered[index % ordered.length].id;
            return null;
        };

        const buildJudgePromptOptionsHtml = (index) => {
            const orderedPrompts = getOrderedJudgePrompts();
            if (!orderedPrompts.length) return '';
            const metaPrompt = orderedPrompts.find((prompt) => {
                const id = String(prompt.id || '').toLowerCase();
                return id.includes('meta_synthesis');
            }) || orderedPrompts.find((prompt) => String(prompt.label || '').toLowerCase().includes('meta'));
            const primaryPrompt = index > 0 ? (metaPrompt || orderedPrompts[0]) : orderedPrompts[0];
            const ordered = [primaryPrompt, ...orderedPrompts.filter((prompt) => prompt !== primaryPrompt)];
            return ordered
                .map((prompt) => `<option value="${escapeHtml(prompt.id)}">${escapeHtml(prompt.label || prompt.id)}</option>`)
                .join('');
        };

        const buildModelBlocksHtml = (activeIndices = DEFAULT_MODEL_INDICES, withRole = false) => {
            const activeSet = new Set(activeIndices);
            return PIPELINE_MODELS.map((model, index) => {
                const isActive = activeSet.has(index);
                const roleHtml = withRole
                    ? `<select class="role-selector judge-prompt-selector"${isActive ? '' : ' disabled'}>${buildJudgePromptOptionsHtml(index)}</select>`
                    : '';
                const inputAttrs = `${isActive ? ' checked' : ''} aria-label="Input" title="Input"`;
                const sendAttrs = `${isActive ? ' checked' : ''}${isActive ? '' : ' disabled'} aria-label="Send" title="Send"`;
                return `
                    <div class="model-block ${isActive ? 'active' : 'inactive'}${withRole ? ' with-role' : ''}" data-index="${index}">
                        <div class="model-header">
                            <span class="status-indicator" data-llm-name="${escapeHtml(model.name)}"></span>
                            <input type="checkbox" class="model-checkbox model-input-checkbox"${inputAttrs}>
                            <span class="model-name">${escapeHtml(model.name)}</span>
                            <input type="checkbox" class="model-checkbox model-send-checkbox"${sendAttrs}>
                        </div>
                        ${roleHtml}
                    </div>
                `;
            }).join('');
        };

        const hydratePipelineStacks = () => {
            const r1Stack = document.getElementById('r1-models');
            if (r1Stack) r1Stack.innerHTML = buildModelBlocksHtml(DEFAULT_MODEL_INDICES, false);
            const r2Stack = document.getElementById('r2-models');
            if (r2Stack) r2Stack.innerHTML = buildModelBlocksHtml(DEFAULT_JUDGE_INDICES, true);
        };

        const pipelineStyles = window.getComputedStyle(document.documentElement);
        const pipelineBlockHeight = parseFloat(pipelineStyles.getPropertyValue('--pipeline-block-height'));
        const pipelineBlockGap = parseFloat(pipelineStyles.getPropertyValue('--pipeline-block-gap'));
        const resolvedBlockHeight = Number.isFinite(pipelineBlockHeight) ? pipelineBlockHeight : 64;
        const resolvedBlockGap = Number.isFinite(pipelineBlockGap) ? pipelineBlockGap : 6;
        const BLOCK_H = resolvedBlockHeight + resolvedBlockGap;
        const BLOCK_CENTER = resolvedBlockHeight / 2;
        const BASE_STACK_HEIGHT = 240;
        let roundCounter = 2;

        hydratePipelineStacks();

        const getBlockCenterY = (index) => index * BLOCK_H + BLOCK_CENTER;
        const getBlockCenterYRelativeTo = (stack, index, container) => {
            if (!stack || !container) return getBlockCenterY(index);
            const item = stack.children[index];
            if (!item) return getBlockCenterY(index);
            const itemRect = item.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            if (!itemRect.height || !containerRect.height) return getBlockCenterY(index);
            return (itemRect.top + itemRect.height / 2) - containerRect.top;
        };

        const getModelInputIndices = (stackId) => {
            const stack = document.getElementById(stackId);
            if (!stack) return [];
            const indices = [];
            Array.from(stack.children).forEach((item, i) => {
                const cb = item.querySelector('.model-input-checkbox');
                if (cb && cb.checked && !cb.disabled) indices.push(i);
            });
            return indices;
        };

        const getModelSendIndices = (stackId) => {
            const stack = document.getElementById(stackId);
            if (!stack) return [];
            const indices = [];
            Array.from(stack.children).forEach((item, i) => {
                const cb = item.querySelector('.model-send-checkbox');
                if (cb && cb.checked && !cb.disabled) indices.push(i);
            });
            return indices;
        };

        const getOutputCheckedIndices = (stackId) => {
            const stack = document.getElementById(stackId);
            if (!stack) return [];
            const indices = [];
            Array.from(stack.children).forEach((item, i) => {
                const cb = item.querySelector('.output-checkbox');
                if (cb && cb.checked) indices.push(i);
            });
            return indices;
        };

        const areAllChecked = (container, selector) => {
            if (!container) return false;
            const boxes = Array.from(container.querySelectorAll(selector));
            if (!boxes.length) return false;
            return boxes.every((cb) => cb.checked);
        };

        const setCheckboxesState = (container, selector, shouldCheck) => {
            if (!container) return false;
            const boxes = Array.from(container.querySelectorAll(selector));
            if (!boxes.length) return false;
            let changed = false;
            boxes.forEach((cb) => {
                if (cb.checked !== shouldCheck) {
                    cb.checked = shouldCheck;
                    changed = true;
                }
            });
            return changed;
        };

        const updatePipelineLayout = () => {
            const stacks = pipelinePanel.querySelectorAll('.model-stack, .output-stack');
            let maxHeight = 0;
            stacks.forEach((stack) => {
                const items = Array.from(stack.children).filter((node) => node.nodeType === 1);
                if (!items.length) return;
                const lastItem = items[items.length - 1];
                const lastStyle = window.getComputedStyle(lastItem);
                const marginBottom = parseFloat(lastStyle.marginBottom) || 0;
                const stackRect = stack.getBoundingClientRect();
                const lastRect = lastItem.getBoundingClientRect();
                const stackHeight = (lastRect.bottom - stackRect.top) + marginBottom;
                if (stackHeight > maxHeight) maxHeight = stackHeight;
            });
            const height = Math.max(BASE_STACK_HEIGHT, maxHeight || BASE_STACK_HEIGHT);
            pipelinePanel.querySelectorAll('.connector-svg').forEach((svg) => {
                svg.style.height = `${height}px`;
                svg.setAttribute('height', `${height}`);
            });
            if (entryWrapper) {
                entryWrapper.style.height = `${height}px`;
            }
        };

        const captureModelStackState = (stackId) => {
            const stack = document.getElementById(stackId);
            if (!stack) return null;
            const items = Array.from(stack.querySelectorAll('.model-block')).map((block) => {
                const inputCb = block.querySelector('.model-input-checkbox');
                const sendCb = block.querySelector('.model-send-checkbox');
                const role = block.querySelector('.role-selector');
                return {
                    input: !!inputCb?.checked,
                    send: !!sendCb?.checked,
                    role: role ? role.value : null
                };
            });
            return { items };
        };

        const captureOutputStackState = (stackId) => {
            const stack = document.getElementById(stackId);
            if (!stack) return null;
            const checks = Array.from(stack.querySelectorAll('.output-block')).map((block) => {
                const cb = block.querySelector('.output-checkbox');
                return !!cb?.checked;
            });
            return { checks };
        };

        const capturePipelineConfig = () => {
            const modelStacks = {
                'r1-models': captureModelStackState('r1-models')
            };
            for (let r = 2; r <= roundCounter; r++) {
                modelStacks[`r${r}-models`] = captureModelStackState(`r${r}-models`);
            }

            return {
                version: 2,
                roundCounter,
                modelStacks,
                outputStack: captureOutputStackState('output-stack')
            };
        };

        const applyModelStackState = (stackId, state, sendOverrides = null) => {
            if (!state || !Array.isArray(state.items)) return;
            const stack = document.getElementById(stackId);
            if (!stack) return;
            const blocks = Array.from(stack.querySelectorAll('.model-block'));
            blocks.forEach((block, index) => {
                const item = state.items[index];
                if (!item) return;
                const inputCb = block.querySelector('.model-input-checkbox');
                const sendCb = block.querySelector('.model-send-checkbox');
                const inputValue = typeof item.input === 'boolean'
                    ? item.input
                    : (typeof item.checked === 'boolean' ? item.checked : undefined);
                if (inputCb && typeof inputValue === 'boolean') {
                    inputCb.checked = inputValue;
                }
                const sendFallback = Array.isArray(sendOverrides?.[stackId]) ? sendOverrides[stackId][index] : undefined;
                const sendValue = typeof item.send === 'boolean' ? item.send : sendFallback;
                if (sendCb && typeof sendValue === 'boolean') {
                    sendCb.checked = sendValue;
                }
                const role = block.querySelector('.role-selector');
                if (role && item.role) {
                    const resolvedPromptId = resolveJudgePromptId(item.role, index);
                    const hasOption = Array.from(role.options).some((opt) => opt.value === resolvedPromptId);
                    if (hasOption) role.value = resolvedPromptId;
                }
            });
        };

        const applyOutputStackState = (stackId, state) => {
            if (!state || !Array.isArray(state.checks)) return;
            const stack = document.getElementById(stackId);
            if (!stack) return;
            const blocks = Array.from(stack.querySelectorAll('.output-block'));
            blocks.forEach((block, index) => {
                const cb = block.querySelector('.output-checkbox');
                if (cb && typeof state.checks[index] === 'boolean') {
                    cb.checked = state.checks[index];
                }
            });
        };

        const buildSendOverridesFromLegacy = (config) => {
            const collectorStacks = config?.collectorStacks;
            if (!collectorStacks || typeof collectorStacks !== 'object') return null;

            const normalizeChecks = (state) => {
                if (!state) return null;
                if (Array.isArray(state)) return state.map(Boolean);
                if (Array.isArray(state.checks)) return state.checks.map(Boolean);
                if (Array.isArray(state.items)) {
                    return state.items.map((item) => {
                        if (typeof item?.checked === 'boolean') return item.checked;
                        return false;
                    });
                }
                return null;
            };

            const getChecks = (stackId) => normalizeChecks(collectorStacks[stackId]);
            const rounds = Math.max(1, Number(config.roundCounter) || 1);
            const overrides = {};

            if (rounds === 1) {
                const resultsChecks = getChecks('results-stack');
                if (resultsChecks) overrides['r1-models'] = resultsChecks;
            } else {
                const r1Checks = getChecks('resp1-stack');
                if (r1Checks) overrides['r1-models'] = r1Checks;
                for (let r = 2; r < rounds; r++) {
                    const respChecks = getChecks(`resp${r}-stack`);
                    if (respChecks) overrides[`r${r}-models`] = respChecks;
                }
                const resultsChecks = getChecks('results-stack');
                if (resultsChecks) overrides[`r${rounds}-models`] = resultsChecks;
            }

            return Object.keys(overrides).length ? overrides : null;
        };

        const drawInputSplitConnector = (svgId, targetStackId, colorClass) => {
            const svg = document.getElementById(svgId);
            const entryPoint = document.getElementById('entryPoint');
            if (!svg) return;

            const targetStack = document.getElementById(targetStackId);
            const targetIndices = getModelInputIndices(targetStackId);
            if (targetIndices.length === 0) {
                svg.innerHTML = '';
                if (entryPoint) entryPoint.style.marginTop = '26px';
                return;
            }

            const W = 50;
            const splitX = W - 15;
            let html = '';

            const targetYs = targetIndices.map((i) => getBlockCenterYRelativeTo(targetStack, i, svg));
            const targetMinY = Math.min(...targetYs);
            const targetMaxY = Math.max(...targetYs);
            const targetMidY = (targetMinY + targetMaxY) / 2;

            if (entryPoint) {
                if (entryWrapper) {
                    const entryTargetYs = targetIndices.map((i) => getBlockCenterYRelativeTo(targetStack, i, entryWrapper));
                    const entryMidY = (Math.min(...entryTargetYs) + Math.max(...entryTargetYs)) / 2;
                    entryPoint.style.marginTop = `${entryMidY - 9}px`;
                } else {
                    entryPoint.style.marginTop = `${targetMidY - 9}px`;
                }
            }

            html += `<line x1="0" y1="${targetMidY}" x2="${splitX}" y2="${targetMidY}" class="connector-line ${colorClass} flow-anim"/>`;

            if (targetYs.length > 1) {
                html += `<line x1="${splitX}" y1="${targetMinY}" x2="${splitX}" y2="${targetMaxY}" class="merge-line ${colorClass}"/>`;
            }

            targetYs.forEach((y) => {
                html += `<line x1="${splitX}" y1="${y}" x2="${W - 6}" y2="${y}" class="connector-line ${colorClass} flow-anim"/>`;
                html += `<polygon points="${W - 6},${y - 4} ${W},${y} ${W - 6},${y + 4}" class="arrow-head ${colorClass}"/>`;
            });

            svg.innerHTML = html;
        };

        const drawHorizontalConnectors = (svgId, stackId, colorClass) => {
            const svg = document.getElementById(svgId);
            if (!svg) return;

            const indices = getModelSendIndices(stackId);
            if (indices.length === 0) {
                svg.innerHTML = '';
                return;
            }

            const stack = document.getElementById(stackId);
            const W = 50;
            let html = '';
            indices.forEach((i) => {
                const y = getBlockCenterYRelativeTo(stack, i, svg);
                html += `<line x1="0" y1="${y}" x2="${W - 6}" y2="${y}" class="connector-line ${colorClass} flow-anim"/>`;
                html += `<polygon points="${W - 6},${y - 4} ${W},${y} ${W - 6},${y + 4}" class="arrow-head ${colorClass}"/>`;
            });
            svg.innerHTML = html;
        };

        const drawMergeSplitConnector = (svgId, sourceStackId, targetStackId, colorClass, options = {}) => {
            const svg = document.getElementById(svgId);
            if (!svg) return;

            const { sourceMode = 'send', targetMode = 'input' } = options;
            const modeLookup = (stackId, mode) => {
                if (mode === 'input') return getModelInputIndices(stackId);
                if (mode === 'send') return getModelSendIndices(stackId);
                if (mode === 'output') return getOutputCheckedIndices(stackId);
                return [];
            };

            const sourceIndices = modeLookup(sourceStackId, sourceMode);
            const targetIndices = modeLookup(targetStackId, targetMode);

            const sourceStack = document.getElementById(sourceStackId);
            const targetStack = document.getElementById(targetStackId);
            if (!sourceStack || !targetStack || sourceIndices.length === 0 || targetIndices.length === 0) {
                svg.innerHTML = '';
                return;
            }

            const W = 50;
            const mergeX = 15;
            const splitX = W - 15;
            let html = '';

            const sourceYs = sourceIndices.map((i) => getBlockCenterYRelativeTo(sourceStack, i, svg));
            const targetYs = targetIndices.map((i) => getBlockCenterYRelativeTo(targetStack, i, svg));

            const sourceMinY = Math.min(...sourceYs);
            const sourceMaxY = Math.max(...sourceYs);
            const targetMinY = Math.min(...targetYs);
            const targetMaxY = Math.max(...targetYs);
            const sourceMidY = (sourceMinY + sourceMaxY) / 2;
            const targetMidY = (targetMinY + targetMaxY) / 2;

            sourceYs.forEach((y) => {
                html += `<line x1="0" y1="${y}" x2="${mergeX}" y2="${y}" class="connector-line ${colorClass} flow-anim"/>`;
            });

            if (sourceYs.length > 1) {
                html += `<line x1="${mergeX}" y1="${sourceMinY}" x2="${mergeX}" y2="${sourceMaxY}" class="merge-line ${colorClass}"/>`;
            }

            html += `<line x1="${mergeX}" y1="${sourceMidY}" x2="${splitX}" y2="${targetMidY}" class="connector-line ${colorClass} flow-anim"/>`;

            if (targetYs.length > 1) {
                html += `<line x1="${splitX}" y1="${targetMinY}" x2="${splitX}" y2="${targetMaxY}" class="merge-line ${colorClass}"/>`;
            }

            targetYs.forEach((y) => {
                html += `<line x1="${splitX}" y1="${y}" x2="${W - 6}" y2="${y}" class="connector-line ${colorClass} flow-anim"/>`;
                html += `<polygon points="${W - 6},${y - 4} ${W},${y} ${W - 6},${y + 4}" class="arrow-head ${colorClass}"/>`;
            });

            svg.innerHTML = html;
        };

        const updatePipelineAll = () => {
            updatePipelineLayout();
            pipelinePanel.querySelectorAll('.model-block').forEach((block) => {
                const inputCb = block.querySelector('.model-input-checkbox');
                const sendCb = block.querySelector('.model-send-checkbox');
                const sel = block.querySelector('.role-selector');
                const indicator = block.querySelector('.status-indicator');
                if (!inputCb) return;
                if (inputCb.checked) {
                    block.classList.remove('inactive');
                    block.classList.add('active');
                    if (sel) sel.disabled = false;
                    if (sendCb) {
                        sendCb.disabled = false;
                    }
                } else {
                    block.classList.remove('active');
                    block.classList.add('inactive');
                    if (sel) sel.disabled = true;
                    if (sendCb) {
                        sendCb.checked = false;
                        sendCb.disabled = true;
                    }
                    if (indicator) {
                        indicator.className = 'status-indicator';
                        indicator.title = '';
                    }
                }
            });

            pipelinePanel.querySelectorAll('.output-block').forEach((block) => {
                const cb = block.querySelector('.output-checkbox');
                if (!cb) return;
                block.classList.toggle('inactive', !cb.checked);
            });

            drawInputSplitConnector('svg-in-models', 'r1-models', 'active');

            if (roundCounter === 1) {
                drawMergeSplitConnector('svg-stage-output', 'r1-models', 'output-stack', 'brain-flow', {
                    sourceMode: 'send',
                    targetMode: 'output'
                });
            } else {
                drawMergeSplitConnector('svg-r1-r2', 'r1-models', 'r2-models', 'brain-flow', {
                    sourceMode: 'send',
                    targetMode: 'input'
                });
                for (let r = 2; r < roundCounter; r++) {
                    drawMergeSplitConnector(`svg-r${r}-r${r + 1}`, `r${r}-models`, `r${r + 1}-models`, 'brain-flow', {
                        sourceMode: 'send',
                        targetMode: 'input'
                    });
                }
                drawMergeSplitConnector('svg-stage-output', `r${roundCounter}-models`, 'output-stack', 'brain-flow', {
                    sourceMode: 'send',
                    targetMode: 'output'
                });
            }
        };

        const formatPipelineTimestamp = () => {
            const now = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
        };

        const setPipelineRunUi = (isRunning) => {
            if (!pipelineRunBtn) return;
            pipelineRunBtn.disabled = isRunning;
            pipelineRunBtn.textContent = isRunning ? 'Выполняется…' : '▶ Run';
        };

        const getRoundModelsState = (roundIndex) => {
            const stack = document.getElementById(`r${roundIndex}-models`);
            if (!stack) return null;
            const models = Array.from(stack.querySelectorAll('.model-block'))
                .map((block) => {
                    const name = block.querySelector('.model-name')?.textContent?.trim();
                    if (!name) return null;
                    const input = !!block.querySelector('.model-input-checkbox')?.checked;
                    const send = !!block.querySelector('.model-send-checkbox')?.checked;
                    const promptId = block.querySelector('.role-selector')?.value || null;
                    return { name, input, send, promptId };
                })
                .filter(Boolean);
            const inputModels = models.filter((model) => model.input).map((model) => model.name);
            const sendModels = models.filter((model) => model.send).map((model) => model.name);
            return { models, inputModels, sendModels };
        };

        const getPipelineOutputSelection = () => {
            const outputStack = document.getElementById('output-stack');
            const selection = { notes: false, export: false, exportHtml: false };
            if (!outputStack) return selection;
            outputStack.querySelectorAll('.output-block').forEach((block) => {
                const label = block.querySelector('.output-name')?.textContent?.trim().toLowerCase();
                const checked = !!block.querySelector('.output-checkbox')?.checked;
                if (!label || !checked) return;
                if (label.includes('note')) selection.notes = true;
                if (label.includes('html')) {
                    selection.exportHtml = true;
                } else if (label.includes('export')) {
                    selection.export = true;
                }
            });
            return selection;
        };

        const buildResponsesList = (responsesMap, orderedNames = []) => {
            let list = '';
            let count = 0;
            orderedNames.forEach((name) => {
                const output = responsesMap?.[name];
                if (!output || (typeof output === 'string' && output.trim().startsWith('Error:'))) return;
                list += `-------------------------\n\n**${name}:**\n${output}\n\n`;
                count += 1;
            });
            if (count > 0) {
                list += '-------------------------';
            }
            return { list, count };
        };

        const runModelBatch = async ({
            prompt,
            models,
            attachments = [],
            forceNewTabs = true,
            useApiFallback = true,
            timeoutMs = 240000
        }) => {
            if (!models.length) return { responses: {}, missing: [], timedOut: false };
            const payloadBase = {
                type: 'START_FULLPAGE_PROCESS',
                prompt,
                selectedLLMs: models,
                forceNewTabs,
                useApiFallback
            };

            if (attachments.length) {
                const unsupported = models.filter((name) => ATTACH_CAPABILITY[name] === false);
                if (unsupported.length) {
                    showNotification(`Эти LLM могут не поддерживать вложения: ${unsupported.join(', ')}`, 'warn');
                }
            }

            let response = null;
            try {
                response = await sendToBackground({
                    ...payloadBase,
                    attachments: Array.isArray(attachments) ? attachments : []
                });
            } catch (err) {
                if (attachments.length) {
                    console.warn('[RESULTS] Pipeline run failed with attachments, retrying without them', err);
                    response = await sendToBackground(payloadBase);
                } else {
                    throw err;
                }
            }

            if (!response || response.status !== 'process_started') {
                showNotification(`Pipeline: неожиданный ответ background (${response?.status || 'no_response'})`, 'warn');
            }

            return pipelineWaiter.waitForModels(models, { timeoutMs });
        };

        const formatPipelineFinalText = (result) => {
            const lines = [];
            if (result.pipelineName) lines.push(`Pipeline: ${result.pipelineName}`);
            if (result.prompt) lines.push(`Prompt: ${result.prompt}`);
            lines.push('');
            Object.entries(result.finalOutputs || {}).forEach(([name, output]) => {
                if (!output || (typeof output === 'string' && output.trim().startsWith('Error:'))) return;
                lines.push(`--- ${name} ---`);
                lines.push(String(output).trim());
                lines.push('');
            });
            return lines.join('\n').trim();
        };

        const buildPipelineFinalPayload = (result) => ({
            pipelineName: result.pipelineName,
            prompt: result.prompt,
            resolvedPrompt: result.resolvedPrompt,
            finalOutputs: result.finalOutputs,
            pipelineConfig: result.pipelineConfig
        });

        const buildPipelineFinalHtml = (result) => {
            const sections = [];
            Object.entries(result.finalOutputs || {}).forEach(([name, output]) => {
                if (!output || (typeof output === 'string' && output.trim().startsWith('Error:'))) return;
                const text = String(output).trim();
                if (!text) return;
                const htmlContent = convertMarkdownToHTML(text);
                const metadataLine = buildMetadataLine(name);
                const metadataHtml = metadataLine ? `<p class="response-meta">${escapeHtml(metadataLine)}</p>` : '';
                sections.push(`
                    <section class="pipeline-response">
                        <h2>${escapeHtml(name)}</h2>
                        ${metadataHtml}
                        <div class="response-body">${htmlContent}</div>
                    </section>
                `);
            });

            if (!sections.length) return '';

            const promptText = (result.resolvedPrompt || result.prompt || '').trim();
            const promptSection = promptText
                ? `<section class="pipeline-prompt"><h2>Prompt</h2><pre>${escapeHtml(promptText)}</pre></section>`
                : '';
            const title = escapeHtml(result.pipelineName || 'Pipeline Run');

            return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <style>
        body { font-family: Arial, sans-serif; background: #ffffff; color: #111; padding: 24px; line-height: 1.5; }
        h1 { margin: 0 0 16px; font-size: 22px; }
        h2 { margin: 18px 0 10px; font-size: 18px; }
        pre { background: #f6f8fa; padding: 12px; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; }
        .pipeline-response { margin-bottom: 20px; }
        .response-meta { margin: 0 0 10px; color: #555; font-size: 13px; }
        .response-body { background: #f8fafc; padding: 12px; border-radius: 8px; }
        .response-body pre { background: #eef2f7; }
    </style>
</head>
<body>
    <h1>${title}</h1>
    ${promptSection}
    <h2>Final Outputs</h2>
    ${sections.join('\n')}
</body>
</html>`;
        };

        const handlePipelineOutputs = async (result) => {
            const selection = getPipelineOutputSelection();
            const hasAny = selection.notes || selection.export || selection.exportHtml;
            if (!hasAny) return;

            const summaryText = formatPipelineFinalText(result);
            if (selection.notes) {
                if (window.PipelineNotes?.savePipelineRun) {
                    await window.PipelineNotes.savePipelineRun({
                        title: result.pipelineName || 'Pipeline Run',
                        text: summaryText,
                        json: buildPipelineFinalPayload(result)
                    });
                } else if (saveSessionBtn) {
                    saveSessionBtn.click();
                } else {
                    showNotification('Notes недоступны', 'warn');
                }
            }

            if (selection.export) {
                const exportPayload = buildPipelineFinalPayload(result);
                const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `pipeline_run_${formatPipelineTimestamp()}.json`;
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 0);
            }

            if (selection.exportHtml) {
                const htmlContent = buildPipelineFinalHtml(result);
                if (!htmlContent) return;
                const blob = new Blob([htmlContent], { type: 'text/html' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `pipeline_run_${formatPipelineTimestamp()}.html`;
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 0);
            }
        };

        const runPipeline = async () => {
            if (pipelineRunActive) {
                showNotification('Пайплайн уже выполняется', 'warn');
                return;
            }
            if (!promptInput) return;
            const rawPrompt = (promptInput.value || '').trim();
            if (!rawPrompt) {
                alert('Please enter a prompt.');
                return;
            }

            pipelineRunActive = true;
            setPipelineRunUi(true);

            try {
                const pipelineNameText = (pipelineName?.textContent || '').trim();
                const basePrompt = applySelectedModifiersToPrompt(rawPrompt);
                const attachmentsPayload = await buildAttachmentPayload();
                const useApiFallback = apiModeCheckbox ? apiModeCheckbox.checked : true;

                const rounds = [];
                let finalOutputs = {};
                let responsesList = '';

                for (let r = 1; r <= roundCounter; r++) {
                    const roundState = getRoundModelsState(r);
                    if (!roundState || !roundState.inputModels.length) {
                        showNotification(`Pipeline: нет Input моделей в R${r}`, 'warn');
                        return;
                    }

                    const isFirstRound = r === 1;
                    const forceNewTabs = isFirstRound ? (newPagesCheckbox ? newPagesCheckbox.checked : true) : false;
                    let outputs = {};
                    let missing = [];
                    let timedOut = false;
                    let promptByModel = null;
                    let roundPrompt = null;

                    if (isFirstRound) {
                        roundPrompt = basePrompt;
                        const roundResult = await runModelBatch({
                            prompt: basePrompt,
                            models: roundState.inputModels,
                            attachments: attachmentsPayload,
                            forceNewTabs,
                            useApiFallback
                        });
                        outputs = roundResult.responses || {};
                        missing = roundResult.missing || [];
                        timedOut = !!roundResult.timedOut;
                    } else {
                        if (!responsesList) {
                            showNotification(`Pipeline: нет Send выходов в R${r - 1}`, 'warn');
                            return;
                        }
                        const selectedSystemPrompt = getSelectedJudgeSystemPrompt();
                        const orderedPrompts = getOrderedJudgePrompts();
                        const fallbackPrompt = selectedSystemPrompt || orderedPrompts[0] || null;
                        const promptGroups = new Map();

                        roundState.models
                            .filter((model) => model.input)
                            .forEach((model) => {
                                const resolvedId = resolveJudgePromptId(model.promptId);
                                const promptId = resolvedId || fallbackPrompt?.id || '';
                                if (!promptId) return;
                                if (!promptGroups.has(promptId)) {
                                    promptGroups.set(promptId, []);
                                }
                                promptGroups.get(promptId).push(model.name);
                            });

                        if (!promptGroups.size) {
                            showNotification(`Pipeline: не выбран prompt судьи в R${r}`, 'warn');
                            return;
                        }

                        promptByModel = {};
                        for (const [promptId, models] of promptGroups.entries()) {
                            const promptDef = getJudgePromptById(promptId) || fallbackPrompt;
                            const evaluationPrompt = buildJudgeEvaluationPrompt(
                                promptDef ? promptDef.text : '',
                                rawPrompt,
                                responsesList
                            );
                            const batchResult = await runModelBatch({
                                prompt: evaluationPrompt,
                                models,
                                attachments: [],
                                forceNewTabs,
                                useApiFallback
                            });
                            outputs = { ...outputs, ...(batchResult.responses || {}) };
                            missing = missing.concat(batchResult.missing || []);
                            if (batchResult.timedOut) timedOut = true;
                            models.forEach((name) => {
                                promptByModel[name] = promptDef?.id || promptId;
                            });
                        }
                    }

                    rounds.push({
                        round: r,
                        stage: r === 1 ? 'Models' : 'Judge',
                        prompt: roundPrompt,
                        promptByModel,
                        models: roundState.models,
                        inputModels: roundState.inputModels,
                        sendModels: roundState.sendModels,
                        outputs,
                        missing,
                        timedOut
                    });

                    const { list } = buildResponsesList(outputs, roundState.sendModels);
                    if (r < roundCounter) {
                        if (!list) {
                            showNotification(`Pipeline: нет Send выходов в R${r}`, 'warn');
                            return;
                        }
                        responsesList = list;
                    } else {
                        roundState.sendModels.forEach((name) => {
                            const output = outputs[name];
                            if (!output || (typeof output === 'string' && output.trim().startsWith('Error:'))) return;
                            finalOutputs[name] = output;
                        });
                    }
                }

                const result = {
                    pipelineName: pipelineNameText,
                    prompt: rawPrompt,
                    resolvedPrompt: basePrompt,
                    rounds,
                    finalOutputs,
                    pipelineConfig: capturePipelineConfig()
                };

                await handlePipelineOutputs(result);

                if (newPagesCheckbox && newPagesCheckbox.checked) {
                    newPagesCheckbox.checked = false;
                    storeNewPagesState(false);
                }
            } catch (err) {
                console.error('[RESULTS] Pipeline run failed', err);
                showNotification(`Pipeline: ошибка (${err?.message || String(err)})`, 'error');
            } finally {
                pipelineRunActive = false;
                pipelineWaiter.reset();
                setPipelineRunUi(false);
            }
        };

        const resetPipeline = () => {
            if (confirm('Reset to default?')) {
                location.reload();
            }
        };

        const addRound = () => {
            if (!insertionPoint) return;

            if (roundCounter === 1) {
                roundCounter = 2;
                const judgeBlocksHtml = buildModelBlocksHtml(DEFAULT_JUDGE_INDICES, true);
                const newRoundHTML = `
                    <div class="connector-group" data-round="2">
                        <svg class="connector-svg" id="svg-r1-r2"></svg>
                    </div>
                    <div class="stage-column" id="round2" data-round="2">
                        <div class="stage-label"><span class="round-badge">R2</span> Judge</div>
                        <div class="model-stack" id="r2-models">
                            ${judgeBlocksHtml}
                        </div>
                    </div>
                `;

                insertionPoint.insertAdjacentHTML('beforebegin', newRoundHTML);
            } else {
                const currentLastJudge = roundCounter;
                roundCounter++;

                const judgeBlocksHtml = buildModelBlocksHtml(DEFAULT_LATE_JUDGE_INDICES, true);
                const newRoundHTML = `
                    <div class="connector-group" data-round="${roundCounter}">
                        <svg class="connector-svg" id="svg-r${currentLastJudge}-r${roundCounter}"></svg>
                    </div>
                    <div class="stage-column" id="round${roundCounter}" data-round="${roundCounter}">
                        <div class="stage-label"><span class="round-badge">R${roundCounter}</span> Judge</div>
                        <div class="model-stack" id="r${roundCounter}-models">
                            ${judgeBlocksHtml}
                        </div>
                    </div>
                `;

                insertionPoint.insertAdjacentHTML('beforebegin', newRoundHTML);
            }

            if (pipelineRemoveRoundBtn) {
                pipelineRemoveRoundBtn.style.display = 'flex';
            }
            updatePipelineAll();
        };

        const removeLastRound = () => {
            if (roundCounter <= 1) return;

            pipelinePanel.querySelectorAll(`[data-round="${roundCounter}"]`).forEach((el) => el.remove());
            roundCounter--;
            if (roundCounter <= 1 && pipelineRemoveRoundBtn) {
                pipelineRemoveRoundBtn.style.display = 'none';
            }

            updatePipelineAll();
        };

        const applyPipelineConfig = (config = {}) => {
            if (!config || typeof config !== 'object') return;
            const targetRounds = Math.max(1, Number(config.roundCounter) || 1);
            while (roundCounter > targetRounds) {
                removeLastRound();
            }
            while (roundCounter < targetRounds) {
                addRound();
            }

            const modelStacks = config.modelStacks && typeof config.modelStacks === 'object' ? config.modelStacks : {};
            const sendOverrides = config.version >= 2 ? null : buildSendOverridesFromLegacy(config);
            Object.entries(modelStacks).forEach(([stackId, state]) => {
                applyModelStackState(stackId, state, sendOverrides);
            });

            if (config.outputStack) {
                applyOutputStackState('output-stack', config.outputStack);
            }

            updatePipelineAll();
        };

        const applyPipelineByName = (name) => {
            if (!name) return;
            const config = pipelineStore.pipelines[name];
            if (config) {
                applyPipelineConfig(config);
            }
        };

        const findPipelineItemByName = (name) => {
            if (!pipelineItems || !name) return null;
            return Array.from(pipelineItems.querySelectorAll('.pipeline-item'))
                .find((item) => item.dataset.name === name) || null;
        };

        const truncatePipelineName = (name, limit = 15) => {
            const fullName = String(name || '').trim();
            if (!fullName) return { fullName: '', displayName: '' };
            if (fullName.length <= limit) return { fullName, displayName: fullName };
            return { fullName, displayName: `${fullName.slice(0, limit)}...` };
        };

        const buildPipelineItem = (name, options = {}) => {
            const { active = false, isLast = false } = options;
            const { fullName, displayName } = truncatePipelineName(name, 15);
            const item = document.createElement('div');
            item.className = `pipeline-item${active ? ' active' : ''}`;
            item.dataset.name = fullName;
            item.innerHTML = `
                <input type="radio" name="pipeline" class="pipeline-radio"${active ? ' checked' : ''}>
                <span class="pipeline-item-name" title="${escapeHtml(fullName)}">${escapeHtml(displayName)}</span>
                ${isLast ? '<span class="last-badge">last</span>' : ''}
            `;
            return item;
        };

        const renamePipeline = (oldName, newName) => {
            const trimmedOld = String(oldName || '').trim();
            const trimmedNew = String(newName || '').trim();
            if (!trimmedOld || !trimmedNew) return false;
            if (trimmedOld === trimmedNew) return true;

            const exists = pipelineStore.order.includes(trimmedNew);
            if (exists) {
                const confirmed = confirm(`Pipeline "${trimmedNew}" already exists. Replace it?`);
                if (!confirmed) return false;
            }

            const hasOldConfig = Object.prototype.hasOwnProperty.call(pipelineStore.pipelines, trimmedOld);
            const hasNewConfig = Object.prototype.hasOwnProperty.call(pipelineStore.pipelines, trimmedNew);

            if (hasOldConfig) {
                pipelineStore.pipelines[trimmedNew] = pipelineStore.pipelines[trimmedOld];
            } else if (!hasNewConfig && exists) {
                pipelineStore.pipelines[trimmedNew] = pipelineStore.pipelines[trimmedOld];
            }

            if (trimmedOld !== trimmedNew) {
                delete pipelineStore.pipelines[trimmedOld];
            }

            const idx = pipelineStore.order.indexOf(trimmedOld);
            if (idx !== -1) {
                pipelineStore.order[idx] = trimmedNew;
            }
            pipelineStore.order = pipelineStore.order.filter((name, index, list) => list.indexOf(name) === index);

            if (pipelineStore.lastSaved === trimmedOld) pipelineStore.lastSaved = trimmedNew;
            if (pipelineStore.active === trimmedOld) pipelineStore.active = trimmedNew;

            renderPipelineList(pipelineStore.order, pipelineStore.active, pipelineStore.lastSaved);
            persistPipelineStore();
            return true;
        };

        const startPipelineRename = (item) => {
            if (!item || item.classList.contains('is-editing')) return;
            const nameSpan = item.querySelector('.pipeline-item-name');
            if (!nameSpan) return;
            const originalName = item.dataset.name || nameSpan.getAttribute('title') || nameSpan.textContent.trim();
            if (!originalName) return;

            item.classList.add('is-editing');
            nameSpan.style.display = 'none';

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'pipeline-item-edit';
            input.value = originalName;
            input.setAttribute('aria-label', 'Rename pipeline');

            const lastBadge = item.querySelector('.last-badge');
            if (lastBadge) {
                item.insertBefore(input, lastBadge);
            } else {
                item.appendChild(input);
            }

            input.focus();
            input.select();

            let finished = false;
            const cleanup = () => {
                if (finished) return;
                finished = true;
                input.remove();
                nameSpan.style.display = '';
                item.classList.remove('is-editing');
            };

            const commit = () => {
                if (finished) return;
                const nextName = input.value.trim();
                cleanup();
                if (!nextName || nextName === originalName) return;
                const renamed = renamePipeline(originalName, nextName);
                if (!renamed) {
                    renderPipelineList(pipelineStore.order, pipelineStore.active, pipelineStore.lastSaved);
                }
            };

            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    commit();
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    cleanup();
                }
            });
            input.addEventListener('blur', commit);
        };

        const renderPipelineList = (names = [], activeName = '', lastSavedName = '') => {
            if (!pipelineItems) return;
            const uniqueNames = Array.from(new Set(names.filter((name) => typeof name === 'string' && name.trim())));
            pipelineItems.innerHTML = '';
            const chunkSize = 12;
            for (let i = 0; i < uniqueNames.length; i += chunkSize) {
                const row = document.createElement('div');
                row.className = 'pipeline-items-row';
                uniqueNames.slice(i, i + chunkSize).forEach((name) => {
                    const item = buildPipelineItem(name, {
                        active: name === activeName,
                        isLast: name === lastSavedName
                    });
                    row.appendChild(item);
                });
                pipelineItems.appendChild(row);
            }
            if (pipelineName) {
                pipelineName.textContent = activeName || '';
            }
        };

        const getPipelineNamesFromDom = () => {
            if (!pipelineItems) return [];
            return Array.from(pipelineItems.querySelectorAll('.pipeline-item'))
                .map((item) => item.dataset.name)
                .filter((name) => typeof name === 'string' && name.trim());
        };

        const addPipelineToList = (name, options = {}) => {
            if (!pipelineItems) return;
            const trimmed = String(name || '').trim();
            if (!trimmed) return;
            const { makeActive = true, markLast = true } = options;
            if (!pipelineStore.order.includes(trimmed)) {
                pipelineStore.order.push(trimmed);
            }
            if (makeActive) {
                pipelineStore.active = trimmed;
            }
            if (markLast) {
                pipelineStore.lastSaved = trimmed;
            }
            renderPipelineList(pipelineStore.order, pipelineStore.active, pipelineStore.lastSaved);
        };

        const selectPipeline = (item, options = {}) => {
            if (!pipelineItems || !item) return;
            pipelineItems.querySelectorAll('.pipeline-item').forEach((el) => el.classList.remove('active'));
            pipelineItems.querySelectorAll('.pipeline-radio').forEach((radio) => {
                radio.checked = false;
            });

            item.classList.add('active');
            const radio = item.querySelector('.pipeline-radio');
            if (radio) radio.checked = true;
            const name = item.dataset.name || '';
            if (pipelineName) {
                pipelineName.textContent = name;
            }
            if (options.applyConfig !== false) {
                applyPipelineByName(name);
            }
            if (options.persist !== false) {
                pipelineStore.active = name;
                persistPipelineStore();
            }
        };

        const resetToMinimalTemplate = () => {
            pipelinePanel.querySelectorAll('[data-round]').forEach((el) => el.remove());

            roundCounter = 1;
            if (pipelineRemoveRoundBtn) {
                pipelineRemoveRoundBtn.style.display = 'none';
            }

            updatePipelineAll();
        };

        const savePipeline = () => {
            const currentName = pipelineName ? pipelineName.textContent : '';
            const name = prompt('Pipeline name:', currentName || '');
            if (name && name.trim()) {
                const trimmed = name.trim();
                const config = capturePipelineConfig();
                pipelineStore.pipelines[trimmed] = config;
                if (!pipelineStore.order.includes(trimmed)) {
                    pipelineStore.order.push(trimmed);
                }
                pipelineStore.lastSaved = trimmed;
                pipelineStore.active = trimmed;
                persistPipelineStore();
                addPipelineToList(trimmed, { makeActive: true, markLast: true });
            }
        };

        const addNewPipeline = () => {
            const name = prompt('New pipeline name:');
            if (name && name.trim()) {
                resetToMinimalTemplate();
                const trimmed = name.trim();
                const config = capturePipelineConfig();
                pipelineStore.pipelines[trimmed] = config;
                if (!pipelineStore.order.includes(trimmed)) {
                    pipelineStore.order.push(trimmed);
                }
                pipelineStore.lastSaved = trimmed;
                pipelineStore.active = trimmed;
                persistPipelineStore();
                addPipelineToList(trimmed, { makeActive: true, markLast: true });
            }
        };

        const deleteActivePipeline = () => {
            const activeName = (pipelineName?.textContent || pipelineStore.active || '').trim();
            if (!activeName) return;
            const confirmed = confirm(`Delete pipeline "${activeName}"?`);
            if (!confirmed) return;

            delete pipelineStore.pipelines[activeName];
            pipelineStore.order = pipelineStore.order.filter((name) => name !== activeName);
            if (pipelineStore.lastSaved === activeName) {
                pipelineStore.lastSaved = '';
            }
            const nextActive = pipelineStore.order[0] || '';
            pipelineStore.active = nextActive;
            persistPipelineStore();

            renderPipelineList(pipelineStore.order, nextActive, pipelineStore.lastSaved);

            if (nextActive) {
                const nextItem = findPipelineItemByName(nextActive);
                if (nextItem) {
                    selectPipeline(nextItem, { applyConfig: !!pipelineStore.pipelines[nextActive], persist: false });
                }
            } else if (pipelineName) {
                pipelineName.textContent = '';
            }
        };

        let pipelineImportInput = null;

        const exportPipelines = () => {
            const payload = buildPipelineExportPayload();
            const json = JSON.stringify(payload, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const link = document.createElement('a');
            link.href = url;
            link.download = `pipelines-${stamp}.json`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 0);
        };

        const handlePipelineImportFile = (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const parsed = JSON.parse(String(reader.result || ''));
                    const normalized = normalizePipelineStore(parsed);
                    const hasExisting = pipelineStore.order.length || Object.keys(pipelineStore.pipelines).length;
                    if (hasExisting) {
                        const confirmed = confirm('Replace existing pipelines with imported data?');
                        if (!confirmed) return;
                    }
                    pipelineStore.version = normalized.version || pipelineStore.version;
                    pipelineStore.pipelines = normalized.pipelines;
                    pipelineStore.order = normalized.order;
                    pipelineStore.lastSaved = normalized.lastSaved;
                    pipelineStore.active = normalized.active;
                    persistPipelineStore();

                    const activeName = pipelineStore.active || pipelineStore.order[0] || '';
                    renderPipelineList(pipelineStore.order, activeName, pipelineStore.lastSaved);
                    if (activeName) {
                        const activeItem = findPipelineItemByName(activeName);
                        if (activeItem) {
                            selectPipeline(activeItem, {
                                applyConfig: !!pipelineStore.pipelines[activeName],
                                persist: false
                            });
                        }
                    } else if (pipelineName) {
                        pipelineName.textContent = '';
                    }
                } catch (_) {
                    alert('Invalid pipelines JSON.');
                }
            };
            reader.readAsText(file);
        };

        const importPipelines = () => {
            if (!pipelineImportInput) {
                pipelineImportInput = document.createElement('input');
                pipelineImportInput.type = 'file';
                pipelineImportInput.accept = 'application/json';
                pipelineImportInput.style.display = 'none';
                pipelineImportInput.addEventListener('change', handlePipelineImportFile);
                document.body.appendChild(pipelineImportInput);
            }
            pipelineImportInput.value = '';
            pipelineImportInput.click();
        };

        const initPipelineList = async () => {
            await readPipelineStore();
            const domNames = getPipelineNamesFromDom();
            if (!pipelineStore.order.length) {
                pipelineStore.order = domNames.slice();
            } else {
                domNames.forEach((name) => {
                    if (!pipelineStore.order.includes(name)) {
                        pipelineStore.order.push(name);
                    }
                });
            }
            const domActive = pipelineItems?.querySelector('.pipeline-item.active')?.dataset.name || '';
            const activeName = pipelineStore.active || domActive || pipelineStore.order[0] || '';
            renderPipelineList(pipelineStore.order, activeName, pipelineStore.lastSaved);
            const activeItem = activeName ? findPipelineItemByName(activeName) : null;
            if (activeItem) {
                selectPipeline(activeItem, {
                    applyConfig: !!pipelineStore.pipelines[activeName],
                    persist: false
                });
                pipelineStore.active = activeName;
            }
            persistPipelineStore();
        };

        pipelinePanel.addEventListener('dblclick', (event) => {
            const label = event.target.closest('.stage-label');
            if (!label || !pipelinePanel.contains(label)) return;
            const labelText = (label.textContent || '').toLowerCase();
            const isModels = labelText.includes('models');
            const isJudge = labelText.includes('judge');
            const isOutput = labelText.includes('output');
            if (!isModels && !isJudge && !isOutput) return;

            let modelStack = null;
            let outputStack = null;
            let topJudgeSelected = false;
            let topJudgePromptId = null;
            let defaultJudgePromptId = null;

            if (isModels || isJudge) {
                const stageColumn = label.closest('.stage-column');
                modelStack = stageColumn ? stageColumn.querySelector('.model-stack') : null;
                if (isJudge && modelStack) {
                    const blocks = Array.from(modelStack.querySelectorAll('.model-block'));
                    const topBlock = blocks[0];
                    topJudgeSelected = !!topBlock?.querySelector('.model-input-checkbox')?.checked;
                    topJudgePromptId = topBlock?.querySelector('.role-selector')?.value || null;
                    defaultJudgePromptId = getCriticalJudgePromptId();
                }
            } else if (isOutput) {
                const stageColumn = label.closest('.stage-column');
                outputStack = stageColumn ? stageColumn.querySelector('.output-stack') : null;
            }

            let shouldCheck = true;
            if (outputStack) {
                shouldCheck = !areAllChecked(outputStack, '.output-checkbox');
            } else if (modelStack) {
                const allInputs = areAllChecked(modelStack, '.model-input-checkbox');
                const allSends = areAllChecked(modelStack, '.model-send-checkbox');
                shouldCheck = !(allInputs && allSends);
            } else {
                return;
            }

            let changed = false;
            if (modelStack) {
                changed = setCheckboxesState(modelStack, '.model-input-checkbox', shouldCheck) || changed;
                changed = setCheckboxesState(modelStack, '.model-send-checkbox', shouldCheck) || changed;
            }
            if (outputStack) {
                changed = setCheckboxesState(outputStack, '.output-checkbox', shouldCheck) || changed;
            }

            if (changed) {
                updatePipelineAll();
                if (isJudge && modelStack && shouldCheck) {
                    const targetPromptId = topJudgeSelected
                        ? (topJudgePromptId || defaultJudgePromptId)
                        : defaultJudgePromptId;
                    if (targetPromptId) {
                        modelStack.querySelectorAll('.role-selector').forEach((selector) => {
                            const hasOption = Array.from(selector.options).some((opt) => opt.value === targetPromptId);
                            if (hasOption) selector.value = targetPromptId;
                        });
                    }
                }
            }
        });

        pipelinePanel.addEventListener('change', (event) => {
            const target = event.target;
            if (!target) return;
            if (target.matches('.model-input-checkbox')) {
                const block = target.closest('.model-block');
                const sendCb = block?.querySelector('.model-send-checkbox');
                if (target.checked && sendCb) {
                    sendCb.checked = true;
                }
            }
            if (target.matches('input[type="checkbox"]') || target.matches('.role-selector')) {
                updatePipelineAll();
            }
        });

        pipelineResetBtn?.addEventListener('click', resetPipeline);
        pipelineSaveBtn?.addEventListener('click', savePipeline);
        pipelineDeleteBtn?.addEventListener('click', deleteActivePipeline);
        pipelineExportBtn?.addEventListener('click', exportPipelines);
        pipelineImportBtn?.addEventListener('click', importPipelines);
        pipelineRunBtn?.addEventListener('click', runPipeline);
        pipelineAddBtn?.addEventListener('click', addNewPipeline);
        pipelineAddRoundBtn?.addEventListener('click', addRound);
        pipelineRemoveRoundBtn?.addEventListener('click', removeLastRound);
        pipelineCloseBtn?.addEventListener('click', startRightSidebarClose);

        pipelineItems?.addEventListener('click', (event) => {
            const item = event.target.closest('.pipeline-item');
            if (!item || !pipelineItems.contains(item)) return;
            selectPipeline(item);
        });

        await initPipelineList();
        updatePipelineAll();
    }

    if (notesTree) {
        const notesClient = globalThis.NotesClient;
        if (!notesClient) {
            console.warn('[results] NotesClient is unavailable');
        } else {
            const scratchConfig = { origin: 'comparator', key: 'scratch', title: 'Comparator Draft' };
            const NOTES_ACTIVE_TAB_KEY = 'notes_active_tab';
            const SESSIONS_STORAGE_KEY = 'llm_saved_sessions_v1';
            const noteCache = new Map();
            const tabCache = new Map();
            const lastActiveByTab = new Map();
            const childrenCache = new Map();
            const loadedChildren = new Set();
            const loadingChildren = new Map();
            const expandedByTab = new Map();
            const sessionsState = {
                sessions: [],
                selectedId: null,
                dragId: null,
                dragOverId: null,
                dragPosition: null,
                isActive: false,
                defaultTitle: notesSidebarTitle?.textContent || 'Заметки'
            };
            let sessionClickTimer = null;
            const sessionPreview = {
                isActive: false,
                text: '',
                capturedAt: 0
            };
            const state = {
                tabId: null,
                defaultTabId: null,
                activeNoteId: null,
                selectedNoteIds: new Set(),
                anchorNoteId: null,
                lastSavedText: '',
                lastSavedHtml: '',
                pendingSave: false,
                refreshInFlight: false,
                saveTimer: null,
                listRefreshing: false,
                tabs: [],
                notes: [],
                searchQuery: '',
                totalNoteIds: [],
                totalNoteIdsKnown: false
            };
            editorState = {
                mode: 'PROMPT',
                noteId: null,
                originalText: '',
                suppressInput: false,
                suppressTitleSync: false,
                isTitleEditing: false
            };
            const defaultStatusText = notesStatus?.textContent || 'Stored locally on this device.';
            let statusTimer = null;
            let searchToken = 0;
            let listRefreshPending = false;
            let childrenPrefetchTimer = null;
            let childrenPrefetchToken = 0;
            let notesClickTimer = null;
            let notesClickTargetId = null;
            let notesClickTime = 0;
            const NOTE_DBLCLICK_DELAY = 320;

            const setStatus = (message, ttl = 1600) => {
                if (!notesStatus) return;
                if (statusTimer) clearTimeout(statusTimer);
                notesStatus.textContent = message || defaultStatusText;
                if (message) {
                    statusTimer = setTimeout(() => {
                        notesStatus.textContent = defaultStatusText;
                    }, ttl);
                }
            };

            const formatStatusError = (prefix, error) => {
                const message = String(error?.message || '').trim();
                if (!message) return prefix;
                const compact = message.length > 140 ? `${message.slice(0, 140).trim()}...` : message;
                return `${prefix}: ${compact}`;
            };

            const syncPromptValue = (value, { dispatch = false } = {}) => {
                if (!promptInput) return;
                promptInput.value = String(value || '');
                if (dispatch) {
                    promptInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
            };

            const getNoteViewHtml = () => {
                if (!promptNoteView) return '';
                return sanitizeInlineHtml(promptNoteView.innerHTML || '').trim();
            };

            const getNoteViewText = (html) => {
                if (html) return plainTextFromHtml(html);
                if (!promptNoteView) return '';
                return String(promptNoteView.innerText || promptNoteView.textContent || '').trim();
            };

            const updateNoteHtmlTitle = (html, title) => {
                if (!html) return '';
                const container = document.createElement('div');
                container.innerHTML = html;
                const walker = document.createTreeWalker(
                    container,
                    NodeFilter.SHOW_TEXT,
                    {
                        acceptNode: (node) =>
                            String(node?.nodeValue || '').trim()
                                ? NodeFilter.FILTER_ACCEPT
                                : NodeFilter.FILTER_SKIP
                    }
                );
                const firstText = walker.nextNode();
                if (firstText) {
                    firstText.nodeValue = title;
                } else {
                    container.insertAdjacentText('afterbegin', title);
                }
                return sanitizeInlineHtml(container.innerHTML || '').trim();
            };

            const setNoteViewContent = ({ text = '', html = '', textOverride = null } = {}) => {
                if (!promptNoteView) return;
                const sanitizedHtml = sanitizeInlineHtml(html).trim();
                editorState.suppressInput = true;
                if (sanitizedHtml) {
                    promptNoteView.innerHTML = sanitizedHtml;
                } else {
                    promptNoteView.textContent = String(text || '');
                }
                editorState.suppressInput = false;
                const htmlSnapshot = getNoteViewHtml();
                const resolvedText = typeof textOverride === 'string'
                    ? textOverride
                    : getNoteViewText(htmlSnapshot);
                syncPromptValue(resolvedText);
                state.lastSavedText = resolvedText;
                state.lastSavedHtml = htmlSnapshot;
            };

            const shouldShowRichPrompt = () => editorState.mode !== 'PROMPT' || useInputRichMode;

            const isPromptRichEditable = () =>
                editorState.mode === 'EDITING' || (editorState.mode === 'PROMPT' && useInputRichMode);

            const getEditorContent = () => {
                if (shouldShowRichPrompt() && promptNoteView) {
                    const html = getNoteViewHtml();
                    const text = getNoteViewText(html);
                    return { text, html };
                }
                return { text: promptInput ? String(promptInput.value || '') : '', html: '' };
            };

            const getEditorValue = () => getEditorContent().text;

            const setEditorValue = (value) => {
                if (!promptInput) return;
                const nextValue = typeof value === 'string' ? value : '';
                editorState.suppressInput = true;
                setPromptContent(nextValue);
                editorState.suppressInput = false;
                state.lastSavedText = nextValue;
            };

            const promptDraft = {
                text: '',
                wasEmpty: true,
                capturedAt: 0
            };

            const capturePromptDraft = () => {
                if (!promptInput) return;
                if (editorState.mode !== 'PROMPT') return;
                const currentText = getEditorValue();
                promptDraft.text = currentText;
                promptDraft.wasEmpty = currentText.trim() === '';
                promptDraft.capturedAt = Date.now();
            };

            const restorePromptDraft = () => {
                if (!promptInput) return false;
                if (promptDraft.wasEmpty) return false;
                setEditorValue(promptDraft.text);
                if (typeof syncRichViewFromPrompt === 'function' && useInputRichMode) {
                    syncRichViewFromPrompt();
                }
                return true;
            };

            const updatePromptViewMode = () => {
                if (promptContainer) {
                    promptContainer.classList.toggle('is-note-editing', editorState.mode === 'EDITING');
                    promptContainer.classList.toggle('is-note-viewing', shouldShowRichPrompt());
                }
                if (promptNoteView) {
                    const isEditable = isPromptRichEditable();
                    promptNoteView.setAttribute('contenteditable', isEditable ? 'true' : 'false');
                    promptNoteView.setAttribute('aria-readonly', isEditable ? 'false' : 'true');
                }
            };

            const setEditorMode = (mode, { noteId = null, originalText = '' } = {}) => {
                editorState.mode = mode;
                editorState.noteId = noteId;
                editorState.originalText = originalText;
                editorState.suppressTitleSync = false;
                editorState.isTitleEditing = false;
                updatePromptViewMode();
                if (promptNoteView && mode === 'EDITING') {
                    requestAnimationFrame(() => {
                        promptNoteView.focus();
                    });
                }
                syncSelectionStyles();
            };

            syncPromptViewMode = updatePromptViewMode;
            setPromptEditorMode = setEditorMode;
            syncRichViewFromPrompt = () => {
                if (!promptInput || !promptNoteView) return;
                const promptText = String(promptInput.value || '');
                const existingHtml = getNoteViewHtml();
                if (existingHtml) {
                    const existingText = getNoteViewText(existingHtml);
                    if (existingText === promptText) return;
                }
                setNoteViewContent({ text: promptText, html: '' });
            };
            syncPromptFromRichView = () => {
                if (!promptInput || !promptNoteView) return;
                const html = getNoteViewHtml();
                const text = getNoteViewText(html);
                syncPromptValue(text, { dispatch: true });
            };
            applyRichInputContent = ({ text = '', html = '', textOverride = null } = {}) => {
                if (!promptNoteView) return false;
                setNoteViewContent({ text, html, textOverride });
                return true;
            };
            updatePromptViewMode();
            if (useInputRichMode) {
                syncRichViewFromPrompt();
            }

            const buildNoteTitleFromText = (text, fallback = 'New') => {
                const value = String(text || '').trim();
                if (!value) return fallback;
                const firstLine = value.split(/\n/)[0].trim();
                return firstLine || fallback;
            };

            const normalizeNoteTitle = (value) => String(value || '').replace(/\s+/g, ' ').trim();

            const buildTextWithTitle = (text, title) => {
                const safeTitle = normalizeNoteTitle(title);
                const baseText = String(text || '');
                if (!safeTitle) return baseText;
                if (!baseText) return safeTitle;
                const lines = baseText.split(/\r?\n/);
                if (!lines.length) return safeTitle;
                if (lines[0] === safeTitle) return baseText;
                lines[0] = safeTitle;
                return lines.join('\n');
            };

            const getEditableTitleTarget = (target) => {
                const baseEl = target?.nodeType === Node.TEXT_NODE ? target.parentElement : target;
                const titleEl = baseEl?.closest?.('.notes-tree-title') || null;
                if (!titleEl || !titleEl.isContentEditable) return null;
                return titleEl;
            };

            const updateEditingTitle = (text) => {
                if (!notesTree || editorState.mode !== 'EDITING' || !editorState.noteId) return;
                const fallback = noteCache.get(editorState.noteId)?.title || 'New';
                const nextTitle = buildNoteTitleFromText(text, fallback);
                const titleEl = notesTree.querySelector(`.notes-tree-item[data-note-id="${editorState.noteId}"] .notes-tree-title`);
                if (titleEl && titleEl.isContentEditable && document.activeElement === titleEl) return;
                if (titleEl) titleEl.textContent = nextTitle;
            };

            const restoreEditingTitle = () => {
                if (!notesTree || !editorState.noteId) return;
                const savedTitle = noteCache.get(editorState.noteId)?.title || 'New';
                const titleEl = notesTree.querySelector(`.notes-tree-item[data-note-id="${editorState.noteId}"] .notes-tree-title`);
                if (titleEl) titleEl.textContent = savedTitle;
            };

            const clearNoteSelection = () => {
                state.activeNoteId = null;
                state.anchorNoteId = null;
                state.selectedNoteIds.clear();
                syncSelectionStyles();
                setActiveTitle(null);
            };

            const exitNotesMode = async () => {
                if (editorState.mode === 'PROMPT') return;
                if (editorState.mode === 'EDITING') {
                    if (!shouldAutosaveContent(getEditorContent())) {
                        restoreEditingTitle();
                    }
                    await flushSave();
                }
                setEditorMode('PROMPT');
                const restored = restorePromptDraft();
                if (!restored) {
                    state.lastSavedText = getEditorValue();
                }
                clearNoteSelection();
            };

            const getExpandedSet = () => {
                if (!state.tabId) return new Set();
                if (!expandedByTab.has(state.tabId)) {
                    expandedByTab.set(state.tabId, new Set());
                }
                return expandedByTab.get(state.tabId);
            };

            const isExpanded = (noteId) => getExpandedSet().has(noteId);

            const setExpanded = (noteId, expanded) => {
                if (!state.tabId) return;
                const set = getExpandedSet();
                if (expanded) {
                    set.add(noteId);
                } else {
                    set.delete(noteId);
                }
            };

            const clearChildrenCache = () => {
                childrenCache.clear();
                loadedChildren.clear();
                loadingChildren.clear();
                state.totalNoteIds = [];
                state.totalNoteIdsKnown = false;
            };

            const buildAllNotesMap = async () => {
                await ensureSearchTreeLoaded();
                const map = new Map();
                const visit = (list = []) => {
                    list.forEach((note) => {
                        if (!note || map.has(note.id)) return;
                        map.set(note.id, note);
                        const children = childrenCache.get(note.id) || [];
                        if (children.length) visit(children);
                    });
                };
                visit(state.notes || []);
                state.totalNoteIds = Array.from(map.keys());
                state.totalNoteIdsKnown = true;
                return map;
            };

            const getAllNoteIds = async () => {
                const map = await buildAllNotesMap();
                return Array.from(map.keys());
            };

            const syncSelectAllIndicator = async () => {
                if (!notesSelectAll) return;
                let total = state.totalNoteIdsKnown ? state.totalNoteIds.length : 0;
                const selectedCount = state.selectedNoteIds.size;
                if (!state.totalNoteIdsKnown) {
                    notesSelectAll.checked = false;
                    notesSelectAll.indeterminate = selectedCount > 0;
                    return;
                }
                notesSelectAll.checked = total > 0 && selectedCount === total;
                notesSelectAll.indeterminate = selectedCount > 0 && selectedCount < total;
            };

            const fetchChildren = async (noteId) => {
                if (!noteId || !state.tabId) return [];
                if (loadedChildren.has(noteId)) {
                    return childrenCache.get(noteId) || [];
                }
                if (loadingChildren.has(noteId)) {
                    return loadingChildren.get(noteId);
                }
                const promise = notesClient
                    .listChildren({ tabId: state.tabId, parentId: noteId })
                    .then((result) => {
                        const notes = result?.notes || [];
                        childrenCache.set(noteId, notes);
                        loadedChildren.add(noteId);
                        loadingChildren.delete(noteId);
                        return notes;
                    })
                    .catch((error) => {
                        console.warn('[results] failed to load children', error);
                        loadingChildren.delete(noteId);
                        return [];
                    });
                loadingChildren.set(noteId, promise);
                return promise;
            };

            const scheduleChildrenPrefetch = () => {
                if (childrenPrefetchTimer) return;
                childrenPrefetchTimer = setTimeout(async () => {
                    childrenPrefetchTimer = null;
                    if (!notesTree || !state.tabId) return;
                    const ids = Array.from(notesTree.querySelectorAll('.notes-tree-item'))
                        .map((item) => item.dataset.noteId)
                        .filter(Boolean);
                    const pending = ids.filter((id) => !loadedChildren.has(id) && !loadingChildren.has(id));
                    if (!pending.length) return;
                    const token = ++childrenPrefetchToken;
                    await Promise.all(pending.map((id) => fetchChildren(id)));
                    if (token !== childrenPrefetchToken) return;
                    renderNotesList(state.notes);
                }, 0);
            };

            const isDescendantNote = (noteId, ancestorId) => {
                if (!noteId || !ancestorId || noteId === ancestorId) return false;
                let current = noteCache.get(noteId);
                let guard = 0;
                while (current && current.parentId && guard < 50) {
                    if (current.parentId === ancestorId) return true;
                    current = noteCache.get(current.parentId);
                    guard += 1;
                }
                return false;
            };

            const getTabLabel = (tab, index) => {
                const name = String(tab?.name || '').trim();
                if (name) return name;
                return index === 0 ? 'Home' : `Tab ${index + 1}`;
            };

            const persistActiveNotesTab = () => {
                if (!state.tabId || !chrome?.storage?.local?.set) return;
                const index = state.tabs.findIndex((tab) => tab.tabId === state.tabId);
                const tab = tabCache.get(state.tabId) || state.tabs[index];
                const name = tab ? getTabLabel(tab, index >= 0 ? index : 0) : 'Home';
                try {
                    chrome.storage.local.set({
                        [NOTES_ACTIVE_TAB_KEY]: {
                            tabId: state.tabId,
                            name,
                            updatedAt: Date.now()
                        }
                    });
                } catch (error) {
                    console.warn('[results] failed to persist active tab', error);
                }
            };

            const renderTabs = (tabs = []) => {
                if (!notesTabs) return;
                tabCache.clear();
                tabs.forEach((tab) => tabCache.set(tab.tabId, tab));
                const fallbackTabId = state.tabId || state.defaultTabId;
                if (!tabs.length && fallbackTabId) {
                    notesTabs.innerHTML = `<button type="button" class="notes-tab is-active" data-tab-id="${escapeHtml(fallbackTabId)}" role="tab" aria-selected="true"><span class="notes-tab-label">Home</span></button>`;
                } else {
                    const canClose = tabs.length > 1;
                    notesTabs.innerHTML = tabs
                        .map((tab, index) => {
                            const label = escapeHtml(getTabLabel(tab, index));
                            const isActive = tab.tabId === state.tabId;
                            const closeIcon = canClose
                                ? '<span class="notes-tab-close" data-action="close" aria-label="Close tab" title="Close tab">×</span>'
                                : '';
                            return `<button type="button" class="notes-tab${isActive ? ' is-active' : ''}" data-tab-id="${escapeHtml(tab.tabId)}" role="tab" aria-selected="${isActive ? 'true' : 'false'}"><span class="notes-tab-label">${label}</span>${closeIcon}</button>`;
                        })
                        .join('');
                }
                notesTabs.querySelectorAll('.notes-tab').forEach((btn) => {
                    const tabId = btn.dataset.tabId;
                    if (!tabId) return;
                    btn.addEventListener('click', () => selectTab(tabId));
                    btn.addEventListener('dblclick', (event) => {
                        event.preventDefault();
                        startRenameTab(btn);
                    });
                });
                notesTabs.querySelectorAll('.notes-tab-close').forEach((btn) => {
                    const handleClose = (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        const tabId = btn.closest('.notes-tab')?.dataset?.tabId;
                        if (!tabId) return;
                        closeTab(tabId);
                    };
                    btn.addEventListener('pointerdown', handleClose);
                    btn.addEventListener('dblclick', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                    });
                });
            };

            const refreshTabs = async () => {
                try {
                    const result = await notesClient.listTabs();
                    const nextTabs = result?.tabs || [];
                    if (nextTabs.length || !state.tabs.length) {
                        state.tabs = nextTabs;
                    }
                    renderTabs(state.tabs);
                    return state.tabs;
                } catch (error) {
                    console.warn('[results] failed to refresh tabs', error);
                    renderTabs(state.tabs);
                    return state.tabs;
                }
            };

            const pruneEmptyTabs = async () => {
                if (!notesClient?.deleteTab) return false;
                if (state.tabs.length <= 1) return false;
                const keepTabId = state.defaultTabId || state.tabs[0]?.tabId;
                const emptyTabIds = [];

                for (const tab of state.tabs) {
                    if (!tab?.tabId || tab.tabId === keepTabId) continue;
                    try {
                        const result = await notesClient.listChildren({
                            tabId: tab.tabId,
                            parentId: null
                        });
                        const notes = result?.notes || [];
                        if (!notes.length) {
                            emptyTabIds.push(tab.tabId);
                        }
                    } catch (error) {
                        console.warn('[results] failed to inspect tab', error);
                    }
                }

                if (!emptyTabIds.length) return false;
                for (const tabId of emptyTabIds) {
                    try {
                        await notesClient.deleteTab({ tabId });
                    } catch (error) {
                        console.warn('[results] failed to delete empty tab', error);
                    }
                }
                await refreshTabs();
                return true;
            };

            const startRenameTab = (button) => {
                const tabId = button?.dataset?.tabId;
                if (!tabId || button.querySelector('.notes-tab-input')) return;
                const tab = tabCache.get(tabId);
                const labelEl = button.querySelector('.notes-tab-label');
                const closeEl = button.querySelector('.notes-tab-close');
                const currentLabel = String(tab?.name || labelEl?.textContent || button.textContent || '').trim();
                const input = document.createElement('input');
                input.className = 'notes-tab-input';
                input.value = currentLabel || 'Tab';
                input.setAttribute('aria-label', 'Rename tab');
                button.classList.add('is-close-visible');
                if (labelEl) {
                    labelEl.replaceWith(input);
                } else {
                    button.innerHTML = '';
                    button.appendChild(input);
                    if (closeEl) button.appendChild(closeEl);
                }
                input.focus();
                input.select();

                const finish = async (commit) => {
                    if (!button.contains(input)) return;
                    const nextName = String(input.value || '').trim();
                    const shouldCommit = commit && nextName && nextName !== currentLabel;
                    const label = document.createElement('span');
                    label.className = 'notes-tab-label';
                    label.textContent = shouldCommit ? nextName : (currentLabel || 'Tab');
                    input.replaceWith(label);
                    if (closeEl && !button.contains(closeEl)) {
                        button.appendChild(closeEl);
                    }
                    button.classList.remove('is-close-visible');
                    if (!shouldCommit) {
                        renderTabs(state.tabs);
                        return;
                    }
                    try {
                        await notesClient.renameTab({ tabId, name: nextName });
                        await refreshTabs();
                        if (tabId === state.tabId) {
                            persistActiveNotesTab();
                        }
                        setStatus('Tab renamed');
                    } catch (error) {
                        console.warn('[results] failed to rename tab', error);
                        setStatus('Rename failed');
                        renderTabs(state.tabs);
                    }
                };

                input.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        finish(true);
                    }
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        finish(false);
                    }
                });
                input.addEventListener('blur', () => finish(true));
            };

            const createTab = async () => {
                if (!state.tabId) {
                    const ready = await ensureNotesReady();
                    if (!ready) {
                        setStatus('Notes offline');
                        return;
                    }
                }
                try {
                    const existing = new Set(state.tabs.map((tab) => tab.name));
                    let idx = 1;
                    let name = `Tab ${idx}`;
                    while (existing.has(name)) {
                        idx += 1;
                        name = `Tab ${idx}`;
                    }
                    const created = await notesClient.createTab({ name });
                    await refreshTabs();
                    if (created?.tab?.tabId) {
                        await selectTab(created.tab.tabId);
                        setStatus('Tab created');
                    }
                } catch (error) {
                    console.warn('[results] failed to create tab', error);
                    setStatus('Create failed');
                }
            };

            const closeTab = async (tabId) => {
                if (!tabId) return;
                if (!notesClient?.deleteTab) {
                    setStatus('Close unavailable');
                    return;
                }
                if (state.tabs.length <= 1) {
                    setStatus('Cannot delete last tab');
                    return;
                }
                const index = state.tabs.findIndex((tab) => tab.tabId === tabId);
                const tab = tabCache.get(tabId) || state.tabs[index];
                const wasActive = tabId === state.tabId;
                try {
                    if (wasActive) {
                        await flushSave();
                        state.tabId = null;
                        state.activeNoteId = null;
                    }
                    await notesClient.deleteTab({ tabId });
                    lastActiveByTab.delete(tabId);
                    expandedByTab.delete(tabId);
                    if (tabId === state.defaultTabId) {
                        state.defaultTabId = null;
                    }
                    await refreshTabs();
                    if (!state.defaultTabId && state.tabs.length) {
                        state.defaultTabId = state.tabs[0].tabId;
                    }
                    if (wasActive) {
                        const nextTabId = state.tabs[0]?.tabId || state.defaultTabId || null;
                        if (nextTabId) {
                            await selectTab(nextTabId);
                        } else {
                            renderTabs(state.tabs);
                            renderNotesList([]);
                            setTextareaValue('');
                            setEditorEnabled(false);
                        }
                    }
                    setStatus('Tab closed');
                } catch (error) {
                    console.warn('[results] failed to delete tab', error);
                    setStatus('Close failed');
                }
            };

            const selectTab = async (tabId) => {
                if (!tabId) return;
                if (sessionPreview.isActive) {
                    restoreSessionPreview();
                }
                if (tabId === state.tabId && !sessionsState.isActive) return;
                setSessionsActive(false);
                if (tabId === state.tabId) {
                    renderTabs(state.tabs);
                    return;
                }
                if (state.tabId) {
                    lastActiveByTab.set(state.tabId, state.activeNoteId);
                }
                await flushSave();
                state.tabId = tabId;
                state.activeNoteId = lastActiveByTab.get(tabId) || null;
                renderTabs(state.tabs);
                persistActiveNotesTab();
                await refreshNotesList();
            };

            const ensureSearchTreeLoaded = async () => {
                const queue = [...(state.notes || [])];
                const visited = new Set();
                while (queue.length) {
                    const note = queue.shift();
                    if (!note || visited.has(note.id)) continue;
                    visited.add(note.id);
                    const children = await fetchChildren(note.id);
                    if (children && children.length) {
                        queue.push(...children);
                    }
                }
            };

            const hydrateExpandedTree = async () => {
                const expandedSet = getExpandedSet();
                if (!expandedSet.size) return;
                const queue = Array.from(expandedSet);
                const visited = new Set();
                while (queue.length) {
                    const noteId = queue.shift();
                    if (!noteId || visited.has(noteId)) continue;
                    visited.add(noteId);
                    const children = await fetchChildren(noteId);
                    children.forEach((child) => {
                        if (expandedSet.has(child.id)) {
                            queue.push(child.id);
                        }
                    });
                }
            };

            const setSearchQuery = async (value) => {
                state.searchQuery = String(value || '').trim().toLowerCase();
                if (!state.searchQuery) {
                    renderNotesList(state.notes);
                    return;
                }
                const token = ++searchToken;
                await ensureSearchTreeLoaded();
                if (token !== searchToken) return;
                renderNotesList(state.notes);
            };

            const setEditorEnabled = (enabled) => {
                if (notesTextarea) {
                    notesTextarea.disabled = !enabled;
                    notesTextarea.placeholder = enabled ? 'Write notes...' : 'Create a note to start.';
                }
                if (notesPanel) {
                    notesPanel.classList.toggle('is-editor-hidden', !enabled);
                }
            };

            const syncSelectionStyles = () => {
                if (!notesTree) return;
                notesTree.querySelectorAll('.notes-tree-item').forEach((item) => {
                    const noteId = item.dataset.noteId;
                    const selected = noteId && state.selectedNoteIds.has(noteId);
                    const isActive = noteId === state.activeNoteId;
                    const isEditing = editorState.mode === 'EDITING' && noteId === editorState.noteId;
                    const titleEl = item.querySelector('.notes-tree-title');
                    item.classList.toggle('is-selected', !!selected);
                    item.classList.toggle('is-active', !!isActive);
                    item.classList.toggle('is-editing', !!isEditing);
                    item.setAttribute('aria-selected', selected ? 'true' : 'false');
                    item.setAttribute('tabindex', isActive ? '0' : '-1');
                    if (titleEl) {
                        if (isEditing) {
                            titleEl.setAttribute('contenteditable', 'true');
                            titleEl.setAttribute('role', 'textbox');
                            titleEl.setAttribute('aria-label', 'Edit note title');
                            titleEl.spellcheck = false;
                        } else {
                            titleEl.removeAttribute('contenteditable');
                            titleEl.removeAttribute('role');
                            titleEl.removeAttribute('aria-label');
                            titleEl.spellcheck = false;
                        }
                    }
                });
                syncSelectAllIndicator();
            };

            const setSingleSelection = (noteId) => {
                state.selectedNoteIds.clear();
                if (noteId) {
                    state.selectedNoteIds.add(noteId);
                    state.anchorNoteId = noteId;
                } else {
                    state.anchorNoteId = null;
                }
                syncSelectionStyles();
            };

            const toggleSelection = (noteId) => {
                if (!noteId) return;
                if (state.selectedNoteIds.has(noteId)) {
                    state.selectedNoteIds.delete(noteId);
                } else {
                    state.selectedNoteIds.add(noteId);
                }
                if (!state.selectedNoteIds.size) {
                    state.selectedNoteIds.add(noteId);
                }
                state.anchorNoteId = noteId;
                syncSelectionStyles();
            };

            const selectRange = (anchorId, targetId, { additive = false } = {}) => {
                if (!anchorId || !targetId) {
                    setSingleSelection(targetId);
                    return;
                }
                const items = getVisibleTreeItems();
                const ids = items.map((item) => item.dataset.noteId).filter(Boolean);
                const start = ids.indexOf(anchorId);
                const end = ids.indexOf(targetId);
                if (start === -1 || end === -1) {
                    setSingleSelection(targetId);
                    return;
                }
                const from = Math.min(start, end);
                const to = Math.max(start, end);
                if (!additive) state.selectedNoteIds.clear();
                for (let i = from; i <= to; i += 1) {
                    state.selectedNoteIds.add(ids[i]);
                }
                state.anchorNoteId = anchorId;
                syncSelectionStyles();
            };

            const setActiveTitle = (note) => {
                if (!notesActiveTitle) return;
                notesActiveTitle.textContent = note?.title || 'Untitled';
            };

            const setTextareaValue = (text) => {
                const nextText = typeof text === 'string' ? text : '';
                if (notesTextarea) {
                    notesTextarea.value = nextText;
                }
                state.lastSavedText = nextText;
            };

            const shouldAutosaveContent = (content) => {
                const nextText = String(content?.text || '').trim();
                const nextHtml = String(content?.html || '').trim();
                if (!nextText && !nextHtml) return false;
                return nextText !== state.lastSavedText || nextHtml !== state.lastSavedHtml;
            };

            const flushSave = async () => {
                if (!promptInput) return;
                if (editorState.mode !== 'EDITING' || !editorState.noteId) return;
                const nextContent = getEditorContent();
                if (!shouldAutosaveContent(nextContent)) return;
                if (state.saveTimer) clearTimeout(state.saveTimer);
                state.pendingSave = true;
                try {
                    const payload = {
                        noteId: editorState.noteId,
                        text: nextContent.text,
                        html: nextContent.html
                    };
                    if (!nextContent.html) {
                        payload.clearHtml = true;
                    }
                    await notesClient.updateNoteText(payload);
                    state.lastSavedText = nextContent.text;
                    state.lastSavedHtml = nextContent.html;
                    editorState.originalText = nextContent.text;
                    setStatus('Saved');
                } catch (error) {
                    console.warn('[results] failed to save note', error);
                    setStatus('Save failed');
                } finally {
                    state.pendingSave = false;
                }
            };

            const scheduleSave = () => {
                if (!promptInput) return;
                if (editorState.mode !== 'EDITING' || !editorState.noteId) return;
                const nextContent = getEditorContent();
                if (state.saveTimer) clearTimeout(state.saveTimer);
                state.saveTimer = setTimeout(async () => {
                    if (editorState.mode !== 'EDITING' || !editorState.noteId) return;
                    if (!shouldAutosaveContent(nextContent)) return;
                    state.pendingSave = true;
                    try {
                        const payload = {
                            noteId: editorState.noteId,
                            text: nextContent.text,
                            html: nextContent.html
                        };
                        if (!nextContent.html) {
                            payload.clearHtml = true;
                        }
                        await notesClient.updateNoteText(payload);
                        state.lastSavedText = nextContent.text;
                        state.lastSavedHtml = nextContent.html;
                        editorState.originalText = nextContent.text;
                        setStatus('Saved');
                    } catch (error) {
                        console.warn('[results] failed to save note', error);
                        setStatus('Save failed');
                    } finally {
                        state.pendingSave = false;
                    }
                }, 300);
            };

            const refreshActiveNote = async () => {
                if (!promptInput) return;
                if (editorState.mode === 'PROMPT') return;
                if (!editorState.noteId || state.refreshInFlight || state.pendingSave) return;
                const current = getEditorContent();
                if (current.text !== state.lastSavedText || current.html !== state.lastSavedHtml) return;
                state.refreshInFlight = true;
                try {
                    const result = await notesClient.getNote({ noteId: editorState.noteId });
                    const nextText = result?.text || '';
                    const nextHtml = sanitizeInlineHtml(result?.html || '').trim();
                    if (current.text === state.lastSavedText && current.html === state.lastSavedHtml) {
                        setNoteViewContent({ text: nextText, html: nextHtml });
                        editorState.originalText = nextText;
                    }
                } catch (error) {
                    console.warn('[results] failed to refresh note', error);
                } finally {
                    state.refreshInFlight = false;
                }
            };

            const renderNotesList = (notes = []) => {
                if (!notesTree) return;
                noteCache.clear();
                const query = state.searchQuery;
                const hasQuery = query.length > 0;

                const matchesQuery = (note) => {
                    if (!hasQuery) return true;
                    const title = String(note.title || '').toLowerCase();
                    const preview = String(note.preview || '').toLowerCase();
                    return title.includes(query) || preview.includes(query);
                };

                const formatDateLabel = (value) => {
                    const date = value instanceof Date ? value : new Date(value);
                    if (Number.isNaN(date.getTime())) return 'Unknown date';
                    const today = new Date();
                    const yesterday = new Date(today);
                    yesterday.setDate(today.getDate() - 1);
                    const isSameDay = (left, right) =>
                        left.getFullYear() === right.getFullYear()
                        && left.getMonth() === right.getMonth()
                        && left.getDate() === right.getDate();
                    if (isSameDay(date, today)) return 'Сегодня';
                    if (isSameDay(date, yesterday)) return 'Вчера';
                    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
                    const month = months[date.getMonth()] || 'unknown';
                    return `${month}.${date.getDate()}`;
                };

            const sortByOrderKey = (list) =>
                list.slice().sort((a, b) => String(a.orderKey || '').localeCompare(String(b.orderKey || '')));
            const sortByCreatedAtDesc = (list) =>
                list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

                const buildTreeHtml = (list, depth) => {
                    let html = '';
                    let anyMatch = false;
                    let visibleCount = 0;
                    const sorted = depth === 0 ? sortByCreatedAtDesc(list) : sortByOrderKey(list);
                    let lastDateLabel = null;
                    sorted.forEach((note) => {
                        noteCache.set(note.id, note);
                        const children = childrenCache.get(note.id) || [];
                        const childrenLoaded = loadedChildren.has(note.id);
                        const showChildren = hasQuery || isExpanded(note.id);
                        const childResult = showChildren ? buildTreeHtml(children, depth + 1) : { html: '', anyMatch: false, visibleCount: 0 };
                        const matches = hasQuery ? (matchesQuery(note) || childResult.anyMatch) : true;
                        if (!matches) return;
                        if (depth === 0) {
                            const dateLabel = formatDateLabel(note.createdAt);
                            if (dateLabel && dateLabel !== lastDateLabel) {
                                html += `<div class="notes-date-separator" role="presentation">${escapeHtml(dateLabel)}</div>`;
                                lastDateLabel = dateLabel;
                            }
                        }
                        anyMatch = true;
                        visibleCount += 1;
                        const isActive = note.id === state.activeNoteId;
                        const isSelected = state.selectedNoteIds.has(note.id);
                        const isEditing = editorState.mode === 'EDITING' && editorState.noteId === note.id;
                        const hasChildren = childrenLoaded ? children.length > 0 : false;
                        const expanded = hasQuery ? (childResult.anyMatch && children.length) : isExpanded(note.id);
                        const title = escapeHtml(note.title || 'Untitled');
                        const preview = note.preview ? `<span class="notes-tree-preview">${escapeHtml(note.preview)}</span>` : '';
                        const padding = depth * 10;
                        const classNames = [
                            'notes-tree-item',
                            isActive ? 'is-active' : '',
                            isSelected ? 'is-selected' : '',
                            isEditing ? 'is-editing' : ''
                        ].filter(Boolean).join(' ');
                        html += `<div class="${classNames}" data-note-id="${escapeHtml(note.id)}" data-parent-id="${escapeHtml(note.parentId || '')}" data-has-children="${hasChildren ? 'true' : 'false'}" role="treeitem" tabindex="${isActive ? '0' : '-1'}" aria-selected="${isSelected ? 'true' : 'false'}" aria-level="${depth + 1}" aria-expanded="${expanded ? 'true' : 'false'}" draggable="true">
                            <div class="notes-tree-row" style="padding-left:${padding}px">
                                <button type="button" class="notes-tree-toggle" data-action="toggle" data-note-id="${escapeHtml(note.id)}" aria-label="Toggle children"></button>
                                <div class="notes-tree-main">
                                    <span class="notes-tree-title">${title}</span>
                                    ${preview}
                                </div>
                                <button type="button" class="notes-tree-add" data-action="add-child" data-note-id="${escapeHtml(note.id)}" aria-label="Add child">+</button>
                            </div>
                            ${expanded && childResult.html ? childResult.html : ''}
                        </div>`;
                        if (expanded && childResult.visibleCount) {
                            visibleCount += childResult.visibleCount;
                        }
                    });
                    return { html, anyMatch, visibleCount };
                };

                const treeResult = buildTreeHtml(notes, 0);
                if (!treeResult.visibleCount) {
                    notesTree.innerHTML = '';
                    if (notesEmpty) {
                        notesEmpty.textContent = hasQuery ? 'No matches.' : 'No notes yet.';
                        notesEmpty.style.display = 'block';
                    }
                    if (!notes.length) {
                        setEditorEnabled(false);
                        setActiveTitle(null);
                    } else {
                        setEditorEnabled(!!state.activeNoteId);
                    }
                    return;
                }
                if (notesEmpty) notesEmpty.style.display = 'none';
                notesTree.innerHTML = treeResult.html;
                syncSelectionStyles();
                setEditorEnabled(!!state.activeNoteId);
                if (state.activeNoteId && noteCache.has(state.activeNoteId)) {
                    setActiveTitle(noteCache.get(state.activeNoteId));
                }
                syncSelectAllIndicator();
                scheduleChildrenPrefetch();
            };

            const refreshNotesList = async () => {
                if (!state.tabId) return;
                if (state.listRefreshing) {
                    listRefreshPending = true;
                    return;
                }
                state.listRefreshing = true;
                try {
                    const result = await notesClient.listChildren({
                        tabId: state.tabId,
                        parentId: null
                    });
                    const notes = result?.notes || [];
                    state.notes = notes;
                    clearChildrenCache();
                    await hydrateExpandedTree();
                    if (state.searchQuery) {
                        await ensureSearchTreeLoaded();
                    }
                    if (!notes.length) {
                        state.activeNoteId = null;
                        state.selectedNoteIds.clear();
                        state.anchorNoteId = null;
                        renderNotesList(notes);
                        setTextareaValue('');
                        return;
                    }
                    const noteIds = new Set(notes.map((note) => note.id));
                    if (state.activeNoteId && !noteIds.has(state.activeNoteId)) {
                        state.activeNoteId = null;
                    }
                    if (state.activeNoteId && !state.selectedNoteIds.has(state.activeNoteId)) {
                        state.selectedNoteIds.add(state.activeNoteId);
                        state.anchorNoteId = state.activeNoteId;
                    }
                    renderNotesList(notes);
                    if (!state.activeNoteId && notes.length && editorState.mode !== 'PROMPT') {
                        await selectNote(notes[0].id, { skipSave: true });
                    }
                } catch (error) {
                    console.warn('[results] failed to refresh notes list', error);
                } finally {
                    state.listRefreshing = false;
                    if (listRefreshPending) {
                        listRefreshPending = false;
                        refreshNotesList();
                    }
                }
            };

            const focusNoteItem = (noteId) => {
                if (!notesTree || !noteId) return;
                const items = notesTree.querySelectorAll('.notes-tree-item');
                for (const item of items) {
                    if (item.dataset.noteId === noteId) {
                        item.focus();
                        break;
                    }
                }
            };

            const selectNote = async (noteId, { skipSave = false, force = false, focus = false, preserveSelection = false } = {}) => {
                if (!noteId) return;
                if (sessionPreview.isActive) {
                    restoreSessionPreview();
                }
                capturePromptDraft();
                if (state.activeNoteId === noteId && !force) return;
                if (!skipSave) {
                    await flushSave();
                }
                state.activeNoteId = noteId;
                if (state.tabId) {
                    lastActiveByTab.set(state.tabId, noteId);
                }
                if (!preserveSelection) {
                    setSingleSelection(noteId);
                }
                setEditorEnabled(true);
                if (notesTree) {
                    notesTree.querySelectorAll('.notes-tree-item').forEach((item) => {
                        item.classList.toggle('is-active', item.dataset.noteId === noteId);
                        item.setAttribute('aria-selected', state.selectedNoteIds.has(item.dataset.noteId) ? 'true' : 'false');
                        item.setAttribute('tabindex', item.dataset.noteId === noteId ? '0' : '-1');
                    });
                }
                if (focus) {
                    focusNoteItem(noteId);
                }
                if (noteCache.has(noteId)) {
                    setActiveTitle(noteCache.get(noteId));
                } else {
                    setActiveTitle(null);
                }
                let noteText = '';
                let noteHtml = '';
                try {
                    const result = await notesClient.getNote({ noteId });
                    noteText = result?.text || '';
                    noteHtml = sanitizeInlineHtml(result?.html || '').trim();
                    setTextareaValue(noteText);
                } catch (error) {
                    console.warn('[results] failed to load note', error);
                }
                return { text: noteText, html: noteHtml };
            };

            const createRootNote = async () => {
                const ready = await ensureNotesReady();
                if (!ready) {
                    setStatus('Notes offline');
                    return;
                }
                try {
                    await flushSave();
                    const created = await createNoteWithFallback({
                        tabId: state.tabId,
                        parentId: null,
                        title: 'New',
                        text: ''
                    });
                    await syncAfterNoteCreate(created);
                    const notePayload = await selectNote(created?.noteId, { preserveSelection: false, focus: true });
                    if (created?.noteId) {
                        await applyNoteToPrompt(created.noteId, { mode: 'EDITING', noteText: notePayload });
                    }
                    setStatus('Note created');
                } catch (error) {
                    console.warn('[results] failed to create note', error);
                    setStatus(formatStatusError('Create failed', error), 3200);
                }
            };

            const createChildNote = async (parentId) => {
                if (!parentId) return;
                const ready = await ensureNotesReady();
                if (!ready) {
                    setStatus('Notes offline');
                    return;
                }
                try {
                    await flushSave();
                    const parentTabId = await resolveParentTabId(parentId);
                    if (parentTabId && parentTabId !== state.tabId) {
                        state.tabId = parentTabId;
                    }
                    const created = await createNoteWithFallback({
                        tabId: state.tabId,
                        parentId,
                        title: 'New',
                        text: ''
                    }, { allowDefault: false });
                    setExpanded(parentId, true);
                    await syncAfterNoteCreate(created);
                    const notePayload = await selectNote(created?.noteId, { preserveSelection: false, focus: true });
                    if (created?.noteId) {
                        await applyNoteToPrompt(created.noteId, { mode: 'EDITING', noteText: notePayload });
                    }
                    setStatus('Note created');
                } catch (error) {
                    console.warn('[results] failed to create child note', error);
                    setStatus(formatStatusError('Create failed', error), 3200);
                }
            };

            const toggleExpand = async (noteId) => {
                if (!noteId) return;
                if (state.searchQuery) {
                    setExpanded(noteId, !isExpanded(noteId));
                    renderNotesList(state.notes);
                    return;
                }
                const nextExpanded = !isExpanded(noteId);
                if (nextExpanded) {
                    const children = await fetchChildren(noteId);
                    const hasChildren = Array.isArray(children) && children.length > 0;
                    setExpanded(noteId, hasChildren);
                } else {
                    setExpanded(noteId, false);
                }
                renderNotesList(state.notes);
            };

            const getVisibleTreeItems = () => {
                if (!notesTree) return [];
                return Array.from(notesTree.querySelectorAll('.notes-tree-item'));
            };

            const getParentItem = (item) => {
                if (!item) return null;
                return item.parentElement ? item.parentElement.closest('.notes-tree-item') : null;
            };

            const getFirstChildItem = (item) => {
                if (!item) return null;
                for (const child of Array.from(item.children)) {
                    if (child.classList && child.classList.contains('notes-tree-item')) {
                        return child;
                    }
                }
                return null;
            };

            const itemHasChildren = (item) => item?.dataset?.hasChildren === 'true';
            const dragState = {
                noteId: null,
                targetId: null,
                position: null
            };
            const textDragState = {
                targetId: null,
                position: null
            };

            const DRAG_MIME = 'application/x-codex-note';

            const clearDropIndicators = () => {
                if (!notesTree) return;
                notesTree.classList.remove('is-drop-root');
                notesTree.querySelectorAll('.notes-tree-item').forEach((item) => {
                    item.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-inside');
                });
            };

            const resolveDropTarget = (event) => {
                if (!notesTree) return { item: null, targetId: null, position: 'root' };
                const item = event.target.closest('.notes-tree-item');
                if (!item || !notesTree.contains(item)) {
                    return { item: null, targetId: null, position: 'root' };
                }
                const rect = item.getBoundingClientRect();
                const offsetY = event.clientY - rect.top;
                const ratio = rect.height ? offsetY / rect.height : 0.5;
                let position = 'inside';
                if (ratio < 0.25) position = 'before';
                if (ratio > 0.75) position = 'after';
                return { item, targetId: item.dataset.noteId, position };
            };

            const setDropIndicator = (item, position) => {
                clearDropIndicators();
                if (!notesTree) return;
                if (!item) {
                    notesTree.classList.add('is-drop-root');
                    return;
                }
                if (position === 'inside') {
                    item.classList.add('is-drop-inside');
                } else if (position === 'before') {
                    item.classList.add('is-drop-before');
                } else if (position === 'after') {
                    item.classList.add('is-drop-after');
                }
            };

            const buildDragPayload = ({ text, type, llmName }) => {
                const payload = {
                    text: String(text || '').trim(),
                    type: type || 'clip'
                };
                if (llmName) payload.llmName = llmName;
                return payload;
            };

            const getDragPayload = (event) => {
                const raw = event?.dataTransfer?.getData?.(DRAG_MIME);
                if (raw) {
                    try {
                        const parsed = JSON.parse(raw);
                        if (parsed?.text) return parsed;
                    } catch (_) {}
                }
                const plain = event?.dataTransfer?.getData?.('text/plain');
                if (plain) {
                    return buildDragPayload({ text: plain, type: 'clip' });
                }
                return null;
            };

            const setDragPayload = (event, payload) => {
                if (!event?.dataTransfer || !payload?.text) return false;
                try {
                    event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
                } catch (_) {}
                try {
                    event.dataTransfer.setData('text/plain', payload.text);
                } catch (_) {}
                event.dataTransfer.effectAllowed = 'copy';
                return true;
            };

            const getSelectionTextWithin = (element) => {
                if (!element) return '';
                const selection = window.getSelection?.();
                if (!selection || selection.isCollapsed) return '';
                const anchorNode = selection.anchorNode;
                const focusNode = selection.focusNode;
                if (!anchorNode || !focusNode) return '';
                if (!element.contains(anchorNode) || !element.contains(focusNode)) return '';
                return String(selection.toString() || '').trim();
            };

            const getPromptDragText = () => {
                if (!promptInput) return '';
                const start = promptInput.selectionStart;
                const end = promptInput.selectionEnd;
                if (typeof start === 'number' && typeof end === 'number' && start !== end) {
                    return String(promptInput.value || '').slice(start, end).trim();
                }
                return getPromptTextForSave();
            };

            const getOutputDragText = (outputEl) => {
                if (!outputEl) return '';
                const selected = getSelectionTextWithin(outputEl);
                if (selected) return selected;
                return getOutputTextForSave(outputEl.id);
            };

            const resolveLlmNameForOutput = (outputEl) => {
                if (!outputEl) return '';
                const panel = outputEl.closest('.llm-panel');
                const title = panel?.querySelector('.llm-title');
                const name = title?.textContent?.trim();
                return name || '';
            };

            const applyNoteToPrompt = async (noteId, { mode = 'VIEWING', noteText = null } = {}) => {
                if (!promptInput || !noteId) return;
                try {
                    let nextText = '';
                    let nextHtml = '';
                    if (noteText && typeof noteText === 'object') {
                        nextText = String(noteText.text || '');
                        nextHtml = String(noteText.html || '');
                    } else if (typeof noteText === 'string') {
                        nextText = noteText;
                    }
                    if (!nextText && !nextHtml) {
                        const result = await notesClient.getNote({ noteId });
                        nextText = result?.text || '';
                        nextHtml = result?.html || '';
                    }
                    const resolvedHtml = sanitizeInlineHtml(nextHtml).trim();
                    const resolvedText = resolvedHtml ? plainTextFromHtml(resolvedHtml) : String(nextText || '');
                    setNoteViewContent({ text: resolvedText, html: resolvedHtml });
                    setEditorMode(mode, { noteId, originalText: resolvedText });
                    if (!resolvedText.trim() && !resolvedHtml.trim()) {
                        setStatus('Note is empty');
                        return;
                    }
                    setStatus(mode === 'EDITING' ? 'Editing' : 'Prompt updated');
                } catch (error) {
                    console.warn('[results] failed to apply note to prompt', error);
                    setStatus('Prompt update failed');
                }
            };

            const createNoteFromDrag = async ({ text, type, llmName }, { targetId, position }) => {
                const content = String(text || '').trim();
                if (!content) return;
                if (!await ensureNotesReady()) {
                    setStatus('Notes offline');
                    return;
                }

                const snippet = truncateText(content, 48);
                let title = snippet;
                let kind = 'clip';
                if (type === 'prompt') {
                    title = snippet;
                    kind = 'prompt';
                } else if (type === 'response') {
                    const prefix = llmName || 'Response';
                    title = `${prefix} response - ${snippet}`;
                    kind = 'response';
                }

                let targetParentId = null;
                let beforeId = null;
                let afterId = null;
                if (targetId && position !== 'root') {
                    if (position === 'inside') {
                        targetParentId = targetId;
                    } else {
                        const targetItem = notesTree?.querySelector(`.notes-tree-item[data-note-id="${targetId}"]`);
                        targetParentId = targetItem?.dataset?.parentId || null;
                        if (position === 'before') beforeId = targetId;
                        if (position === 'after') afterId = targetId;
                    }
                }

                try {
                    if (targetParentId) {
                        const parentTabId = await resolveParentTabId(targetParentId);
                        if (parentTabId && parentTabId !== state.tabId) {
                            state.tabId = parentTabId;
                        }
                    }
                    const source = {
                        origin: 'comparator',
                        type,
                        model: llmName,
                        pageUrl: location.href,
                        ts: Date.now()
                    };
                    if (type === 'response') {
                        const { url: responseUrl, timestamp: responseTimestamp } = resolveResponseSource(llmName);
                        source.pageUrl = responseUrl;
                        source.ts = responseTimestamp;
                    }
                    const created = await createNoteWithFallback({
                        tabId: state.tabId,
                        parentId: targetParentId,
                        kind,
                        title,
                        text: content,
                        source
                    });
                    if (created?.noteId && (beforeId || afterId)) {
                        await notesClient.moveNote({
                            noteId: created.noteId,
                            targetParentId,
                            beforeId,
                            afterId
                        });
                    }
                    if (targetParentId) {
                        setExpanded(targetParentId, true);
                    }
                    if (created?.noteId) {
                        state.activeNoteId = created.noteId;
                        lastActiveByTab.set(state.tabId, created.noteId);
                        setSingleSelection(created.noteId);
                    }
                    await syncAfterNoteCreate(created);
                    setStatus('Saved to notes');
                } catch (error) {
                    console.warn('[results] failed to save drag note', error);
                    setStatus(formatStatusError('Save failed', error), 3200);
                }
            };

            const formatTimestamp = (value = new Date()) => {
                const date = value instanceof Date ? value : new Date(value);
                const pad = (num) => String(num).padStart(2, '0');
                return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
            };

            const createSessionId = () => `session_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

            const normalizeSession = (session) => {
                if (!session || typeof session !== 'object') return null;
                const urls = Array.isArray(session.urls)
                    ? session.urls.filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url))
                    : [];
                if (!urls.length) return null;
                const name = String(session.name || '').trim();
                return {
                    id: typeof session.id === 'string' && session.id ? session.id : createSessionId(),
                    name: name || `Session ${formatTimestamp()}`,
                    urls,
                    createdAt: Number(session.createdAt || Date.now()),
                    updatedAt: Number(session.updatedAt || Date.now())
                };
            };

            const readStorage = (area, key) => new Promise((resolve) => {
                if (!area) {
                    resolve({});
                    return;
                }
                try {
                    area.get(key, (result) => resolve(result || {}));
                } catch (error) {
                    console.warn('[results] storage read failed', error);
                    resolve({});
                }
            });

            const writeStorage = (area, payload) => new Promise((resolve, reject) => {
                if (!area) {
                    resolve(false);
                    return;
                }
                try {
                    area.set(payload, () => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                            return;
                        }
                        resolve(true);
                    });
                } catch (error) {
                    reject(error);
                }
            });

            const loadSessions = async () => {
                const syncArea = chrome?.storage?.sync || null;
                const localArea = chrome?.storage?.local || null;
                let raw = [];
                let hasValue = false;
                if (syncArea) {
                    const result = await readStorage(syncArea, SESSIONS_STORAGE_KEY);
                    if (Object.prototype.hasOwnProperty.call(result, SESSIONS_STORAGE_KEY)) {
                        raw = Array.isArray(result[SESSIONS_STORAGE_KEY]) ? result[SESSIONS_STORAGE_KEY] : [];
                        hasValue = true;
                    }
                }
                if (!hasValue && localArea) {
                    const result = await readStorage(localArea, SESSIONS_STORAGE_KEY);
                    if (Object.prototype.hasOwnProperty.call(result, SESSIONS_STORAGE_KEY)) {
                        raw = Array.isArray(result[SESSIONS_STORAGE_KEY]) ? result[SESSIONS_STORAGE_KEY] : [];
                    }
                }
                sessionsState.sessions = raw
                    .map((entry) => normalizeSession(entry))
                    .filter(Boolean);
            };

            const persistSessions = async () => {
                const payload = { [SESSIONS_STORAGE_KEY]: sessionsState.sessions };
                const syncArea = chrome?.storage?.sync || null;
                const localArea = chrome?.storage?.local || null;
                if (syncArea) {
                    try {
                        await writeStorage(syncArea, payload);
                    } catch (error) {
                        console.warn('[results] sync storage failed', error);
                    }
                }
                if (localArea) {
                    try {
                        await writeStorage(localArea, payload);
                    } catch (error) {
                        console.warn('[results] local storage failed', error);
                    }
                }
            };

            const formatSessionPreview = (urls = []) =>
                urls.map((url) => String(url || '').trim()).filter(Boolean).join('\n');

            const showSessionPreview = async (session) => {
                if (!session || !promptInput) return;
                if (editorState.mode !== 'PROMPT') {
                    await exitNotesMode();
                }
                if (!sessionPreview.isActive) {
                    sessionPreview.text = getEditorValue();
                    sessionPreview.capturedAt = Date.now();
                    sessionPreview.isActive = true;
                }
                const previewText = formatSessionPreview(session.urls);
                if (useInputRichMode && typeof applyRichInputContent === 'function') {
                    applyRichInputContent({ text: previewText, html: '' });
                } else {
                    setEditorValue(previewText);
                }
            };

            const restoreSessionPreview = () => {
                if (!sessionPreview.isActive) return;
                const restoredText = sessionPreview.text;
                sessionPreview.isActive = false;
                sessionPreview.text = '';
                sessionPreview.capturedAt = 0;
                if (useInputRichMode && typeof applyRichInputContent === 'function') {
                    applyRichInputContent({ text: restoredText, html: '' });
                } else {
                    setEditorValue(restoredText);
                }
            };

            const updateSessionsToolbarState = () => {
                const hasSelection = sessionsState.sessions.some((session) => session.id === sessionsState.selectedId);
                if (sessionsRunBtn) sessionsRunBtn.disabled = !hasSelection;
                if (sessionsDeleteBtn) sessionsDeleteBtn.disabled = !hasSelection;
            };

            const renderSessionsList = () => {
                if (!sessionsList) return;
                sessionsList.innerHTML = sessionsState.sessions
                    .map((session) => {
                        const isSelected = session.id === sessionsState.selectedId;
                        const label = escapeHtml(session.name || 'Session');
                        const count = Array.isArray(session.urls) ? session.urls.length : 0;
                        return `<div class="sessions-item${isSelected ? ' is-selected' : ''}" data-session-id="${escapeHtml(session.id)}" draggable="true" role="option" aria-selected="${isSelected ? 'true' : 'false'}">
                            <span class="sessions-item-name">${label}</span>
                            <span class="sessions-item-meta">${count}</span>
                        </div>`;
                    })
                    .join('');
                if (sessionsEmpty) {
                    sessionsEmpty.style.display = sessionsState.sessions.length ? 'none' : 'block';
                }
                updateSessionsToolbarState();
            };

            const setSessionsActive = (isActive) => {
                sessionsState.isActive = !!isActive;
                if (notesSidebar) {
                    notesSidebar.classList.toggle('is-sessions-active', sessionsState.isActive);
                }
                if (notesSessionsTab) {
                    notesSessionsTab.classList.toggle('is-active', sessionsState.isActive);
                    notesSessionsTab.setAttribute('aria-selected', sessionsState.isActive ? 'true' : 'false');
                }
                if (notesSidebarTitle) {
                    notesSidebarTitle.textContent = sessionsState.isActive ? 'Sessions' : sessionsState.defaultTitle;
                }
                if (sessionsState.isActive) {
                    renderSessionsList();
                }
            };

            const selectSession = (sessionId) => {
                sessionsState.selectedId = sessionId || null;
                renderSessionsList();
            };

            const getSelectedSession = () =>
                sessionsState.sessions.find((session) => session.id === sessionsState.selectedId) || null;

            const startRenameSession = (item) => {
                if (!item) return;
                const sessionId = item.dataset.sessionId;
                const session = sessionsState.sessions.find((entry) => entry.id === sessionId);
                if (!session) return;
                const labelEl = item.querySelector('.sessions-item-name');
                if (!labelEl || labelEl.querySelector('input')) return;
                const input = document.createElement('input');
                input.className = 'sessions-item-input';
                input.value = session.name || 'Session';
                input.setAttribute('aria-label', 'Rename session');
                labelEl.replaceWith(input);
                input.focus();
                input.select();

                const finish = async (commit) => {
                    if (!item.contains(input)) return;
                    const nextName = String(input.value || '').trim();
                    const shouldCommit = commit && nextName && nextName !== session.name;
                    const label = document.createElement('span');
                    label.className = 'sessions-item-name';
                    label.textContent = shouldCommit ? nextName : (session.name || 'Session');
                    input.replaceWith(label);
                    if (shouldCommit) {
                        session.name = nextName;
                        session.updatedAt = Date.now();
                        await persistSessions();
                        setStatus('Session renamed');
                    }
                    renderSessionsList();
                };

                input.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        finish(true);
                    }
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        finish(false);
                    }
                });
                input.addEventListener('blur', () => finish(true));
            };

            const clearSessionDropIndicators = () => {
                sessionsList?.querySelectorAll('.sessions-item').forEach((item) => {
                    item.classList.remove('is-drop-before', 'is-drop-after');
                });
            };

            const reorderSessions = async (dragId, targetId, position) => {
                if (!dragId || !targetId || dragId === targetId) return;
                const sessions = sessionsState.sessions.slice();
                const fromIndex = sessions.findIndex((entry) => entry.id === dragId);
                const targetIndex = sessions.findIndex((entry) => entry.id === targetId);
                if (fromIndex < 0 || targetIndex < 0) return;
                const [moved] = sessions.splice(fromIndex, 1);
                let insertIndex = targetIndex;
                if (position === 'after') {
                    insertIndex = targetIndex + (fromIndex < targetIndex ? 0 : 1);
                } else {
                    insertIndex = targetIndex + (fromIndex < targetIndex ? -1 : 0);
                }
                insertIndex = Math.max(0, Math.min(sessions.length, insertIndex));
                sessions.splice(insertIndex, 0, moved);
                sessionsState.sessions = sessions;
                await persistSessions();
                renderSessionsList();
            };

            const fetchTrackedSessionUrls = async () => {
                try {
                    const response = await sendToBackground({ type: 'SESSION_TABS_GET' });
                    const tabs = Array.isArray(response?.tabs) ? response.tabs : [];
                    const urls = tabs
                        .map((tab) => tab?.url)
                        .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url));
                    return Array.from(new Set(urls));
                } catch (error) {
                    console.warn('[results] failed to fetch session tabs', error);
                    return [];
                }
            };

            const saveCurrentSession = async () => {
                const urls = await fetchTrackedSessionUrls();
                if (!urls.length) {
                    setStatus('No LLM tabs to save');
                    return;
                }
                const now = Date.now();
                const session = {
                    id: createSessionId(),
                    name: `Session ${formatTimestamp(now)}`,
                    urls,
                    createdAt: now,
                    updatedAt: now
                };
                sessionsState.sessions.unshift(session);
                sessionsState.selectedId = session.id;
                await persistSessions();
                renderSessionsList();
                setStatus('Session saved');
            };

            const runSelectedSession = async () => {
                const session = getSelectedSession();
                if (!session) {
                    setStatus('Select a session');
                    return;
                }
                try {
                    await sendToBackground({ type: 'SESSION_TABS_OPEN', urls: session.urls });
                    session.updatedAt = Date.now();
                    await persistSessions();
                    setStatus('Session opened');
                } catch (error) {
                    console.warn('[results] failed to open session', error);
                    setStatus('Open failed');
                }
            };

            const deleteSelectedSession = async () => {
                const session = getSelectedSession();
                if (!session) {
                    setStatus('Select a session');
                    return;
                }
                sessionsState.sessions = sessionsState.sessions.filter((entry) => entry.id !== session.id);
                sessionsState.selectedId = sessionsState.sessions[0]?.id || null;
                await persistSessions();
                renderSessionsList();
                setStatus('Session deleted');
            };

            const truncateText = (text, maxLength = 60) => {
                const value = String(text || '').trim();
                if (value.length <= maxLength) return value;
                return `${value.slice(0, maxLength).trim()}...`;
            };

            const extractWords = (text = '', limit = 100) => {
                const words = String(text || '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .split(' ')
                    .filter(Boolean);
                if (!words.length) return '';
                if (words.length <= limit) return words.join(' ');
                return `${words.slice(0, limit).join(' ')}...`;
            };

            const getPromptTextForSave = () => {
                const baseText = (promptInput?.value || '').trim();
                if (!baseText) return '';
                if (typeof applySelectedModifiersToPrompt === 'function') {
                    return applySelectedModifiersToPrompt(baseText, { includeResponses: true, wrapPromptTag: false }).trim();
                }
                return baseText;
            };

            const getOutputContentForSave = (outputId) => {
                if (!outputId) return { text: '', html: '' };
                const outputEl = document.getElementById(outputId);
                if (!outputEl) return { text: '', html: '' };
                const rawHtml = outputEl.innerHTML || '';
                const html = sanitizeInlineHtml(rawHtml).trim();
                const text = html
                    ? plainTextFromHtml(html)
                    : String(outputEl.innerText || outputEl.textContent || '').trim();
                return { text: String(text || '').trim(), html };
            };

            const getOutputTextForSave = (outputId) => getOutputContentForSave(outputId).text;

            const ensureActiveTab = async ({ allowCreate = true } = {}) => {
                await refreshTabs();
                const tabIds = new Set(state.tabs.map((tab) => tab.tabId));
                if (state.tabId && tabIds.has(state.tabId)) {
                    return true;
                }
                if (state.defaultTabId && tabIds.has(state.defaultTabId)) {
                    state.tabId = state.defaultTabId;
                    persistActiveNotesTab();
                    return true;
                }
                if (state.tabs.length) {
                    state.tabId = state.tabs[0].tabId;
                    persistActiveNotesTab();
                    return true;
                }
                if (allowCreate && notesClient?.createTab) {
                    try {
                        await notesClient.createTab({ name: 'Home' });
                        await refreshTabs();
                    } catch (error) {
                        console.warn('[results] failed to create fallback tab', error);
                    }
                    if (state.tabs.length) {
                        state.tabId = state.tabs[0].tabId;
                        persistActiveNotesTab();
                        return true;
                    }
                }
                return false;
            };

            const resolveParentTabId = async (noteId) => {
                if (!noteId) return null;
                const cached = noteCache.get(noteId);
                if (cached?.tabId) return cached.tabId;
                try {
                    const result = await notesClient.getNote({ noteId });
                    return result?.note?.tabId || null;
                } catch (error) {
                    console.warn('[results] failed to resolve parent tab', error);
                    return null;
                }
            };

            const createNoteWithFallback = async (payload, { allowDefault = true } = {}) => {
                const basePayload = { ...payload };
                const resolvedTabId = basePayload.tabId || state.tabId;
                if (resolvedTabId) {
                    basePayload.tabId = resolvedTabId;
                } else if (!allowDefault) {
                    throw new Error('No active tab');
                }
                try {
                    return await notesClient.createNote(basePayload);
                } catch (error) {
                    const message = String(error?.message || '');
                    if (!/tab not found/i.test(message)) {
                        throw error;
                    }
                    if (!allowDefault) {
                        throw error;
                    }
                    await ensureActiveTab({ allowCreate: true });
                    const retryPayload = { ...payload };
                    if (state.tabId) {
                        retryPayload.tabId = state.tabId;
                    } else {
                        delete retryPayload.tabId;
                    }
                    return await notesClient.createNote(retryPayload);
                }
            };

            const syncAfterNoteCreate = async (created) => {
                if (created?.tabId && state.tabId !== created.tabId) {
                    state.tabId = created.tabId;
                }
                await refreshTabs();
                persistActiveNotesTab();
                await refreshNotesList();
            };

            const ensureNotesReady = async () => {
                if (!state.tabId) {
                    await initNotes();
                    if (!state.tabId && state.defaultTabId) {
                        state.tabId = state.defaultTabId;
                    }
                }
                return ensureActiveTab();
            };

            const buildNoteHtmlWithMeta = ({ headerLines = [], bodyHtml = '', bodyText = '', metaLines = [] } = {}) => {
                const sections = [];
                if (Array.isArray(headerLines) && headerLines.length) {
                    sections.push(buildHtmlFromText(headerLines.join('\n')));
                }
                const body = bodyHtml || (bodyText ? buildHtmlFromText(bodyText) : '');
                if (body) sections.push(body);
                if (Array.isArray(metaLines) && metaLines.length) {
                    sections.push(buildHtmlFromText(metaLines.join('\n')));
                }
                return sections.filter(Boolean).join('<br><br>');
            };

            const savePromptNote = async () => {
                const promptText = getPromptTextForSave();
                if (!promptText) {
                    setStatus('Prompt is empty');
                    return;
                }
                if (!await ensureNotesReady()) {
                    setStatus('Notes offline');
                    return;
                }
                try {
                    const title = truncateText(promptText, 48);
                    const created = await createNoteWithFallback({
                        tabId: state.tabId,
                        parentId: null,
                        kind: 'prompt',
                        title,
                        text: promptText,
                        source: {
                            origin: 'comparator',
                            type: 'prompt',
                            pageUrl: location.href,
                            ts: Date.now()
                        }
                    });
                    if (created?.noteId) {
                        state.activeNoteId = created.noteId;
                        lastActiveByTab.set(state.tabId, created.noteId);
                        setSingleSelection(created.noteId);
                    }
                    await syncAfterNoteCreate(created);
                    setStatus('Prompt saved');
                } catch (error) {
                    console.warn('[results] failed to save prompt', error);
                    setStatus(formatStatusError('Save failed', error), 3200);
                }
            };

            const saveResponseNote = async ({ outputId, llmName }) => {
                const { text: responseText, html: responseHtml } = getOutputContentForSave(outputId);
                if (!responseText && !responseHtml) {
                    setStatus('Response is empty');
                    return;
                }
                const promptText = getPromptTextForSave();
                const promptSnippet = extractWords(promptText, 100);
                if (!await ensureNotesReady()) {
                    setStatus('Notes offline');
                    return;
                }
                const { url: responseUrl, timestamp: responseTimestamp } = resolveResponseSource(llmName);
                const timestamp = formatTimestamp(responseTimestamp);
                const titleSuffix = promptSnippet ? truncateText(promptSnippet, 36) : 'Response';
                const title = `${llmName} response - ${titleSuffix}`;
                const headerLines = [
                    `${llmName} response to prompt:`,
                    promptSnippet || '(prompt unavailable)'
                ];
                const metaLines = [
                    `Source: ${responseUrl}`,
                    `Saved: ${timestamp}`
                ];
                const contentLines = [
                    `${llmName} response to prompt:`,
                    promptSnippet || '(prompt unavailable)',
                    '',
                    responseText,
                    '',
                    '---',
                    `Source: ${responseUrl}`,
                    `Saved: ${timestamp}`
                ];
                const noteHtml = buildNoteHtmlWithMeta({
                    headerLines,
                    bodyHtml: responseHtml,
                    bodyText: responseText,
                    metaLines
                });
                try {
                    const created = await createNoteWithFallback({
                        tabId: state.tabId,
                        parentId: null,
                        kind: 'response',
                        title,
                        text: contentLines.join('\n'),
                        html: noteHtml,
                        source: {
                            origin: 'comparator',
                            type: 'response',
                            model: llmName,
                            pageUrl: responseUrl,
                            ts: responseTimestamp
                        }
                    });
                    if (created?.noteId) {
                        state.activeNoteId = created.noteId;
                        lastActiveByTab.set(state.tabId, created.noteId);
                        setSingleSelection(created.noteId);
                    }
                    await syncAfterNoteCreate(created);
                    setStatus('Response saved');
                } catch (error) {
                    console.warn('[results] failed to save response', error);
                    setStatus(formatStatusError('Save failed', error), 3200);
                }
            };

            const saveSessionNotes = async () => {
                const promptText = getPromptTextForSave();
                const promptSnippet = extractWords(promptText, 40);
                const responses = responseSaveButtons
                    .map((btn) => ({
                        llmName: btn.dataset.llmName,
                        outputId: btn.dataset.target
                    }))
                    .map((entry) => ({
                        ...entry,
                        ...getOutputContentForSave(entry.outputId)
                    }))
                    .filter((entry) => entry.text || entry.html);

                if (!promptText && !responses.length) {
                    setStatus('Nothing to save');
                    return;
                }
                if (!await ensureNotesReady()) {
                    setStatus('Notes offline');
                    return;
                }

                const timestamp = formatTimestamp();
                const titleBase = promptSnippet || `Session ${timestamp}`;
                const sessionTitle = `Session - ${truncateText(titleBase, 48)}`;
                const sessionText = [
                    promptSnippet ? `Prompt: ${promptSnippet}` : 'Prompt: (empty)',
                    `Models: ${responses.length}`,
                    `Saved: ${timestamp}`
                ].join('\n');

                try {
                    const session = await createNoteWithFallback({
                        tabId: state.tabId,
                        parentId: null,
                        kind: 'session',
                        title: sessionTitle,
                        text: sessionText,
                        source: {
                            origin: 'comparator',
                            type: 'session',
                            pageUrl: location.href,
                            ts: Date.now()
                        }
                    });
                    const sessionId = session?.noteId;
                    const sessionTabId = session?.tabId || state.tabId;
                    if (sessionId && promptText) {
                        await notesClient.createNote({
                            tabId: sessionTabId,
                            parentId: sessionId,
                            kind: 'prompt',
                            title: 'Prompt',
                            text: promptText,
                            source: {
                                origin: 'comparator',
                                type: 'prompt',
                                pageUrl: location.href,
                                ts: Date.now()
                            }
                        });
                    }
                    for (const response of responses) {
                        const { url: responseUrl, timestamp: responseTimestamp } = resolveResponseSource(response.llmName);
                        const savedAt = formatTimestamp(responseTimestamp);
                        const responseTitle = `${response.llmName} response`;
                        const metaLines = [
                            `Source: ${responseUrl}`,
                            `Saved: ${savedAt}`
                        ];
                        const responseBody = [
                            response.text,
                            '',
                            '---',
                            `Source: ${responseUrl}`,
                            `Saved: ${savedAt}`
                        ].join('\n');
                        const responseHtml = buildNoteHtmlWithMeta({
                            bodyHtml: response.html,
                            bodyText: response.text,
                            metaLines
                        });
                        await notesClient.createNote({
                            tabId: sessionTabId,
                            parentId: sessionId || null,
                            kind: 'response',
                            title: responseTitle,
                            text: responseBody,
                            html: responseHtml,
                            source: {
                                origin: 'comparator',
                                type: 'response',
                                model: response.llmName,
                                pageUrl: responseUrl,
                                ts: responseTimestamp
                            }
                        });
                    }
                    if (session?.noteId) {
                        state.activeNoteId = session.noteId;
                        lastActiveByTab.set(state.tabId, session.noteId);
                        setExpanded(session.noteId, true);
                        setSingleSelection(session.noteId);
                    }
                    await syncAfterNoteCreate(session);
                    setStatus('Session saved');
                } catch (error) {
                    console.warn('[results] failed to save session', error);
                    setStatus(formatStatusError('Save failed', error), 3200);
                }
            };

            const getTopMostSelection = async () => {
                const selected = state.selectedNoteIds.size
                    ? Array.from(state.selectedNoteIds)
                    : (state.activeNoteId ? [state.activeNoteId] : []);
                if (!selected.length) return [];
                const map = await buildAllNotesMap();
                const selectedSet = new Set(selected);
                const isDescendantSelected = (noteId) => {
                    let current = map.get(noteId);
                    while (current && current.parentId) {
                        if (selectedSet.has(current.parentId)) return true;
                        current = map.get(current.parentId);
                    }
                    return false;
                };
                return selected.filter((noteId) => !isDescendantSelected(noteId));
            };

            const buildChildrenLookup = (map) => {
                const lookup = new Map();
                map.forEach((note) => {
                    const parentId = note.parentId || null;
                    if (!lookup.has(parentId)) lookup.set(parentId, []);
                    lookup.get(parentId).push(note);
                });
                lookup.forEach((list) => {
                    list.sort((a, b) => String(a.orderKey || '').localeCompare(String(b.orderKey || '')));
                });
                return lookup;
            };

            const buildSourceMetaLines = (note) => {
                const source = note?.source || {};
                const lines = [];
                const pageUrl = typeof source.pageUrl === 'string' ? source.pageUrl.trim() : '';
                const ts = typeof source.ts === 'number' ? source.ts : null;
                if (pageUrl) lines.push(`Source: ${pageUrl}`);
                if (ts) lines.push(`Saved: ${formatTimestamp(ts)}`);
                return lines;
            };

            const normalizeNoteTextForMerge = (text, html) => {
                const rawText = typeof text === 'string' ? text : '';
                if (rawText.trim()) return rawText;
                if (!html) return '';
                return String(stripHtmlToPlainText(html) || '').trim();
            };

            const getSelectedNoteIds = () => {
                if (state.selectedNoteIds.size) return Array.from(state.selectedNoteIds);
                if (state.activeNoteId) return [state.activeNoteId];
                return [];
            };

            const getSelectedNoteIdsByVisualOrder = () => {
                const selected = getSelectedNoteIds();
                if (!selected.length) return [];
                const order = new Map();
                getVisibleTreeItems().forEach((item, index) => {
                    if (item?.dataset?.noteId) {
                        order.set(item.dataset.noteId, index);
                    }
                });
                const fallbackOrder = new Map(selected.map((noteId, index) => [noteId, index]));
                return selected
                    .slice()
                    .sort((a, b) => {
                        const aIndex = order.has(a) ? order.get(a) : 100000 + fallbackOrder.get(a);
                        const bIndex = order.has(b) ? order.get(b) : 100000 + fallbackOrder.get(b);
                        return aIndex - bIndex;
                    });
            };

            const sanitizeNoteHtml = (value) => {
                const html = sanitizeInlineHtml(String(value || '')).trim();
                return html || '';
            };

            const exportSelectedNotes = async () => {
                if (!await ensureNotesReady()) {
                    setStatus('Notes offline');
                    return;
                }
                const topMost = await getTopMostSelection();
                if (!topMost.length) {
                    setStatus('Select notes');
                    return;
                }
                const map = await buildAllNotesMap();
                const lookup = buildChildrenLookup(map);
                const idsToFetch = new Set();
                const collectIds = (noteId) => {
                    if (!noteId || idsToFetch.has(noteId)) return;
                    idsToFetch.add(noteId);
                    const children = lookup.get(noteId) || [];
                    children.forEach((child) => collectIds(child.id));
                };
                topMost.forEach(collectIds);
                const textMap = new Map();
                const htmlMap = new Map();
                for (const noteId of idsToFetch) {
                    try {
                        const result = await notesClient.getNote({ noteId });
                        textMap.set(noteId, result?.text || '');
                        htmlMap.set(noteId, sanitizeNoteHtml(result?.html || ''));
                    } catch (error) {
                        console.warn('[results] failed to fetch note for export', error);
                        textMap.set(noteId, '');
                        htmlMap.set(noteId, '');
                    }
                }
                const renderNode = (noteId) => {
                    const note = map.get(noteId);
                    if (!note) return '';
                    const children = lookup.get(noteId) || [];
                    const html = htmlMap.get(noteId) || '';
                    const text = textMap.get(noteId) || '';
                    const bodyHtml = html
                        ? `<div class="note-body">${html}</div>`
                        : (text ? `<pre>${escapeHtml(text)}</pre>` : '');
                    const childrenHtml = children.map((child) => renderNode(child.id)).join('');
                    return `<li><div class="note-title">${escapeHtml(note.title || 'Untitled')}</div>${bodyHtml}${childrenHtml ? `<ul>${childrenHtml}</ul>` : ''}</li>`;
                };
                const exportHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Notes Export</title>
  <style>
    body { font-family: sans-serif; line-height: 1.5; padding: 24px; color: #111827; }
    ul { list-style: none; padding-left: 18px; }
    .note-title { font-weight: 600; margin-bottom: 4px; }
    pre { background: #f8fafc; padding: 10px 12px; border-radius: 8px; white-space: pre-wrap; }
    .note-body { margin-bottom: 10px; word-break: break-word; }
    .note-body img { max-width: 100%; height: auto; }
  </style>
</head>
<body>
  <h1>Notes Export</h1>
  <ul>
    ${topMost.map((noteId) => renderNode(noteId)).join('')}
  </ul>
</body>
</html>`;
                const blob = new Blob([exportHtml], { type: 'text/html' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `notes_export_${formatTimestamp().replace(/[: ]/g, '-')}.html`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                setStatus('Export ready');
            };

            const mergeSelectedNotes = async () => {
                if (!await ensureNotesReady()) {
                    setStatus('Notes offline');
                    return;
                }
                const orderedIds = getSelectedNoteIdsByVisualOrder();
                if (orderedIds.length < 2) {
                    setStatus('Select at least 2');
                    return;
                }
                await flushSave();
                const selectedSet = new Set(orderedIds);
                const mainNoteId = orderedIds[0];
                const mergeIds = orderedIds.slice(1);
                const noteDataMap = new Map();

                try {
                    for (const noteId of orderedIds) {
                        const result = await notesClient.getNote({ noteId });
                        if (result?.note) {
                            noteDataMap.set(noteId, result);
                        }
                    }
                } catch (error) {
                    console.warn('[results] failed to load notes for merge', error);
                    setStatus('Merge failed');
                    return;
                }

                const mainData = noteDataMap.get(mainNoteId);
                if (!mainData?.note) {
                    setStatus('Main note missing');
                    return;
                }

                const baseHtml = sanitizeNoteHtml(mainData.html || '');
                const baseText = normalizeNoteTextForMerge(mainData.text, baseHtml);
                const baseHtmlBlock = baseHtml || (baseText ? buildHtmlFromText(baseText) : '');
                const combinedTextParts = [];
                const combinedHtmlParts = [];
                if (baseText) combinedTextParts.push(baseText);
                if (baseHtmlBlock) combinedHtmlParts.push(baseHtmlBlock);

                const buildMergedTextBlock = (data) => {
                    const html = sanitizeNoteHtml(data?.html || '');
                    const text = normalizeNoteTextForMerge(data?.text, html);
                    if (!text && !html) return '';
                    const metaLines = buildSourceMetaLines(data?.note);
                    const parts = [];
                    if (metaLines.length) parts.push(metaLines.join('\n'));
                    if (text) parts.push(text);
                    return parts.join('\n');
                };

                const buildMergedHtmlBlock = (data) => {
                    const html = sanitizeNoteHtml(data?.html || '');
                    const text = normalizeNoteTextForMerge(data?.text, html);
                    if (!text && !html) return '';
                    const metaLines = buildSourceMetaLines(data?.note);
                    const metaHtml = metaLines.length
                        ? `<div class="note-merge-meta">${metaLines.map((line) => escapeHtml(line)).join('<br>')}</div>`
                        : '';
                    const bodyHtml = html || (text ? buildHtmlFromText(text) : '');
                    if (!metaHtml) return bodyHtml;
                    return bodyHtml ? `${metaHtml}<br>${bodyHtml}` : metaHtml;
                };

                for (const noteId of mergeIds) {
                    const data = noteDataMap.get(noteId);
                    if (!data?.note) continue;
                    const textBlock = buildMergedTextBlock(data);
                    const htmlBlock = buildMergedHtmlBlock(data);
                    if (textBlock) combinedTextParts.push(textBlock);
                    if (htmlBlock) combinedHtmlParts.push(htmlBlock);
                }

                const combinedText = combinedTextParts.filter(Boolean).join('\n\n');
                const combinedHtml = combinedHtmlParts.filter(Boolean).join('<br><br>');

                try {
                    let movedChildren = false;
                    for (const noteId of mergeIds) {
                        const data = noteDataMap.get(noteId);
                        const tabId = data?.note?.tabId || state.tabId;
                        if (!tabId) continue;
                        const result = await notesClient.listChildren({ tabId, parentId: noteId });
                        const children = result?.notes || [];
                        for (const child of children) {
                            if (!child?.id || selectedSet.has(child.id)) continue;
                            await notesClient.moveNote({
                                noteId: child.id,
                                targetParentId: mainNoteId
                            });
                            movedChildren = true;
                        }
                    }

                    await notesClient.updateNoteText({
                        noteId: mainNoteId,
                        text: combinedText,
                        html: combinedHtml
                    });

                    for (const noteId of mergeIds) {
                        await notesClient.deleteNote({ noteId });
                    }

                    state.activeNoteId = mainNoteId;
                    state.selectedNoteIds.clear();
                    state.selectedNoteIds.add(mainNoteId);
                    state.anchorNoteId = mainNoteId;
                    if (movedChildren) {
                        setExpanded(mainNoteId, true);
                    }
                    await refreshNotesList();
                    await selectNote(mainNoteId, { skipSave: true, force: true, focus: true, preserveSelection: true });
                    setStatus(`Merged ${orderedIds.length} notes`);
                } catch (error) {
                    console.warn('[results] failed to merge notes', error);
                    setStatus('Merge failed');
                }
            };

            const deleteSelectedNotes = async () => {
                if (!await ensureNotesReady()) {
                    setStatus('Notes offline');
                    return;
                }
                const topMost = await getTopMostSelection();
                if (!topMost.length) {
                    setStatus('Select notes');
                    return;
                }
                try {
                    for (const noteId of topMost) {
                        await notesClient.deleteNote({ noteId });
                    }
                    state.selectedNoteIds.clear();
                    state.anchorNoteId = null;
                    await refreshNotesList();
                    setStatus('Deleted');
                } catch (error) {
                    console.warn('[results] failed to delete notes', error);
                    setStatus('Delete failed');
                }
            };

            const toggleSelectAll = async () => {
                const allIds = await getAllNoteIds();
                if (!allIds.length) return;
                const selectedCount = state.selectedNoteIds.size;
                if (selectedCount === allIds.length) {
                    state.selectedNoteIds.clear();
                    state.anchorNoteId = null;
                } else {
                    state.selectedNoteIds.clear();
                    allIds.forEach((id) => state.selectedNoteIds.add(id));
                    state.anchorNoteId = allIds[0];
                    if (!state.activeNoteId && allIds[0]) {
                        await selectNote(allIds[0], { preserveSelection: true });
                    }
                }
                syncSelectionStyles();
            };

            const initNotes = async () => {
                try {
                    const initResult = await notesClient.init();
                    const defaultTabId = initResult?.defaultTabId || null;
                    state.defaultTabId = defaultTabId;
                    let scratch = null;
                    try {
                        scratch = await notesClient.getOrCreateScratch(scratchConfig);
                    } catch (error) {
                        console.warn('[results] failed to load scratch note', error);
                    }
                    await refreshTabs();
                    await pruneEmptyTabs();
                    if (!state.tabs.length && defaultTabId) {
                        state.tabs = [{ tabId: defaultTabId, name: 'Home' }];
                    }
                    if (!state.tabs.length && scratch?.tabId) {
                        state.tabs = [{ tabId: scratch.tabId, name: 'Home' }];
                    }
                    if (!state.tabs.length && notesClient?.createTab) {
                        try {
                            await notesClient.createTab({ name: 'Home' });
                            await refreshTabs();
                        } catch (error) {
                            console.warn('[results] failed to create default tab', error);
                        }
                    }
                    state.tabId = scratch?.tabId || defaultTabId || state.tabs[0]?.tabId || null;
                    renderTabs(state.tabs);
                    persistActiveNotesTab();
                    if (scratch?.noteId && scratch?.tabId === state.tabId) {
                        state.activeNoteId = scratch.noteId;
                    }
                    await refreshNotesList();
                    if (scratch?.noteId && scratch?.tabId === state.tabId) {
                        await selectNote(scratch.noteId, { skipSave: true, force: true });
                    }
                } catch (error) {
                    console.warn('[results] failed to init notes', error);
                    if (notesEmpty) {
                        notesEmpty.textContent = 'Notes offline.';
                    }
                }
            };

            if (promptInput) {
                promptInput.addEventListener('input', () => {
                    if (editorState.suppressInput) return;
                    if (editorState.mode !== 'EDITING') return;
                    if (!editorState.suppressTitleSync && !editorState.isTitleEditing) {
                        updateEditingTitle(getEditorValue());
                    }
                    scheduleSave();
                });
            }
            if (promptNoteView) {
                promptNoteView.addEventListener('input', () => {
                    if (editorState.suppressInput) return;
                    const isNoteEditing = editorState.mode === 'EDITING';
                    const isRichPrompt = editorState.mode === 'PROMPT' && useInputRichMode;
                    if (!isNoteEditing && !isRichPrompt) return;
                    const { text } = getEditorContent();
                    syncPromptValue(text, { dispatch: isRichPrompt });
                    if (isNoteEditing && !editorState.suppressTitleSync && !editorState.isTitleEditing) {
                        updateEditingTitle(text);
                    }
                    if (isNoteEditing) {
                        scheduleSave();
                    }
                });
            }

            const handleNoteSingleClick = async (noteId, { isShift = false, isMeta = false } = {}) => {
                if (!noteId) return;
                if (isShift) {
                    const anchor = state.anchorNoteId || noteId;
                    selectRange(anchor, noteId, { additive: isMeta });
                    await selectNote(noteId, { focus: true, preserveSelection: true });
                    return;
                }
                if (isMeta) {
                    toggleSelection(noteId);
                    await selectNote(noteId, { focus: true, preserveSelection: true });
                    return;
                }
                if (editorState.mode === 'EDITING' && editorState.noteId) {
                    if (!shouldAutosaveContent(getEditorContent())) {
                        restoreEditingTitle();
                    }
                    await flushSave();
                }
                setSingleSelection(noteId);
                const notePayload = await selectNote(noteId, { focus: true, preserveSelection: true });
                await applyNoteToPrompt(noteId, { mode: 'VIEWING', noteText: notePayload });
            };

            const handleNoteDoubleClick = async (noteId) => {
                if (!noteId) return;
                if (editorState.mode === 'EDITING' && editorState.noteId && editorState.noteId !== noteId) {
                    if (!shouldAutosaveContent(getEditorContent())) {
                        restoreEditingTitle();
                    }
                    await flushSave();
                }
                const notePayload = await selectNote(noteId, { focus: true, preserveSelection: false, force: true });
                await applyNoteToPrompt(noteId, { mode: 'EDITING', noteText: notePayload });
            };

            notesTree?.addEventListener('click', async (event) => {
                const actionButton = event.target.closest('[data-action]');
                if (actionButton) {
                    const action = actionButton.getAttribute('data-action');
                    const noteId = actionButton.getAttribute('data-note-id');
                    if (notesClickTimer) {
                        clearTimeout(notesClickTimer);
                        notesClickTimer = null;
                        notesClickTargetId = null;
                    }
                    if (action === 'add-child') {
                        event.stopPropagation();
                        createChildNote(noteId);
                        return;
                    }
                    if (action === 'toggle') {
                        event.stopPropagation();
                        toggleExpand(noteId);
                        return;
                    }
                }
                if (getEditableTitleTarget(event.target)) return;
                const item = event.target.closest('.notes-tree-item');
                if (!item) return;
                const noteId = item.dataset.noteId;
                const now = performance.now();
                const withinDelay = notesClickTime > 0 && (now - notesClickTime) < NOTE_DBLCLICK_DELAY;
                const isDouble = withinDelay && (notesClickTargetId === noteId);
                const isChildDouble = withinDelay && notesClickTargetId && isDescendantNote(noteId, notesClickTargetId);
                if (isDouble) {
                    clearTimeout(notesClickTimer);
                    notesClickTimer = null;
                    notesClickTargetId = null;
                    await handleNoteDoubleClick(noteId);
                    return;
                }
                if (isChildDouble) {
                    const targetId = notesClickTargetId;
                    clearTimeout(notesClickTimer);
                    notesClickTimer = null;
                    notesClickTargetId = null;
                    await handleNoteDoubleClick(targetId);
                    return;
                }
                notesClickTargetId = noteId;
                notesClickTime = now;
                const modifiers = {
                    isShift: event.shiftKey,
                    isMeta: event.metaKey || event.ctrlKey
                };
                if (notesClickTimer) clearTimeout(notesClickTimer);
                notesClickTimer = setTimeout(() => {
                    notesClickTimer = null;
                    handleNoteSingleClick(noteId, modifiers);
                }, NOTE_DBLCLICK_DELAY);
            });

            notesTree?.addEventListener('focusin', (event) => {
                const titleEl = getEditableTitleTarget(event.target);
                if (!titleEl) return;
                editorState.isTitleEditing = true;
            });

            notesTree?.addEventListener('focusout', (event) => {
                const titleEl = getEditableTitleTarget(event.target);
                if (!titleEl) return;
                editorState.isTitleEditing = false;
                const normalized = normalizeNoteTitle(titleEl.textContent);
                if (!normalized) {
                    restoreEditingTitle();
                    return;
                }
                if (titleEl.textContent !== normalized) {
                    titleEl.textContent = normalized;
                }
                if (!promptInput) return;
                if (editorState.mode !== 'EDITING' || !editorState.noteId) return;
                const item = titleEl.closest('.notes-tree-item');
                const noteId = item?.dataset?.noteId;
                if (!noteId || noteId !== editorState.noteId) return;
                const currentText = getEditorValue();
                const nextText = buildTextWithTitle(currentText, normalized);
                if (nextText === currentText) return;
                editorState.suppressTitleSync = true;
                if (promptNoteView && editorState.mode !== 'PROMPT') {
                    const currentHtml = getNoteViewHtml();
                    const updatedHtml = updateNoteHtmlTitle(currentHtml, normalized);
                    editorState.suppressInput = true;
                    if (updatedHtml) {
                        promptNoteView.innerHTML = updatedHtml;
                    } else {
                        promptNoteView.textContent = nextText;
                    }
                    editorState.suppressInput = false;
                }
                syncPromptValue(nextText);
                editorState.suppressTitleSync = false;
                scheduleSave();
            });

            notesTree?.addEventListener('input', (event) => {
                const titleEl = getEditableTitleTarget(event.target);
                if (!titleEl) return;
                if (!promptInput) return;
                if (editorState.mode !== 'EDITING' || !editorState.noteId) return;
                const item = titleEl.closest('.notes-tree-item');
                const noteId = item?.dataset?.noteId;
                if (!noteId || noteId !== editorState.noteId) return;
                const normalized = normalizeNoteTitle(titleEl.textContent);
                if (!normalized) return;
                const currentText = getEditorValue();
                const nextText = buildTextWithTitle(currentText, normalized);
                if (nextText === currentText) return;
                editorState.suppressTitleSync = true;
                if (promptNoteView && editorState.mode !== 'PROMPT') {
                    const currentHtml = getNoteViewHtml();
                    const updatedHtml = updateNoteHtmlTitle(currentHtml, normalized);
                    editorState.suppressInput = true;
                    if (updatedHtml) {
                        promptNoteView.innerHTML = updatedHtml;
                    } else {
                        promptNoteView.textContent = nextText;
                    }
                    editorState.suppressInput = false;
                }
                syncPromptValue(nextText);
                editorState.suppressTitleSync = false;
                scheduleSave();
            });

            notesTree?.addEventListener('keydown', (event) => {
                const titleEl = getEditableTitleTarget(event.target);
                if (!titleEl) return;
                if (event.key === 'Enter') {
                    event.preventDefault();
                    titleEl.blur();
                }
            });

            document.addEventListener('click', async (event) => {
                const target = event.target;
                const inPrompt = target?.closest('.prompt-container') || target?.closest('.prompt-group');
                const inNotesPanel = notesPanel && notesPanel.contains(target);
                if (editorState.mode !== 'PROMPT') {
                    if (inPrompt || inNotesPanel) return;
                    await exitNotesMode();
                    return;
                }
                if (sessionPreview.isActive && !inPrompt && !inNotesPanel) {
                    restoreSessionPreview();
                }
            });

            document.addEventListener('keydown', (event) => {
                if (event.key !== 'Escape') return;
                if (editorState.mode !== 'EDITING') return;
                if (state.saveTimer) clearTimeout(state.saveTimer);
                restoreEditingTitle();
                setEditorValue(editorState.originalText);
                setEditorMode('PROMPT');
            });

            document.addEventListener('click', (event) => {
                const btn = event.target.closest('#clear-prompt-btn');
                if (!btn) return;
                if (editorState.mode !== 'EDITING') return;
                if (state.saveTimer) clearTimeout(state.saveTimer);
                restoreEditingTitle();
                setEditorMode('PROMPT');
            });

            notesTree?.addEventListener('dragstart', (event) => {
                const target = event.target;
                if (getEditableTitleTarget(target)) return;
                if (target?.closest('button') || target?.closest('input')) return;
                const item = target?.closest('.notes-tree-item');
                if (!item || !notesTree.contains(item)) return;
                const noteId = item.dataset.noteId;
                if (!noteId) return;
                dragState.noteId = noteId;
                dragState.targetId = null;
                dragState.position = null;
                event.dataTransfer.effectAllowed = 'move';
                try {
                    event.dataTransfer.setData('text/plain', noteId);
                } catch (_) {}
            });

            notesTree?.addEventListener('dragover', (event) => {
                const isNoteDrag = !!dragState.noteId;
                const types = Array.from(event.dataTransfer?.types || []);
                const isTextDrag = types.includes(DRAG_MIME) || types.includes('text/plain');
                if (!isNoteDrag && !isTextDrag) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = isNoteDrag ? 'move' : 'copy';
                const { item, targetId, position } = resolveDropTarget(event);
                if (isNoteDrag) {
                    const draggedItem = notesTree.querySelector(`.notes-tree-item[data-note-id="${dragState.noteId}"]`);
                    if (!item || !notesTree.contains(item) || item === draggedItem) {
                        dragState.targetId = null;
                        dragState.position = 'root';
                        setDropIndicator(null);
                        return;
                    }
                    if (draggedItem && draggedItem.contains(item)) {
                        dragState.targetId = null;
                        dragState.position = null;
                        clearDropIndicators();
                        return;
                    }
                    dragState.targetId = targetId;
                    dragState.position = position;
                    setDropIndicator(item, position);
                } else {
                    textDragState.targetId = targetId;
                    textDragState.position = position;
                    setDropIndicator(item, position);
                }
            });

            notesTree?.addEventListener('dragend', () => {
                dragState.noteId = null;
                dragState.targetId = null;
                dragState.position = null;
                textDragState.targetId = null;
                textDragState.position = null;
                clearDropIndicators();
            });

            notesTree?.addEventListener('drop', async (event) => {
                event.preventDefault();
                if (dragState.noteId) {
                    const noteId = dragState.noteId;
                    const targetId = dragState.targetId;
                    const position = dragState.position;
                    clearDropIndicators();
                    dragState.noteId = null;
                    dragState.targetId = null;
                    dragState.position = null;

                    let targetParentId = null;
                    let beforeId = null;
                    let afterId = null;

                    if (!targetId && position !== 'root') return;
                    if (!targetId || position === 'root') {
                        targetParentId = null;
                    } else if (position === 'inside') {
                        targetParentId = targetId;
                    } else {
                        const targetItem = notesTree.querySelector(`.notes-tree-item[data-note-id="${targetId}"]`);
                        const parentId = targetItem?.dataset?.parentId || null;
                        targetParentId = parentId || null;
                        if (position === 'before') beforeId = targetId;
                        if (position === 'after') afterId = targetId;
                    }

                    if (noteId === targetId) return;
                    if (!notesClient?.moveNote) return;
                    try {
                        await notesClient.moveNote({
                            noteId,
                            targetParentId,
                            beforeId,
                            afterId
                        });
                        state.activeNoteId = noteId;
                        lastActiveByTab.set(state.tabId, noteId);
                        if (targetParentId) {
                            setExpanded(targetParentId, true);
                        }
                        await refreshNotesList();
                        setStatus('Note moved');
                    } catch (error) {
                        console.warn('[results] failed to move note', error);
                        setStatus('Move failed');
                    }
                    return;
                }

                const payload = getDragPayload(event);
                if (!payload?.text) return;
                const target = textDragState.targetId ? textDragState : resolveDropTarget(event);
                textDragState.targetId = null;
                textDragState.position = null;
                clearDropIndicators();
                await createNoteFromDrag(payload, target);
            });

            notesTree?.addEventListener('dragleave', (event) => {
                if (!notesTree.contains(event.relatedTarget)) {
                    clearDropIndicators();
                }
            });

            promptInput?.addEventListener('dragstart', (event) => {
                const text = getPromptDragText();
                if (!text) return;
                const payload = buildDragPayload({ text, type: 'prompt' });
                setDragPayload(event, payload);
            });

            llmResultsContainer?.addEventListener('dragstart', (event) => {
                const target = event.target;
                if (!target?.closest) return;
                const outputEl = target.closest('.llm-panel .output');
                if (!outputEl || !llmResultsContainer.contains(outputEl)) return;
                const text = getOutputDragText(outputEl);
                if (!text) return;
                const llmName = resolveLlmNameForOutput(outputEl);
                const payload = buildDragPayload({ text, type: 'response', llmName });
                setDragPayload(event, payload);
            });

            notesTree?.addEventListener('keydown', async (event) => {
                const key = event.key;
                if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(key)) return;
                const items = getVisibleTreeItems();
                if (!items.length) return;
                const activeElement = document.activeElement?.closest('.notes-tree-item');
                const current = (activeElement && notesTree.contains(activeElement))
                    ? activeElement
                    : items.find((item) => item.dataset.noteId === state.activeNoteId) || items[0];
                if (!current) return;
                const currentId = current.dataset.noteId;
                if (!currentId) return;
                event.preventDefault();

                if (key === 'ArrowUp') {
                    const idx = items.indexOf(current);
                    const target = items[idx - 1];
                    if (target) {
                        await selectNote(target.dataset.noteId, { focus: true });
                    }
                    return;
                }
                if (key === 'ArrowDown') {
                    const idx = items.indexOf(current);
                    const target = items[idx + 1];
                    if (target) {
                        await selectNote(target.dataset.noteId, { focus: true });
                    }
                    return;
                }
                if (key === 'ArrowLeft') {
                    const expanded = current.getAttribute('aria-expanded') === 'true';
                    if (itemHasChildren(current) && expanded) {
                        await toggleExpand(currentId);
                        focusNoteItem(currentId);
                        return;
                    }
                    const parent = getParentItem(current);
                    if (parent?.dataset?.noteId) {
                        await selectNote(parent.dataset.noteId, { focus: true });
                    }
                    return;
                }
                if (key === 'ArrowRight') {
                    const expanded = current.getAttribute('aria-expanded') === 'true';
                    if (itemHasChildren(current) && !expanded) {
                        await toggleExpand(currentId);
                        focusNoteItem(currentId);
                        return;
                    }
                    if (itemHasChildren(current) && expanded) {
                        const firstChild = getFirstChildItem(current);
                        if (firstChild?.dataset?.noteId) {
                            await selectNote(firstChild.dataset.noteId, { focus: true });
                        }
                    }
                    return;
                }
                if (key === 'Enter') {
                    if (itemHasChildren(current)) {
                        await toggleExpand(currentId);
                        focusNoteItem(currentId);
                    }
                }
            });

            notesSearch?.addEventListener('input', (event) => {
                const value = event.target.value;
                setSearchQuery(value);
                if (notesSearchClear) {
                    notesSearchClear.classList.toggle('is-visible', String(value || '').trim().length > 0);
                }
            });

            notesSearchClear?.addEventListener('click', () => {
                if (!notesSearch) return;
                notesSearch.value = '';
                setSearchQuery('');
                notesSearchClear.classList.remove('is-visible');
                notesSearch.focus();
            });

            notesAddRootBtn?.addEventListener('click', () => {
                createRootNote();
            });

            notesSelectAll?.addEventListener('change', () => {
                toggleSelectAll();
            });

            notesExportBtn?.addEventListener('click', () => {
                exportSelectedNotes();
            });

            notesMergeBtn?.addEventListener('click', () => {
                mergeSelectedNotes();
            });

            notesDeleteBtn?.addEventListener('click', () => {
                deleteSelectedNotes();
            });

            notesTabAdd?.addEventListener('click', () => {
                createTab();
            });

            notesSessionsTab?.addEventListener('click', () => {
                setSessionsActive(true);
            });

            sessionsSaveBtn?.addEventListener('click', () => {
                saveCurrentSession();
            });

            sessionsRunBtn?.addEventListener('click', () => {
                runSelectedSession();
            });

            sessionsDeleteBtn?.addEventListener('click', () => {
                deleteSelectedSession();
            });

            sessionsList?.addEventListener('click', async (event) => {
                const item = event.target.closest('.sessions-item');
                if (!item || !sessionsList.contains(item)) return;
                if (event.target.closest('input')) return;
                const sessionId = item.dataset.sessionId;
                if (sessionClickTimer) {
                    clearTimeout(sessionClickTimer);
                }
                sessionClickTimer = setTimeout(async () => {
                    selectSession(sessionId);
                    const session = sessionsState.sessions.find((entry) => entry.id === sessionId);
                    if (session) {
                        await showSessionPreview(session);
                    }
                    sessionClickTimer = null;
                }, 120);
            });

            sessionsList?.addEventListener('dblclick', (event) => {
                const item = event.target.closest('.sessions-item');
                if (!item || !sessionsList.contains(item)) return;
                if (event.target.closest('input')) return;
                if (sessionClickTimer) {
                    clearTimeout(sessionClickTimer);
                    sessionClickTimer = null;
                }
                startRenameSession(item);
            });

            sessionsList?.addEventListener('dragstart', (event) => {
                const item = event.target.closest('.sessions-item');
                if (!item || !sessionsList.contains(item)) return;
                if (event.target.closest('input')) return;
                sessionsState.dragId = item.dataset.sessionId;
                item.classList.add('is-dragging');
                event.dataTransfer.effectAllowed = 'move';
                try {
                    event.dataTransfer.setData('text/plain', sessionsState.dragId);
                } catch (_) {}
            });

            sessionsList?.addEventListener('dragover', (event) => {
                if (!sessionsState.dragId) return;
                const item = event.target.closest('.sessions-item');
                if (!item || !sessionsList.contains(item)) return;
                if (item.dataset.sessionId === sessionsState.dragId) return;
                event.preventDefault();
                clearSessionDropIndicators();
                const rect = item.getBoundingClientRect();
                const offsetY = event.clientY - rect.top;
                const position = offsetY > rect.height / 2 ? 'after' : 'before';
                item.classList.add(position === 'after' ? 'is-drop-after' : 'is-drop-before');
                sessionsState.dragOverId = item.dataset.sessionId;
                sessionsState.dragPosition = position;
            });

            sessionsList?.addEventListener('drop', async (event) => {
                if (!sessionsState.dragId) return;
                event.preventDefault();
                const dragId = sessionsState.dragId;
                const targetId = sessionsState.dragOverId;
                const position = sessionsState.dragPosition || 'before';
                sessionsState.dragId = null;
                sessionsState.dragOverId = null;
                sessionsState.dragPosition = null;
                clearSessionDropIndicators();
                sessionsList.querySelectorAll('.sessions-item').forEach((item) => {
                    item.classList.remove('is-dragging');
                });
                await reorderSessions(dragId, targetId, position);
            });

            sessionsList?.addEventListener('dragend', () => {
                sessionsState.dragId = null;
                sessionsState.dragOverId = null;
                sessionsState.dragPosition = null;
                clearSessionDropIndicators();
                sessionsList.querySelectorAll('.sessions-item').forEach((item) => {
                    item.classList.remove('is-dragging');
                });
            });

            sessionsList?.addEventListener('dragleave', (event) => {
                if (!sessionsList.contains(event.relatedTarget)) {
                    clearSessionDropIndicators();
                }
            });

            promptSaveBtn?.addEventListener('click', () => {
                savePromptNote();
            });

            saveSessionBtn?.addEventListener('click', () => {
                saveSessionNotes();
            });

            responseSaveButtons.forEach((btn) => {
                btn.addEventListener('click', () => {
                    saveResponseNote({
                        outputId: btn.dataset.target,
                        llmName: btn.dataset.llmName || 'Response'
                    });
                });
            });

            const savePipelineRun = async ({ title, text, json } = {}) => {
                if (!text) {
                    setStatus('Pipeline output empty');
                    return false;
                }
                if (!await ensureNotesReady()) {
                    setStatus('Notes offline');
                    return false;
                }
                const timestamp = formatTimestamp();
                const noteTitle = title ? `${title} - ${timestamp}` : `Pipeline Run - ${timestamp}`;
                const body = [
                    text,
                    '',
                    '---',
                    `Source: ${location.href}`,
                    `Saved: ${timestamp}`
                ].join('\n');
                try {
                    const created = await createNoteWithFallback({
                        tabId: state.tabId,
                        parentId: null,
                        kind: 'pipeline',
                        title: noteTitle,
                        text: body,
                        source: {
                            origin: 'comparator',
                            type: 'pipeline',
                            pageUrl: location.href,
                            ts: Date.now(),
                            payload: json || null
                        }
                    });
                    if (created?.noteId) {
                        state.activeNoteId = created.noteId;
                        lastActiveByTab.set(state.tabId, created.noteId);
                        setSingleSelection(created.noteId);
                    }
                    await syncAfterNoteCreate(created);
                    setStatus('Pipeline saved');
                    return true;
                } catch (error) {
                    console.warn('[results] failed to save pipeline', error);
                    setStatus(formatStatusError('Save failed', error), 3200);
                    return false;
                }
            };

            window.PipelineNotes = {
                ...(window.PipelineNotes || {}),
                savePipelineRun
            };

            notesClient.onEvent((event) => {
                if (event?.event !== notesClient.EVENTS?.REVISION_BUMP) return;
                if (!state.tabId || event.tabId !== state.tabId) return;
                refreshNotesList();
                refreshActiveNote();
            });

            window.addEventListener('beforeunload', () => {
                if (!chrome?.storage?.local?.set) return;
                try {
                    chrome.storage.local.set({ [NOTES_ACTIVE_TAB_KEY]: null });
                } catch (error) {
                    console.warn('[results] failed to clear active tab', error);
                }
            });

            await loadSessions();
            renderSessionsList();
            setSessionsActive(false);

            setEditorEnabled(false);
            initNotes();
        }
    }

    tooltipTargets.forEach(target => {
        target.addEventListener('mouseenter', () => positionFloatingTooltip(target));
        target.addEventListener('focus', () => positionFloatingTooltip(target));
        target.addEventListener('mouseleave', () => hideFloatingTooltip(target));
        target.addEventListener('blur', () => hideFloatingTooltip(target));
    });

    window.addEventListener('scroll', () => {
        if (activeTooltipTarget) positionFloatingTooltip(activeTooltipTarget);
    }, { passive: true });

    window.addEventListener('resize', () => {
        if (activeTooltipTarget) positionFloatingTooltip(activeTooltipTarget);
        requestAnimationFrame(layoutModifierMasonry);
    });

    const setResultsViewMode = (mode = 'grid') => {
        if (!llmResultsContainer) return;
        const useStack = mode === 'stack';
        llmResultsContainer.classList.remove('view-grid', 'view-stack');
        llmResultsContainer.classList.add(useStack ? 'view-stack' : 'view-grid');
        if (viewGridBtn) viewGridBtn.classList.toggle('is-active', !useStack);
        if (viewStackBtn) viewStackBtn.classList.toggle('is-active', useStack);
    };

    setResultsViewMode('grid');

    const attachPanelExpansionHandlers = () => {
        if (!llmPanels || !llmPanels.length) return;
        llmPanels.forEach(panel => {
            const titleEl = panel.querySelector('.llm-title');
            const outputEl = panel.querySelector('.output');
            if (!titleEl || !outputEl) return;
            const collapsedHeight = outputEl.dataset.defaultMaxHeight || DEFAULT_PANEL_OUTPUT_MAX_HEIGHT;
            titleEl.addEventListener('dblclick', () => {
                const isExpanded = panel.classList.toggle('llm-panel-expanded');
                if (isExpanded) {
                    outputEl.dataset.collapsedMaxHeight = outputEl.style.maxHeight || collapsedHeight;
                    outputEl.style.maxHeight = EXPANDED_PANEL_OUTPUT_MAX_HEIGHT;
                    outputEl.style.minHeight = '240px';
                    panel.scrollIntoView({ block: 'center', behavior: 'smooth' });
                } else {
                    const fallbackHeight = outputEl.dataset.collapsedMaxHeight || collapsedHeight;
                    outputEl.style.maxHeight = fallbackHeight;
                    outputEl.style.minHeight = '';
                }
            });
        });
    };
    attachPanelExpansionHandlers();

    if (viewGridBtn) {
        viewGridBtn.addEventListener('click', () => setResultsViewMode('grid'));
    }
    if (viewStackBtn) {
        viewStackBtn.addEventListener('click', () => setResultsViewMode('stack'));
    }

    const getPanelByLLMName = (llmName) => {
        if (!llmName) return null;
        const targetName = llmName.trim().toLowerCase();
        return Array.from(llmPanels || []).find((panel) => {
            const title = panel.querySelector('.llm-title');
            return title && title.textContent.trim().toLowerCase() === targetName;
        }) || null;
    };

    const ensureApiIndicator = (llmName) => {
        if (!llmName) return null;
        if (apiIndicatorRegistry.has(llmName)) {
            return apiIndicatorRegistry.get(llmName);
        }
        const panel = getPanelByLLMName(llmName);
        if (!panel) return null;
        const referenceBtn = panel.querySelector('.status-resend-btn');
        if (!referenceBtn) return null;
        const indicator = document.createElement('span');
        indicator.className = 'api-indicator is-idle';
        indicator.dataset.llmName = llmName;
        indicator.textContent = 'API';
        referenceBtn.insertAdjacentElement('afterend', indicator);
        apiIndicatorRegistry.set(llmName, indicator);
        return indicator;
    };

    const setApiIndicatorState = (llmName, state = 'idle', meta = {}) => {
        if (!llmName) return;
        const indicator = ensureApiIndicator(llmName);
        if (!indicator) return;
        const normalized = state === 'active' || state === 'pending' ? state : 'idle';
        indicator.classList.remove('is-idle', 'is-active', 'is-pending');
        indicator.classList.add(`is-${normalized}`);
        indicator.dataset.state = normalized;
        const detailParts = [];
        if (meta.endpoint) {
            detailParts.push(`Endpoint: ${meta.endpoint}`);
        }
        if (meta.connectionTimeout || meta.responseTimeout) {
            const connectMs = meta.connectionTimeout ? `${meta.connectionTimeout}ms` : '?';
            const responseMs = meta.responseTimeout ? `${meta.responseTimeout}ms` : '?';
            detailParts.push(`Timeouts ${connectMs}/${responseMs}`);
        }
        indicator.title = meta.message || (detailParts.length ? detailParts.join(' • ') : 'API status');
        apiIndicatorState[llmName] = normalized;
    };

    const initializeApiIndicators = () => {
        Array.from(llmPanels || []).forEach((panel) => {
            const title = panel.querySelector('.llm-title');
            const llmName = title?.textContent?.trim();
            if (!llmName) return;
            ensureApiIndicator(llmName);
            setApiIndicatorState(llmName, apiIndicatorState[llmName] || 'idle');
        });
    };

    const setSelectorHealthStatus = (text) => {
        if (!selectorHealthStatus) return;
        selectorHealthStatus.textContent = text || '';
    };

    const formatSelectorHealthTime = (ts) => ts ? new Date(ts).toLocaleString() : '—';

    const formatSelectorHealthPct = (value, total) => {
        if (!total) return '—';
        const pct = Math.round((Number(value || 0) / total) * 100);
        return `${pct}%`;
    };

    const truncateSelectorHealthText = (value, limit = 46) => {
        const text = String(value || '').trim();
        if (!text) return '';
        if (text.length <= limit) return text;
        return `${text.slice(0, Math.max(0, limit - 1))}…`;
    };

    const renderSelectorHealth = (summary) => {
        if (!selectorHealthSummary || !selectorHealthTable) return;
        const rows = Array.isArray(summary?.rows) ? summary.rows : [];
        const totalSamples = Number(summary?.totalSamples || 0);
        const updatedAt = summary?.updatedAt || null;
        selectorHealthSnapshot = summary && typeof summary === 'object' ? summary : null;

        if (!rows.length || totalSamples === 0) {
            selectorHealthSummary.innerHTML = '<span class="help-text">Нет данных о здоровье селекторов</span>';
            selectorHealthTable.innerHTML = '<p class="help-text">Нет данных</p>';
            setSelectorHealthStatus('нет данных');
            return;
        }

        const updatedLabel = `Обновлено: ${formatSelectorHealthTime(updatedAt)}`;
        const sampleLabel = `Семплов: ${totalSamples}`;
        selectorHealthSummary.textContent = `${updatedLabel} · ${sampleLabel}`;
        setSelectorHealthStatus(sampleLabel);

        const rowHtml = rows.map((row) => {
            const total = Number(row?.counts?.total || 0);
            const note = total > 0 && total < 50
                ? '<span class="selector-health-note">Недостаточно данных</span>'
                : '';
            const chips = [
                { key: 'L1', className: 'is-l1', value: row.counts?.L1 || 0 },
                { key: 'L2', className: 'is-l2', value: row.counts?.L2 || 0 },
                { key: 'L3', className: 'is-l3', value: row.counts?.L3 || 0 },
                { key: 'L4', className: 'is-l4', value: row.counts?.L4 || 0 },
                { key: 'fail', className: 'is-fail', value: row.counts?.fail || 0 },
                { key: 'error', className: 'is-error', value: row.counts?.error || 0 }
            ].map((item) => {
                const pct = formatSelectorHealthPct(item.value, total);
                return `<span class="selector-health-chip ${item.className}">${item.key} ${pct}</span>`;
            }).join('');

            const overrideDetail = truncateSelectorHealthText(row.lastOverride?.reason || row.lastOverride?.selector);
            const lastOverride = row.lastOverride
                ? `${formatSelectorHealthTime(row.lastOverride.ts)}${overrideDetail ? ` · ${escapeHtml(overrideDetail)}` : ''}`
                : '—';
            const lastCheck = row.lastHealthCheck
                ? `${row.lastHealthCheck.success ? 'OK' : 'FAIL'}${row.lastHealthCheck.layer ? ` · ${row.lastHealthCheck.layer}` : ''}${row.lastHealthCheck.error ? ` · ${escapeHtml(truncateSelectorHealthText(row.lastHealthCheck.error))}` : ''}`
                : '—';
            const activeVersion = row.activeUiVersion
                ? `${escapeHtml(row.activeUiVersion)}${row.activeTabId ? ` · #${row.activeTabId}` : ''}`
                : '—';

            return `
                <tr>
                    <td>${escapeHtml(row.modelName || 'unknown')}</td>
                    <td>${escapeHtml(row.elementType || 'unknown')}</td>
                    <td>
                        <div class="selector-health-metrics">
                            <span>Семплов: ${total}</span>
                            <div class="selector-health-chip-row">${chips}</div>
                            ${note}
                        </div>
                    </td>
                    <td class="selector-health-muted">${lastOverride}</td>
                    <td class="selector-health-muted">${lastCheck}</td>
                    <td class="selector-health-muted">${activeVersion}</td>
                </tr>
            `;
        }).join('');

        selectorHealthTable.innerHTML = `
            <table class="selector-health-table-grid">
                <thead>
                    <tr>
                        <th>Model</th>
                        <th>Element</th>
                        <th>Metrics</th>
                        <th>Last override</th>
                        <th>Last check</th>
                        <th>Active UI</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowHtml}
                </tbody>
            </table>
        `;
    };

    const requestSelectorHealthSummary = (includeActiveVersions = false) => {
        if (!selectorHealthSummary || !selectorHealthTable) return;
        selectorHealthSummary.innerHTML = '<span class="help-text">Обновляем…</span>';
        selectorHealthTable.innerHTML = '<p class="help-text">Загрузка…</p>';
        setSelectorHealthStatus('обновляем…');
        chrome.runtime.sendMessage(
            { type: 'REQUEST_SELECTOR_HEALTH_SUMMARY', includeActiveVersions },
            (response) => {
                if (chrome.runtime.lastError) {
                    selectorHealthSnapshot = null;
                    selectorHealthSummary.innerHTML = `<span class="help-text">Ошибка: ${chrome.runtime.lastError.message}</span>`;
                    selectorHealthTable.innerHTML = '<p class="help-text">Не удалось загрузить данные</p>';
                    setSelectorHealthStatus('ошибка');
                    return;
                }
                if (response?.status === 'ok') {
                    selectorHealthSnapshot = response.summary && typeof response.summary === 'object' ? response.summary : null;
                    renderSelectorHealth(response.summary || {});
                } else {
                    selectorHealthSnapshot = null;
                    selectorHealthSummary.innerHTML = '<span class="help-text">Не удалось получить данные</span>';
                    selectorHealthTable.innerHTML = '<p class="help-text">Нет данных</p>';
                    setSelectorHealthStatus('нет данных');
                }
            }
        );
    };

    const sanitizeSelectorHealthField = (value) => String(value || '').replace(/\s+/g, ' ').trim();

    const buildSelectorHealthText = (summary) => {
        if (!summary || !Array.isArray(summary.rows) || !summary.rows.length) return '';
        const lines = [];
        const updatedAt = formatSelectorHealthTime(summary.updatedAt);
        lines.push('Selector Health');
        lines.push(`Updated: ${updatedAt}`);
        lines.push(`Samples: ${Number(summary.totalSamples || 0)}`);
        lines.push('');
        lines.push(['Model', 'Element', 'Samples', 'L1', 'L2', 'L3', 'L4', 'fail', 'error', 'Last override', 'Last check', 'Active UI'].join('\t'));
        summary.rows.forEach((row) => {
            const total = Number(row?.counts?.total || 0);
            const pct = (value) => formatSelectorHealthPct(value, total);
            const lastOverrideRaw = row?.lastOverride
                ? `${formatSelectorHealthTime(row.lastOverride.ts)} ${row.lastOverride.reason || row.lastOverride.selector || ''}`.trim()
                : '—';
            const lastCheckRaw = row?.lastHealthCheck
                ? `${row.lastHealthCheck.success ? 'OK' : 'FAIL'} ${row.lastHealthCheck.layer || ''} ${row.lastHealthCheck.error || ''}`.trim()
                : '—';
            const activeUiRaw = row?.activeUiVersion
                ? `${row.activeUiVersion}${row.activeTabId ? ` #${row.activeTabId}` : ''}`
                : '—';
            lines.push([
                sanitizeSelectorHealthField(row.modelName),
                sanitizeSelectorHealthField(row.elementType),
                total,
                pct(row?.counts?.L1 || 0),
                pct(row?.counts?.L2 || 0),
                pct(row?.counts?.L3 || 0),
                pct(row?.counts?.L4 || 0),
                pct(row?.counts?.fail || 0),
                pct(row?.counts?.error || 0),
                sanitizeSelectorHealthField(lastOverrideRaw),
                sanitizeSelectorHealthField(lastCheckRaw),
                sanitizeSelectorHealthField(activeUiRaw)
            ].join('\t'));
        });
        return lines.join('\n');
    };

    const buildSelectorHealthExport = (summary) => ({
        generatedAt: Date.now(),
        updatedAt: summary?.updatedAt || null,
        totalSamples: Number(summary?.totalSamples || 0),
        rows: Array.isArray(summary?.rows) ? summary.rows : []
    });

    const copySelectorHealth = async () => {
        if (!selectorHealthCopyBtn) return;
        const text = buildSelectorHealthText(selectorHealthSnapshot);
        if (!text) {
            updateDevToolsStatus('Нет данных для копирования', 'warning');
            flashButtonFeedback(selectorHealthCopyBtn, 'warn');
            return;
        }
        try {
            await writeRichContentToClipboard({ text });
            updateDevToolsStatus('Selector Health скопирован', 'success');
            flashButtonFeedback(selectorHealthCopyBtn, 'success');
        } catch (err) {
            console.warn('[results] selector health copy failed', err);
            updateDevToolsStatus('Clipboard copy failed', 'error');
            flashButtonFeedback(selectorHealthCopyBtn, 'error');
        }
    };

    const exportSelectorHealth = () => {
        if (!selectorHealthExportBtn) return;
        const payload = buildSelectorHealthExport(selectorHealthSnapshot);
        if (!payload.rows.length) {
            updateDevToolsStatus('Нет данных для экспорта', 'warning');
            flashButtonFeedback(selectorHealthExportBtn, 'warn');
            return;
        }
        try {
            const json = JSON.stringify(payload, null, 2);
            if (!json) return;
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `selector-health-${Date.now()}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            updateDevToolsStatus('Selector Health экспортирован', 'success');
            flashButtonFeedback(selectorHealthExportBtn, 'success');
        } catch (err) {
            console.warn('[results] selector health export failed', err);
            updateDevToolsStatus('Экспорт не удался', 'error');
            flashButtonFeedback(selectorHealthExportBtn, 'error');
        }
    };

    if (selectorHealthRefreshBtn) {
        selectorHealthRefreshBtn.addEventListener('click', () => requestSelectorHealthSummary(true));
    }
    if (selectorHealthCopyBtn) {
        selectorHealthCopyBtn.addEventListener('click', () => copySelectorHealth());
    }
    if (selectorHealthExportBtn) {
        selectorHealthExportBtn.addEventListener('click', () => exportSelectorHealth());
    }
    if (selectorHealthSummary && selectorHealthTable) {
        requestSelectorHealthSummary(true);
    }

    const renderTelemetryTable = (metrics = {}) => {
        if (!telemetryTable) return;
        const tbody = telemetryTable.querySelector('tbody');
        if (!tbody) return;
        const rows = Object.entries(metrics).map(([key, count]) => {
            const [modelName = 'unknown', elementType = '-', layer = '-'] = key.split('_');
            return { modelName, elementType, layer, count };
        }).sort((a, b) => b.count - a.count).slice(0, 20);
        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="4">Нет данных</td></tr>';
            return;
        }
        tbody.innerHTML = rows.map(({ modelName, elementType, layer, count }) => `
            <tr>
                <td>${modelName}</td>
                <td>${elementType}</td>
                <td>${layer}</td>
                <td>${count}</td>
            </tr>
        `).join('');
    };

    const requestSelectorTelemetry = () => {
        if (!telemetryTable) return;
        const tbody = telemetryTable.querySelector('tbody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="4">Загрузка…</td></tr>';
        }
        chrome.runtime.sendMessage({ type: 'REQUEST_SELECTOR_TELEMETRY' }, (response) => {
            if (chrome.runtime.lastError) {
                if (tbody) {
                    tbody.innerHTML = `<tr><td colspan="4">Ошибка: ${chrome.runtime.lastError.message}</td></tr>`;
                }
                return;
            }
            if (response?.status === 'ok') {
                renderTelemetryTable(response.metrics || {});
            } else if (tbody) {
                tbody.innerHTML = '<tr><td colspan="4">Нет данных</td></tr>';
            }
        });
    };

    if (telemetryRefreshBtn) {
        telemetryRefreshBtn.addEventListener('click', () => requestSelectorTelemetry());
    }
    if (telemetryTable) {
        requestSelectorTelemetry();
    }

    const renderSelectorDefinitions = (modelName, payload) => {
        if (!liveSelectorList) return;
        if (!payload?.versions?.length) {
            liveSelectorList.innerHTML = `<p class="help-text">Нет зарегистрированных версий для модели ${modelName}</p>`;
            return;
        }
        liveSelectorList.innerHTML = '';
        payload.versions.forEach((version) => {
            const block = document.createElement('div');
            block.className = 'live-version-block';
            const title = document.createElement('h3');
            title.innerHTML = `<span>${version.version || 'unknown'}</span><span>${version.uiRevision || ''}</span>`;
            block.appendChild(title);

            SELECTOR_ELEMENT_TYPES.forEach((elementType) => {
                const selectors = version.selectors?.[elementType] || [];
                const row = document.createElement('div');
                row.className = 'live-selector-row';
                const label = document.createElement('strong');
                label.textContent = elementType;
                row.appendChild(label);
                if (selectors.length) {
                    const chips = document.createElement('div');
                    chips.className = 'selector-chip';
                    selectors.forEach((selector) => {
                        const code = document.createElement('code');
                        code.textContent = selector;
                        chips.appendChild(code);
                    });
                    row.appendChild(chips);
                } else {
                    const empty = document.createElement('span');
                    empty.className = 'help-text';
                    empty.textContent = 'Нет селекторов';
                    row.appendChild(empty);
                }
                block.appendChild(row);
            });

            liveSelectorList.appendChild(block);
        });
    };

    const requestSelectorDefinitions = (modelName) => {
        if (!modelName || !liveSelectorList) return;
        liveSelectorList.innerHTML = '<p class="help-text">Загрузка селекторов…</p>';
        chrome.runtime.sendMessage({ type: 'REQUEST_SELECTOR_DEFINITIONS', modelName }, (response) => {
            if (chrome.runtime.lastError) {
                liveSelectorList.innerHTML = `<p class="help-text">Ошибка: ${chrome.runtime.lastError.message}</p>`;
                return;
            }
            if (response?.status === 'ok') {
                renderSelectorDefinitions(modelName, response);
            } else {
                liveSelectorList.innerHTML = `<p class="help-text">Не удалось получить селекторы (${response?.error || 'unknown'})</p>`;
            }
        });
    };

    const setSelectorValidationStatus = (text, tone = '') => {
        if (!selectorValidationStatus) return;
        selectorValidationStatus.textContent = text || '';
        selectorValidationStatus.classList.remove('is-success', 'is-warning', 'is-error');
        if (tone) selectorValidationStatus.classList.add(`is-${tone}`);
    };

    const renderActiveSelectors = () => {
        if (!selectorActiveSelectors) return;
        const modelName = getSelectedModelName();
        if (!modelName) {
            selectorActiveSelectors.innerHTML = '<div class="selectors0-empty">Выберите модель в Workbench.</div>';
            return;
        }
        if (!activeSelectorSnapshot || activeSelectorSnapshotModel !== modelName) {
            selectorActiveSelectors.innerHTML = '<div class="selectors0-empty">Нет данных по выбранной модели.</div>';
            return;
        }
        const selectorsByType = activeSelectorSnapshot?.selectors || {};
        const order = SELECTOR_WORKBENCH_FIELDS.map((field) => field.key);
        const groups = buildSelectorGroups(selectorsByType, order);
        renderSelectorGroups(selectorActiveSelectors, groups, 'Нет активных селекторов для выбранной модели.');
    };

    const refreshActiveSelectorSnapshot = () => {
        const modelName = getSelectedModelName();
        activeSelectorSnapshot = null;
        activeSelectorSnapshotModel = '';
        activeSelectorValidationMap = new Map();
        renderActiveSelectors();
        if (selectorDetectedVersion) selectorDetectedVersion.textContent = '—';
        if (selectorActiveTabStatus) selectorActiveTabStatus.textContent = modelName ? 'Проверяем…' : 'Нет модели';
        if (!modelName) return;
        chrome.runtime.sendMessage({ type: 'REQUEST_SELECTOR_ACTIVE_VERSION', modelName }, (response) => {
            if (chrome.runtime.lastError) {
                if (selectorActiveTabStatus) selectorActiveTabStatus.textContent = `Ошибка: ${chrome.runtime.lastError.message}`;
                return;
            }
            if (response?.status === 'ok') {
                activeSelectorSnapshot = response;
                activeSelectorSnapshotModel = modelName;
                if (selectorDetectedVersion) selectorDetectedVersion.textContent = response.version || 'unknown';
                if (selectorActiveTabStatus) {
                    selectorActiveTabStatus.textContent = response.tabId ? `Активна (#${response.tabId})` : 'Активна';
                }
                renderActiveSelectors();
                refreshSelectorCandidates();
            } else {
                if (selectorDetectedVersion) selectorDetectedVersion.textContent = 'unknown';
                if (selectorActiveTabStatus) {
                    selectorActiveTabStatus.textContent = response?.status === 'no_tab'
                        ? 'Нет активной вкладки'
                        : (response?.error || 'Нет данных');
                }
            }
        });
    };

    const refreshSelectorAudit = (modelName = getSelectedModelName()) => {
        if (!selectorAuditList) return;
        if (!modelName) {
            selectorAuditList.innerHTML = '<p class="help-text">Выберите модель в Workbench</p>';
            return;
        }
        selectorAuditList.innerHTML = '<p class="help-text">Загрузка истории…</p>';
        chrome.runtime.sendMessage({ type: 'REQUEST_SELECTOR_OVERRIDE_AUDIT', limit: 60 }, (response) => {
            if (chrome.runtime.lastError) {
                selectorAuditList.innerHTML = `<p class="help-text">Ошибка: ${chrome.runtime.lastError.message}</p>`;
                return;
            }
            if (response?.status !== 'ok') {
                selectorAuditList.innerHTML = `<p class="help-text">Ошибка: ${escapeHtml(response?.error || 'Не удалось загрузить историю')}</p>`;
                return;
            }
            const entries = Array.isArray(response?.entries) ? response.entries : [];
            const normalizedModel = normalizeModelName(modelName);
            const filteredEntries = entries.filter((entry) => normalizeModelName(entry?.modelName) === normalizedModel);
            if (!filteredEntries.length) {
                selectorAuditList.innerHTML = '<p class="help-text">История изменений пока пуста</p>';
                return;
            }
            selectorAuditList.innerHTML = filteredEntries.map((entry) => {
                const time = entry.ts ? new Date(entry.ts).toLocaleString() : '';
                const selector = escapeHtml(entry.selector || '');
                const reason = escapeHtml(entry.reason || '');
                const model = escapeHtml(entry.modelName || 'unknown');
                const elementType = escapeHtml(entry.elementType || 'unknown');
                const version = escapeHtml(entry.extVersion || '');
                return `
                    <div class="selector-audit-row">
                        <span><strong>${model}</strong> · ${elementType}</span>
                        <span>${selector}</span>
                        <span class="selector-audit-meta">${time}${version ? ` · v${version}` : ''}</span>
                        ${reason ? `<span class="selector-audit-meta">Причина: ${reason}</span>` : ''}
                    </div>
                `;
            }).join('');
        });
    };

    const refreshSavedOverridesList = () => {
        if (!selectorsSavedOverridesList) return;
        const modelName = getSelectedModelName();
        if (!modelName) {
            selectorsSavedOverridesList.innerHTML = '<div class="selectors0-empty">Выберите модель в Workbench.</div>';
            return;
        }
        selectorsSavedOverridesList.innerHTML = '<div class="selectors0-empty">Загрузка overrides…</div>';
        chrome.storage.local.get('selectors_remote_override', (res) => {
            if (chrome.runtime?.lastError) {
                selectorsSavedOverridesList.innerHTML = `<div class="selectors0-empty">Ошибка: ${chrome.runtime.lastError.message}</div>`;
                return;
            }
            const payload = res?.selectors_remote_override || {};
            const manualOverrides = payload.manualOverrides || {};
            const modelOverrides = manualOverrides?.[modelName] || {};
            const order = SELECTOR_WORKBENCH_FIELDS.map((field) => field.key);
            const groups = buildSelectorGroups(modelOverrides, order);
            renderSelectorGroups(selectorsSavedOverridesList, groups, 'Нет сохранённых overrides для выбранной модели.');
        });
    };

    const pickCandidatesVersion = (versions, activeVersion) => {
        if (!Array.isArray(versions) || !versions.length) return null;
        if (activeVersion) {
            const match = versions.find((version) => version.version === activeVersion);
            if (match) return match;
        }
        return versions[versions.length - 1];
    };

    const refreshSelectorCandidates = () => {
        if (!selectorsCandidatesList) return;
        const modelName = getSelectedModelName();
        if (!modelName) {
            selectorsCandidatesList.innerHTML = '<div class="selectors0-empty">Выберите модель в Workbench.</div>';
            return;
        }
        selectorsCandidatesList.innerHTML = '<div class="selectors0-empty">Загрузка кандидатов…</div>';
        chrome.runtime.sendMessage({ type: 'REQUEST_SELECTOR_DEFINITIONS', modelName }, (response) => {
            if (chrome.runtime.lastError) {
                selectorsCandidatesList.innerHTML = `<div class="selectors0-empty">Ошибка: ${chrome.runtime.lastError.message}</div>`;
                return;
            }
            if (response?.status !== 'ok') {
                selectorsCandidatesList.innerHTML = `<div class="selectors0-empty">${escapeHtml(response?.error || 'Не удалось загрузить кандидатов')}</div>`;
                return;
            }
            const version = pickCandidatesVersion(response.versions || [], activeSelectorSnapshot?.version || '');
            if (!version) {
                selectorsCandidatesList.innerHTML = '<div class="selectors0-empty">Нет кандидатов для выбранной модели.</div>';
                return;
            }
            const order = SELECTOR_WORKBENCH_FIELDS.map((field) => field.key);
            const groups = buildSelectorGroups(version.selectors || {}, order);
            const headerHtml = `<div class="selectors0-muted">Версия: ${escapeHtml(version.version || 'unknown')}</div>`;
            renderSelectorGroups(selectorsCandidatesList, groups, 'Нет кандидатов для выбранной модели.', headerHtml);
        });
    };

    const refreshSelectorsSidePanels = (modelName = getSelectedModelName()) => {
        if (!modelName) {
            renderActiveSelectors();
            refreshSavedOverridesList();
            refreshSelectorAudit();
            refreshSelectorCandidates();
            return;
        }
        refreshActiveSelectorSnapshot();
        refreshSavedOverridesList();
        refreshSelectorAudit(modelName);
        refreshSelectorCandidates();
    };

    const validateSelectorsOnModel = (modelName, selectors, onDone) => {
        if (!modelName) return;
        const list = Array.isArray(selectors) ? selectors.filter(Boolean) : [];
        if (!list.length) return;
        chrome.runtime.sendMessage({ type: 'VALIDATE_SELECTORS', modelName, selectors: list }, (response) => {
            if (chrome.runtime.lastError) {
                onDone && onDone({ status: 'error', error: chrome.runtime.lastError.message });
                return;
            }
            onDone && onDone(response);
        });
    };

    const showSelectorsWorkbenchStatus = (message) => {
        if (!selectorsWorkbenchStatus) return;
        selectorsWorkbenchStatus.textContent = message || '';
        if (selectorsWorkbenchState.statusTimer) clearTimeout(selectorsWorkbenchState.statusTimer);
        if (message) {
            selectorsWorkbenchState.statusTimer = setTimeout(() => {
                if (selectorsWorkbenchStatus) selectorsWorkbenchStatus.textContent = '';
            }, 2500);
        }
    };

    const flattenSelectors = (value) => {
        if (!value) return [];
        if (Array.isArray(value)) {
            return value.flatMap((entry) => flattenSelectors(entry));
        }
        if (typeof value === 'string') return [value];
        return [];
    };

    const normalizeModelName = (value) => String(value || '').trim().toLowerCase();

    const getSelectedModelName = () =>
        selectorsWorkbenchModelSelect?.value || liveSelectorModelSelect?.value || '';

    const buildSelectorGroups = (selectorsByType, orderedKeys = []) => {
        const groups = [];
        const seen = new Set();
        orderedKeys.forEach((key) => {
            const selectors = flattenSelectors(selectorsByType?.[key]);
            if (!selectors.length) return;
            groups.push({ label: key, selectors });
            seen.add(key);
        });
        Object.keys(selectorsByType || {}).forEach((key) => {
            if (seen.has(key)) return;
            const selectors = flattenSelectors(selectorsByType?.[key]);
            if (!selectors.length) return;
            groups.push({ label: key, selectors });
        });
        return groups;
    };

    const renderSelectorGroups = (container, groups, emptyText, headerHtml = '') => {
        if (!container) return;
        if (!groups.length) {
            container.innerHTML = `${headerHtml}<div class="selectors0-empty">${emptyText}</div>`;
            return;
        }
        const rows = groups.map(({ label, selectors }) => {
            const chips = selectors.map((selector) => `<code>${escapeHtml(selector)}</code>`).join('');
            return `
                <div class="selectors0-side-row">
                    <span class="selectors0-side-label">${escapeHtml(label)}</span>
                    <div class="selectors0-side-chips">${chips}</div>
                </div>
            `;
        }).join('');
        container.innerHTML = `${headerHtml}${rows}`;
    };

    const updateWorkbenchSelectorStatus = (entry, status) => {
        if (!entry?.statusEl) return;
        entry.status = status;
        entry.statusEl.classList.remove('selectors-status--ok', 'selectors-status--bad', 'selectors-status--idle');
        if (status === 'ok') {
            entry.statusEl.textContent = '🟢';
            entry.statusEl.classList.add('selectors-status--ok');
            return;
        }
        if (status === 'bad') {
            entry.statusEl.textContent = '🔴';
            entry.statusEl.classList.add('selectors-status--bad');
            return;
        }
        entry.statusEl.textContent = '⚪';
        entry.statusEl.classList.add('selectors-status--idle');
    };

    const syncWorkbenchSaveState = (entry) => {
        if (!entry?.saveBtn) return;
        entry.saveBtn.disabled = !entry.dirty;
    };

    const updateWorkbenchSelectorInput = (entry, rawValue) => {
        const value = String(rawValue || '').trim();
        entry.value = value;
        if (entry.inputEl) {
            entry.inputEl.value = value;
            entry.inputEl.title = value;
        }
        entry.dirty = value !== entry.savedValue;
        updateWorkbenchSelectorStatus(entry, 'idle');
        syncWorkbenchSaveState(entry);
    };

    const testWorkbenchSelectorEntry = (entry) => {
        if (!entry) return;
        const selector = String(entry.value || '').trim();
        if (!selector) {
            updateWorkbenchSelectorStatus(entry, 'idle');
            showSelectorsWorkbenchStatus('Selector is empty');
            return;
        }
        const modelName = selectorsWorkbenchModelSelect?.value || '';
        if (!modelName) {
            showSelectorsWorkbenchStatus('Select model to test');
            return;
        }
        validateSelectorsOnModel(modelName, [selector], (response) => {
            if (response?.status === 'no_tab') {
                updateWorkbenchSelectorStatus(entry, 'idle');
                showSelectorsWorkbenchStatus('No active tab for проверки');
                return;
            }
            if (response?.status !== 'ok') {
                updateWorkbenchSelectorStatus(entry, 'bad');
                showSelectorsWorkbenchStatus(response?.error || 'Validation failed');
                return;
            }
            const result = response.results?.[0];
            if (result?.error) {
                updateWorkbenchSelectorStatus(entry, 'bad');
                showSelectorsWorkbenchStatus(result.error || 'Invalid selector');
                return;
            }
            const matches = Number(result?.matches || 0);
            updateWorkbenchSelectorStatus(entry, matches > 0 ? 'ok' : 'bad');
            showSelectorsWorkbenchStatus(matches > 0 ? 'Selector OK' : 'No matches');
            if (matches > 0) {
                chrome.runtime.sendMessage({
                    type: 'HIGHLIGHT_SELECTOR_TEMP',
                    modelName,
                    selector,
                    durationMs: 5000,
                    color: '#2ecc71'
                }, () => {});
            }
        });
    };

    const buildWorkbenchRow = (field) => {
        const row = document.createElement('div');
        row.className = 'selectors-row selectors0-workbench-row';
        row.dataset.key = field.key;
        row.innerHTML = `
            <div class="selectors-row-header">
                <div class="selectors-row-title">
                    <span class="selectors-status selectors-status--idle">⚪</span>
                    <span class="selectors-label">${escapeHtml(field.label)}</span>
                </div>
                <div class="selectors-actions">
                    <button class="selectors-btn selectors-btn-pick" type="button" data-action="pick" aria-label="Pick">🎯</button>
                    <button class="selectors-btn selectors-btn-record" type="button" data-action="record" aria-label="Record">⬤</button>
                    <button class="selectors-btn selectors-btn-test" type="button" data-action="test">Test</button>
                    <button class="selectors-btn selectors-btn-save" type="button" data-action="save">Save</button>
                    <button class="selectors-btn selectors-btn-clear" type="button" data-action="clear" aria-label="Clear selector">🗑️</button>
                </div>
            </div>
            <input class="selectors-input selectors0-input" type="text" placeholder="CSS selector" />
        `;
        return row;
    };

    const sendRuntimeMessage = (payload) =>
        new Promise((resolve) => {
            if (!chrome?.runtime?.sendMessage) {
                resolve({ status: 'error', error: 'runtime unavailable' });
                return;
            }
            chrome.runtime.sendMessage(payload, (response) => {
                if (chrome.runtime?.lastError) {
                    resolve({ status: 'error', error: chrome.runtime.lastError.message });
                    return;
                }
                resolve(response || { status: 'error', error: 'no response' });
            });
        });

    const resolveWorkbenchDefaults = (selectorsByType) => {
        const defaults = {};
        SELECTOR_WORKBENCH_FIELDS.forEach((field) => {
            const list = flattenSelectors(selectorsByType?.[field.key]);
            defaults[field.key] = list.find((entry) => typeof entry === 'string' && entry.trim()) || '';
        });
        return defaults;
    };

    const buildWorkbenchEntries = (defaults) => {
        if (!selectorsWorkbenchList) return;
        selectorsWorkbenchList.innerHTML = '';
        selectorsWorkbenchState.entries.clear();
        SELECTOR_WORKBENCH_FIELDS.forEach((field) => {
            const row = buildWorkbenchRow(field);
            selectorsWorkbenchList.appendChild(row);
            const entry = {
                key: field.key,
                value: '',
                savedValue: '',
                dirty: false,
                status: 'idle',
                row,
                statusEl: row.querySelector('.selectors-status'),
                inputEl: row.querySelector('.selectors-input'),
                pickBtn: row.querySelector('[data-action="pick"]'),
                recordBtn: row.querySelector('[data-action="record"]'),
                testBtn: row.querySelector('[data-action="test"]'),
                saveBtn: row.querySelector('[data-action="save"]'),
                clearBtn: row.querySelector('[data-action="clear"]')
            };
            const initialValue = defaults?.[field.key] || '';
            entry.savedValue = String(initialValue || '').trim();
            updateWorkbenchSelectorInput(entry, entry.savedValue);
            entry.dirty = false;
            syncWorkbenchSaveState(entry);
            updateWorkbenchSelectorStatus(entry, entry.savedValue ? 'idle' : 'idle');
            entry.inputEl?.addEventListener('input', (event) => {
                updateWorkbenchSelectorInput(entry, event.target?.value || '');
            });
            entry.pickBtn?.addEventListener('click', () => startWorkbenchPicker(entry, { mode: 'workbench-pick' }));
            entry.recordBtn?.addEventListener('click', () => {
                if (activePickerRequestId && activePickerMode !== 'workbench-record') {
                    showSelectorsWorkbenchStatus('Picker already active');
                    return;
                }
                startWorkbenchRecord(entry);
            });
            entry.testBtn?.addEventListener('click', () => testWorkbenchSelectorEntry(entry));
            entry.saveBtn?.addEventListener('click', () => saveWorkbenchSelectorEntry(entry));
            entry.clearBtn?.addEventListener('click', () => {
                updateWorkbenchSelectorInput(entry, '');
                updateWorkbenchSelectorStatus(entry, 'idle');
                showSelectorsWorkbenchStatus('Cleared');
            });
            selectorsWorkbenchState.entries.set(entry.key, entry);
        });
    };

    const requestWorkbenchDefaults = async (modelName) => {
        if (!modelName) return {};
        const activeResponse = await sendRuntimeMessage({ type: 'REQUEST_SELECTOR_ACTIVE_VERSION', modelName });
        if (activeResponse?.status === 'ok') {
            return resolveWorkbenchDefaults(activeResponse.selectors || {});
        }
        const defsResponse = await sendRuntimeMessage({ type: 'REQUEST_SELECTOR_DEFINITIONS', modelName });
        if (defsResponse?.status === 'ok' && defsResponse.versions?.length) {
            const firstVersion = defsResponse.versions[0];
            return resolveWorkbenchDefaults(firstVersion.selectors || {});
        }
        return resolveWorkbenchDefaults({});
    };

    const refreshWorkbenchSelectors = async (modelName) => {
        if (!selectorsWorkbenchList) return;
        selectorsWorkbenchState.modelName = modelName;
        selectorsWorkbenchList.innerHTML = '<p class="help-text">Loading selectors…</p>';
        const defaults = await requestWorkbenchDefaults(modelName);
        buildWorkbenchEntries(defaults);
        refreshSelectorsSidePanels(modelName);
    };

    const saveWorkbenchSelectorEntry = async (entry) => {
        if (!entry) return;
        const selector = String(entry.value || '').trim();
        if (!selector) {
            showSelectorsWorkbenchStatus('Selector is empty');
            return;
        }
        const modelName = selectorsWorkbenchModelSelect?.value || '';
        if (!modelName) {
            showSelectorsWorkbenchStatus('Select model to save');
            return;
        }
        showSelectorsWorkbenchStatus('Saving selector…');
        const response = await sendRuntimeMessage({
            type: 'SAVE_SELECTOR_OVERRIDE',
            modelName,
            elementType: entry.key,
            selector,
            reason: 'selectors workbench'
        });
        if (response?.status !== 'ok') {
            showSelectorsWorkbenchStatus(response?.error || 'Save failed');
            return;
        }
        entry.savedValue = selector;
        entry.dirty = false;
        syncWorkbenchSaveState(entry);
        showSelectorsWorkbenchStatus('Saved');
        refreshSelectorAudit(modelName);
        refreshSavedOverridesList();
    };

    const saveAllWorkbenchSelectors = async () => {
        const entries = Array.from(selectorsWorkbenchState.entries.values()).filter((entry) => entry.dirty);
        if (!entries.length) {
            showSelectorsWorkbenchStatus('No changes to save');
            return;
        }
        for (const entry of entries) {
            // eslint-disable-next-line no-await-in-loop
            await saveWorkbenchSelectorEntry(entry);
        }
    };

    const formatSelectorsFilename = (modelName = 'selectors') => {
        const date = new Date();
        const pad = (num) => String(num).padStart(2, '0');
        return `${modelName}-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`;
    };

    const buildSelectorsExportPayload = () => {
        const selectors = {};
        selectorsWorkbenchState.entries.forEach((entry, key) => {
            selectors[key] = entry?.value ? entry.value : null;
        });
        return {
            modelName: selectorsWorkbenchModelSelect?.value || '',
            version: chrome.runtime?.getManifest?.().version || '',
            exported: new Date().toISOString(),
            selectors
        };
    };

    const exportSelectorsJson = () => {
        const payload = buildSelectorsExportPayload();
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = formatSelectorsFilename(payload.modelName || 'selectors');
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        showSelectorsWorkbenchStatus('Exported');
    };

    const applySelectorsImport = (payload) => {
        if (!payload || typeof payload !== 'object') {
            showSelectorsWorkbenchStatus('Invalid file');
            return;
        }
        const payloadModel = String(payload.modelName || '');
        const currentModel = String(selectorsWorkbenchModelSelect?.value || '');
        if (payloadModel && currentModel && payloadModel !== currentModel) {
            const proceed = confirm(`File is for ${payloadModel}, you are on ${currentModel}. Apply anyway?`);
            if (!proceed) return;
        }
        const imported = payload.selectors || {};
        selectorsWorkbenchState.entries.forEach((entry, key) => {
            if (Object.prototype.hasOwnProperty.call(imported, key)) {
                updateWorkbenchSelectorInput(entry, imported[key] || '');
                testWorkbenchSelectorEntry(entry);
            }
        });
        showSelectorsWorkbenchStatus('Imported');
    };

    const handleSelectorsImportFile = (file) => {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const parsed = JSON.parse(String(reader.result || ''));
                applySelectorsImport(parsed);
            } catch (_) {
                showSelectorsWorkbenchStatus('Invalid JSON');
            }
        };
        reader.readAsText(file);
    };

    const cancelActivePicker = (modelName, requestId) => {
        if (!requestId) return;
        chrome.runtime.sendMessage({ type: 'PICKER_CANCEL', modelName, requestId }, () => {});
    };

    const startWorkbenchPicker = (entry, { mode, timeoutMs, startLabel, timeoutLabel } = {}) => {
        if (!entry) return;
        const modelName = selectorsWorkbenchModelSelect?.value || '';
        if (!modelName) {
            showSelectorsWorkbenchStatus('Select model to pick');
            return;
        }
        if (activePickerRequestId) {
            showSelectorsWorkbenchStatus('Picker already active');
            return;
        }
        activePickerMode = mode || 'workbench-pick';
        entry.pickBtn.disabled = true;
        if (entry.recordBtn) entry.recordBtn.disabled = true;
        showSelectorsWorkbenchStatus(startLabel || 'Pick an element on model tab');
        chrome.runtime.sendMessage(
            { type: 'PICK_SELECTOR_START', modelName, elementType: entry.key, mode: mode === 'workbench-record' ? 'record' : 'selector' },
            (response) => {
            if (chrome.runtime.lastError) {
                entry.pickBtn.disabled = false;
                if (entry.recordBtn) entry.recordBtn.disabled = false;
                if (mode === 'workbench-record' && entry.recordBtn) {
                    entry.recordBtn.classList.remove('is-active');
                }
                showSelectorsWorkbenchStatus(`Pick failed: ${chrome.runtime.lastError.message}`);
                activePickerMode = null;
                return;
            }
            if (!response || response.status !== 'ok' || !response.requestId) {
                entry.pickBtn.disabled = false;
                if (entry.recordBtn) entry.recordBtn.disabled = false;
                if (mode === 'workbench-record' && entry.recordBtn) {
                    entry.recordBtn.classList.remove('is-active');
                }
                showSelectorsWorkbenchStatus(response?.error || 'Pick failed');
                activePickerMode = null;
                return;
            }
            activePickerRequestId = response.requestId;
            activePickerEntry = entry;
            if (pickerTimeoutId) clearTimeout(pickerTimeoutId);
            pickerTimeoutId = setTimeout(() => {
                if (activePickerRequestId !== response.requestId) return;
                activePickerRequestId = null;
                activePickerEntry = null;
                activePickerMode = null;
                entry.pickBtn.disabled = false;
                if (entry.recordBtn) entry.recordBtn.disabled = false;
                if (mode === 'workbench-record' && entry.recordBtn) {
                    entry.recordBtn.classList.remove('is-active');
                }
                cancelActivePicker(modelName, response.requestId);
                showSelectorsWorkbenchStatus(timeoutLabel || 'Pick timeout');
            }, timeoutMs || 60000);
        });
    };

    const startWorkbenchRecord = (entry) => {
        if (!entry) return;
        if (entry.recordBtn?.classList.contains('is-active')) {
            entry.recordBtn.classList.remove('is-active');
            if (activePickerRequestId) {
                const modelName = selectorsWorkbenchModelSelect?.value || '';
                const requestId = activePickerRequestId;
                activePickerRequestId = null;
                activePickerEntry = null;
                activePickerMode = null;
                if (pickerTimeoutId) {
                    clearTimeout(pickerTimeoutId);
                    pickerTimeoutId = null;
                }
                entry.pickBtn.disabled = false;
                entry.recordBtn.disabled = false;
                cancelActivePicker(modelName, requestId);
            }
            showSelectorsWorkbenchStatus('Record cancelled');
            return;
        }
        entry.recordBtn?.classList.add('is-active');
        startWorkbenchPicker(entry, {
            mode: 'workbench-record',
            timeoutMs: 15000,
            startLabel: 'Recording… click target',
            timeoutLabel: 'Record timeout'
        });
    };

    const populateSelectorModels = () => {
        if (!liveSelectorModelSelect) return;
        chrome.runtime.sendMessage({ type: 'REQUEST_SELECTOR_MODELS' }, (response) => {
            if (chrome.runtime.lastError) {
                liveSelectorList.innerHTML = `<p class="help-text">Ошибка загрузки моделей: ${chrome.runtime.lastError.message}</p>`;
                return;
            }
            const models = response?.models || [];
            liveSelectorModelSelect.innerHTML = '<option value="">Выберите модель</option>';
            models.forEach((modelName) => {
                const option = document.createElement('option');
                option.value = modelName;
                option.textContent = modelName;
                liveSelectorModelSelect.appendChild(option);
            });
            if (models.length) {
                liveSelectorModelSelect.value = models[0];
                requestSelectorDefinitions(models[0]);
                refreshActiveSelectorSnapshot();
                refreshSelectorAudit(models[0]);
            }
        });
    };

    const populateWorkbenchModels = () => {
        if (!selectorsWorkbenchModelSelect) return;
        chrome.runtime.sendMessage({ type: 'REQUEST_SELECTOR_MODELS' }, (response) => {
            if (chrome.runtime.lastError) {
                showSelectorsWorkbenchStatus(`Model load failed: ${chrome.runtime.lastError.message}`);
                return;
            }
            const models = response?.models || [];
            selectorsWorkbenchModelSelect.innerHTML = '<option value="">Choose model</option>';
            models.forEach((modelName) => {
                const option = document.createElement('option');
                option.value = modelName;
                option.textContent = modelName;
                selectorsWorkbenchModelSelect.appendChild(option);
            });
            if (models.length) {
                selectorsWorkbenchModelSelect.value = models[0];
                refreshWorkbenchSelectors(models[0]);
                refreshSelectorAudit(models[0]);
            } else {
                refreshWorkbenchSelectors('');
            }
        });
    };

    if (liveSelectorModelSelect) {
        liveSelectorModelSelect.addEventListener('change', (event) => {
            requestSelectorDefinitions(event.target.value);
            refreshActiveSelectorSnapshot();
            refreshSelectorAudit(event.target.value);
            refreshSavedOverridesList();
            refreshSelectorCandidates();
        });
        populateSelectorModels();
    }
    if (liveSelectorElementSelect) {
        liveSelectorElementSelect.addEventListener('change', () => {
            activeSelectorValidationMap = new Map();
            renderActiveSelectors();
        });
    }
    if (selectorsWorkbenchModelSelect) {
        selectorsWorkbenchModelSelect.addEventListener('change', (event) => {
            refreshWorkbenchSelectors(event.target.value);
            refreshSelectorsSidePanels(event.target.value);
        });
        populateWorkbenchModels();
    }
    if (selectorsWorkbenchHeaderButtons && selectorsWorkbenchHeaderButtons.length) {
        selectorsWorkbenchHeaderButtons.forEach((button) => {
            button.addEventListener('click', () => {
                const action = button.dataset.selectorsAction;
                if (action === 'export') exportSelectorsJson();
                if (action === 'import') selectorsWorkbenchFileInput?.click();
                if (action === 'save-all') saveAllWorkbenchSelectors();
            });
        });
    }
    if (selectorsWorkbenchFileInput) {
        selectorsWorkbenchFileInput.addEventListener('change', (event) => {
            const file = event.target.files?.[0];
            if (file) handleSelectorsImportFile(file);
            selectorsWorkbenchFileInput.value = '';
        });
    }

    if (modifiersSection && toggleModifiersBtn && modifiersContainer) {
        let modifiersOpen = modifiersSection.classList.contains('is-open');

        const applyModifiersState = () => {
            modifiersSection.classList.toggle('is-open', modifiersOpen);
            toggleModifiersBtn.setAttribute('aria-expanded', String(modifiersOpen));
            const controlLabel = modifiersOpen ? 'Hide modifiers' : 'Show modifiers';
            toggleModifiersBtn.setAttribute('aria-label', controlLabel);
            toggleModifiersBtn.setAttribute('title', controlLabel);
            modifiersContainer.setAttribute('aria-hidden', String(!modifiersOpen));
            if (!modifiersOpen) {
                document.querySelectorAll('.modifier-group-card').forEach(card => {
                    // Сброс разворота: показываем минимальный набор (3 штуки) для экспандеров
                    card.classList.remove('is-expanded');
                    if (card.classList.contains('is-collapsible')) {
                        card.classList.add('is-collapsed');
                    }
                });
                requestAnimationFrame(layoutModifierMasonry);
                updateModifierGroupHighlights();
            }
        };

        const setModifiersOpen = (nextState) => {
            modifiersOpen = Boolean(nextState);
            applyModifiersState();
        };

        applyModifiersState();

        toggleModifiersBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            setModifiersOpen(!modifiersOpen);
        });

        if (modifiersHeader) {
            modifiersHeader.addEventListener('click', (event) => {
                if (event.target.closest('a') || event.target.closest('button')) {
                    return;
                }
                setModifiersOpen(!modifiersOpen);
            });
        }

        const setAllModifierGroupsState = (expandAll = false) => {
            const cards = document.querySelectorAll('.modifier-group-card');
            cards.forEach(card => {
                if (expandAll) {
                    card.classList.add('is-expanded');
                    card.classList.remove('is-collapsed');
                } else {
                    card.classList.remove('is-expanded');
                    if (card.classList.contains('is-collapsible')) {
                        card.classList.add('is-collapsed');
                    }
                }
            });
            requestAnimationFrame(layoutModifierMasonry);
            updateModifierGroupHighlights();
        };

        if (expandCollapseIcon) {
            expandCollapseIcon.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!modifiersOpen) {
                    setModifiersOpen(true);
                }
                const cards = document.querySelectorAll('.modifier-group-card');
                const hasCollapsed = Array.from(cards).some(card => !card.classList.contains('is-expanded'));
                setAllModifierGroupsState(hasCollapsed);
                updateModifierGroupHighlights();
            });
        }
    }
    
    const makeLocalDiagEntry = (label, details = '', level = 'info', type = 'PING') => ({
        ts: Date.now(),
        type,
        label,
        details,
        level
    });

    const measureDiagEntryHeight = (body) => {
        if (!body) return DIAG_ENTRY_FALLBACK_HEIGHT;
        if (diagEntryHeightCache.has(body)) {
            return diagEntryHeightCache.get(body);
        }
        const sample = body.querySelector('.diag-entry');
        const height = sample ? sample.getBoundingClientRect().height : DIAG_ENTRY_FALLBACK_HEIGHT;
        const resolved = Math.max(height || DIAG_ENTRY_FALLBACK_HEIGHT, DIAG_ENTRY_FALLBACK_HEIGHT);
        diagEntryHeightCache.set(body, resolved);
        return resolved;
    };

    const adjustDiagBodyHeight = (body, entryCount = 0) => {
        if (!body) return;
        const entryHeight = measureDiagEntryHeight(body);
        const visibleCount = Math.max(1, Math.min(entryCount || 1, DIAG_ENTRY_LIMIT));
        const dynamicHeight = entryHeight * visibleCount;
        const targetHeight = diagnosticsExpanded
            ? Math.max(DIAG_BASE_HEIGHT, dynamicHeight)
            : DIAG_COLLAPSED_HEIGHT;
        body.style.maxHeight = `${targetHeight}px`;
        if (diagnosticsExpanded) {
            body.scrollTop = body.scrollHeight;
        } else {
            body.scrollTop = 0;
        }
    };

    const refreshAllDiagBodies = () => {
        if (!diagnosticsLogWrapper) return;
        diagnosticsLogWrapper.querySelectorAll('.diag-modal-body').forEach((body) => {
            const entries = body.querySelectorAll('.diag-entry').length;
            adjustDiagBodyHeight(body, entries);
        });
    };

    const setPingButtonState = (llmName, state, message = '') => {
        const btn = manualPingButtons[llmName];
        if (!btn) return;
        btn.dataset.pending = state === 'pending' ? 'true' : 'false';
        btn.classList.toggle('is-pending', state === 'pending');
        btn.classList.remove('ping-success', 'ping-error', 'ping-unchanged');
        if (state === 'success') btn.classList.add('ping-success');
        if (state === 'error') btn.classList.add('ping-error');
        if (state === 'unchanged') btn.classList.add('ping-unchanged');
        if (message) btn.title = message;
        if (state !== 'pending') {
            setTimeout(() => {
                const currentBtn = manualPingButtons[llmName];
                if (currentBtn) {
                    currentBtn.classList.remove('ping-success', 'ping-error', 'ping-unchanged');
                    currentBtn.title = 'Get answer';
                }
            }, 2000);
        }
    };

    const setResendButtonState = (llmName, state, message = '') => {
        const btn = manualResendButtons[llmName];
        if (!btn) return;
        const isPending = state === 'pending';
        btn.dataset.resendPending = isPending ? 'true' : 'false';
        btn.classList.toggle('is-pending', isPending);
        btn.classList.remove('resend-success', 'resend-error');
        if (state === 'success') btn.classList.add('resend-success');
        if (state === 'error') btn.classList.add('resend-error');
        if (message) btn.title = message;
        if (!isPending) {
            setTimeout(() => {
                const currentBtn = manualResendButtons[llmName];
                if (currentBtn && currentBtn.dataset.resendPending !== 'true') {
                    currentBtn.classList.remove('resend-success', 'resend-error');
                    currentBtn.title = 'Resend request';
                }
            }, 2000);
        }
    };

    const triggerManualPing = (llmName, button) => {
        if (!llmName || !button) return;
        if (button.dataset.pending === 'true') return;

        button.dataset.pending = 'true';
        button.classList.add('is-pending');
        button.setAttribute('aria-busy', 'true');
        manualPingButtons[llmName] = button;
        setPingButtonState(llmName, 'pending');

        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            button.dataset.pending = 'false';
            button.classList.remove('is-pending');
            button.removeAttribute('aria-busy');
        };
        const failSafeTimer = setTimeout(() => {
            release();
            console.warn(`[RESULTS] Manual ping timeout for ${llmName}`);
            ingestLogs(llmName, [makeLocalDiagEntry('Ручной ping: таймаут ожидания ответа UI', '', 'warning')]);
        }, 8000);

        ingestLogs(llmName, [makeLocalDiagEntry('Ручной ping: нажатие кнопки')]);

        chrome.runtime.sendMessage({ type: 'MANUAL_RESPONSE_PING', llmName }, (response) => {
            clearTimeout(failSafeTimer);
            release();
            manualPingButtons[llmName] = button;

            if (chrome.runtime.lastError) {
                console.error(`[RESULTS] Manual ping failed for ${llmName}:`, chrome.runtime.lastError.message);
                ingestLogs(llmName, [makeLocalDiagEntry('Ручной ping: ошибка UI', chrome.runtime.lastError.message, 'error')]);
                if (typeof showNotification === 'function') {
                    showNotification(`Не удалось отправить ping для ${llmName}: ${chrome.runtime.lastError.message}`);
                }
                setPingButtonState(llmName, 'error', chrome.runtime.lastError.message);
                return;
            }

            const status = response?.status;
            const errorMessage = response?.error || 'Неизвестная ошибка';

            if (status === 'manual_ping_sent') {
                console.log(`[RESULTS] Manual ping dispatched for ${llmName}`);
                ingestLogs(llmName, [makeLocalDiagEntry('Ручной ping отправлен (ожидаем ответ)', '', 'success')]);
            } else if (status === 'manual_ping_failed') {
                ingestLogs(llmName, [makeLocalDiagEntry('Ручной ping не отправлен', errorMessage, 'error')]);
                if (typeof showNotification === 'function') {
                    showNotification(`Ping не отправлен для ${llmName}: ${errorMessage}`);
                }
                setPingButtonState(llmName, 'error', errorMessage);
            } else {
                ingestLogs(llmName, [makeLocalDiagEntry('Ручной ping: неизвестный статус', status || 'нет данных', 'warning')]);
                setPingButtonState(llmName, 'error', 'Неизвестный статус ping');
            }
        });
    };

    const triggerManualResend = (llmName, button) => {
        if (!llmName || !button) return;
        if (button.dataset.resendPending === 'true') return;

        manualResendButtons[llmName] = button;
        ingestLogs(llmName, [makeLocalDiagEntry('Ручная повторная отправка: нажатие кнопки', '', 'info', 'RESEND')]);
        setResendButtonState(llmName, 'pending', 'Повторная отправка...');

        chrome.runtime.sendMessage({ type: 'MANUAL_RESEND_REQUEST', llmName }, (response) => {
            if (chrome.runtime.lastError) {
                const errMsg = chrome.runtime.lastError.message;
                console.error(`[RESULTS] Manual resend runtime error for ${llmName}:`, errMsg);
                ingestLogs(llmName, [makeLocalDiagEntry('Ручная повторная отправка: ошибка UI', errMsg, 'error', 'RESEND')]);
                setResendButtonState(llmName, 'error', errMsg);
                return;
            }

            if (response?.status === 'manual_resend_dispatched') {
                ingestLogs(llmName, [makeLocalDiagEntry('Ручная повторная отправка отправлена', '', 'success', 'RESEND')]);
                // остаемся в pending до получения ответа/ошибки
            } else {
                const errorMessage = response?.error || 'Неизвестная ошибка';
                ingestLogs(llmName, [makeLocalDiagEntry('Ручная повторная отправка не запущена', errorMessage, 'error', 'RESEND')]);
                setResendButtonState(llmName, 'error', errorMessage);
            }
        });
    };

    statusPingButtons.forEach((button) => {
        button.addEventListener('click', () => {
            const llmName = button.dataset.llmName;
            if (!llmName) return;
            triggerManualPing(llmName, button);
        });
    });

    statusResendButtons.forEach((button) => {
        button.addEventListener('click', () => {
            const llmName = button.dataset.llmName;
            if (!llmName) return;
            manualResendButtons[llmName] = button;
            triggerManualResend(llmName, button);
        });
    });

    function escapeAttrValue(value = '') {
        if (window.CSS && typeof CSS.escape === 'function') {
            return CSS.escape(value);
        }
        return String(value).replace(/"/g, '\\"');
    }

    function settleManualResend(llmName, state, message = '') {
        const btn = manualResendButtons[llmName];
        if (!btn) return;
        if (state === 'pending') {
            setResendButtonState(llmName, 'pending', message);
            return;
        }
        if (btn.dataset.resendPending === 'true') {
            setResendButtonState(llmName, state, message);
        }
    }

    function ensureDiagnosticsState(llmName) {
        if (!diagnosticsState[llmName]) {
            diagnosticsState[llmName] = { collapsed: false, userToggled: false };
        }
        return diagnosticsState[llmName];
    }

    function getDiagnosticsContainer(llmName) {
        const selector = `.llm-diagnostics[data-llm-name="${escapeAttrValue(llmName)}"]`;
        return document.querySelector(selector);
    }

    function setDiagnosticsCollapsed(llmName, collapsed) {
        const state = ensureDiagnosticsState(llmName);
        state.collapsed = collapsed;
        const container = getDiagnosticsContainer(llmName);
        if (!container) return;
        const toggle = container.querySelector('.diag-toggle');
        container.dataset.collapsed = collapsed ? 'true' : 'false';
        if (toggle) {
            toggle.setAttribute('aria-expanded', String(!collapsed));
        }
    }

    function formatDiagTimestamp(ts) {
        if (!ts) return '--:--:--';
        try {
            return new Intl.DateTimeFormat(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            }).format(new Date(ts));
        } catch (_) {
            const date = new Date(ts);
            return date.toLocaleTimeString();
        }
    }

    const formatDiagMeta = (meta = null) => {
        if (!meta || typeof meta !== 'object') return '';
        try {
            const json = JSON.stringify(meta, null, 2);
            if (!json || json === '{}' || json === 'null') return '';
            return `
                <details class="diag-meta">
                    <summary>meta</summary>
                    <pre>${escapeHtml(json)}</pre>
                </details>
            `;
        } catch (err) {
            return '';
        }
    };

    const buildDiagEntriesMarkup = (logs = []) => {
        return logs.map(entry => {
            const levelClass = `diag-${entry.level || 'info'}`;
            const details = entry.details ? `<span class="diag-details">${escapeHtml(entry.details)}</span>` : '';
            const metaBlock = formatDiagMeta(entry.meta);
            const label = escapeHtml(entry.label || '');
            return `
                <div class="diag-entry ${levelClass}">
                    <span class="diag-time">${formatDiagTimestamp(entry.ts)}</span>
                    <span class="diag-label">${label}</span>
                    ${details}
                    ${metaBlock}
                </div>
            `;
        }).join('');
    };

    const DIAGNOSTICS_EXPORT_STYLE = `
        body { font-family: Arial, sans-serif; background: #ffffff; color: #111827; padding: 24px; line-height: 1.5; }
        h1 { font-size: 24px; margin: 0 0 16px; }
        h2 { font-size: 18px; margin: 24px 0 12px; }
        .diag-section { margin-bottom: 24px; }
        .diag-entry { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; border: 1px solid #e2e8f0; border-radius: 8px; padding: 6px 8px; background: #fff; }
        .diag-entry.diag-success { border-color: #4ade80; background: #f0fdf4; }
        .diag-entry.diag-warning { border-color: #facc15; background: #fefce8; }
        .diag-entry.diag-error { border-color: #f87171; background: #fef2f2; }
        .diag-entry.diag-info { border-color: #cbd5f5; background: #eef2ff; }
        .diag-entry.diag-api { border-color: #7dd3fc; background: #e0f2fe; }
        .diag-entry.diag-api-error { border-color: #fb7185; background: #fff1f2; color: #991b1b; }
        .diag-time { font-family: "DM Mono", monospace; font-size: 11px; color: #64748b; }
        .diag-label { font-weight: 600; color: #0f172a; }
        .diag-details { color: #475569; }
        .diag-placeholder { margin: 0; font-size: 13px; color: #6b7280; }
        .diag-meta { flex-basis: 100%; }
        .diag-meta summary { cursor: pointer; font-size: 12px; color: #475569; }
        .diag-meta pre { margin: 6px 0 0; background: #f8fafc; padding: 8px; border-radius: 6px; font-size: 12px; white-space: pre-wrap; }
    `;

    const buildDiagnosticsSectionHtml = (name, logs) => {
        const safeName = escapeHtml(name || 'Unknown');
        const content = logs.length
            ? buildDiagEntriesMarkup(logs)
            : '<p class="diag-placeholder">Журнал пуст</p>';
        return `
            <section class="diag-section">
                <h2>${safeName}</h2>
                ${content}
            </section>
        `;
    };

    const buildDiagnosticsExportHtml = (title, sectionsHtml) => `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${escapeHtml(title)}</title>
    <style>
        ${DIAGNOSTICS_EXPORT_STYLE}
    </style>
</head>
<body>
    <h1>${escapeHtml(title)}</h1>
    ${sectionsHtml}
</body>
</html>`;

    const sanitizeFileSegment = (value, fallback) => {
        const cleaned = String(value || '').replace(/[\\/:*?"<>|]/g, '').trim();
        return cleaned || fallback;
    };

    const formatDiagnosticsExportStamp = () => {
        const now = new Date();
        const pad = (num) => String(num).padStart(2, '0');
        return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
    };

    const downloadDiagnosticsHtml = (fileBase, htmlContent, button) => {
        const safeBase = sanitizeFileSegment(fileBase, 'Diagnostics');
        const fileName = `${safeBase} ${formatDiagnosticsExportStamp()}.html`;
        try {
            const blob = new Blob([htmlContent], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = fileName;
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
            URL.revokeObjectURL(url);
            if (button) flashButtonFeedback(button, 'success');
        } catch (err) {
            console.error('[Diagnostics Export] failed', err);
            if (button) flashButtonFeedback(button, 'error');
        }
    };

    function applyDiagnosticsExpandState() {
        if (!diagnosticsLogWrapper) return;
        if (diagnosticsCollapseToggle) {
            diagnosticsCollapseToggle.classList.toggle('is-expanded', diagnosticsExpanded);
            diagnosticsCollapseToggle.setAttribute('aria-pressed', String(diagnosticsExpanded));
            diagnosticsCollapseToggle.setAttribute(
                'aria-label',
                diagnosticsExpanded ? 'Collapse diagnostics logs' : 'Restore compact diagnostics height'
            );
        }
        refreshAllDiagBodies();
    }

    const DEVTOOLS_PANELS_FIXED_HEIGHT = 520;
    const syncDevtoolsPanelHeight = () => {
        const modal = document.getElementById('api-keys-modal');
        if (!modal) return;
        const panelsHost = modal.querySelector('.devtools-tabpanels');
        if (!panelsHost) return;
        panelsHost.style.setProperty('--devtools-panels-height', `${DEVTOOLS_PANELS_FIXED_HEIGHT}px`);
    };

    function renderDiagnosticsModal() {
        if (!diagnosticsLogWrapper) return;
        const selectedModels = getSelectedLLMs();
        if (!selectedModels.length) {
            diagnosticsLogWrapper.innerHTML = '<p class="diag-empty">Нет выбранных моделей.</p>';
            applyDiagnosticsExpandState();
            syncDevtoolsPanelHeight();
            return;
        }
        const sourceNames = selectedModels;
        const sections = sourceNames
            .map(llmName => {
                if (!llmName) return '';
                const logs = llmLogs[llmName] || [];
                const openAttr = ' open';
                const bodyContent = logs.length
                    ? buildDiagEntriesMarkup(logs)
                    : '<p class="diag-placeholder">Журнал пуст</p>';
                return `
                    <details class="diag-modal-block"${openAttr} data-llm-name="${escapeHtml(llmName)}">
                        <summary>
                            <span class="diag-modal-title">${escapeHtml(llmName)}</span>
                            <span class="diag-modal-count">${logs.length}</span>
                            <div class="diag-modal-actions">
                                <button type="button" class="diag-action-btn diag-export-action" data-action="export-html" aria-label="Export log for ${escapeHtml(llmName)} as HTML">&lt;/&gt;</button>
                                <button type="button" class="diag-action-btn diag-copy-action" data-action="copy-log" aria-label="Copy log for ${escapeHtml(llmName)}">⧉</button>
                                <button type="button" class="diag-action-btn diag-clear-action" data-action="clear-log" aria-label="Clear log for ${escapeHtml(llmName)}">🗑️</button>
                            </div>
                        </summary>
                        <div class="diag-modal-body">
                            ${bodyContent}
                        </div>
                    </details>
                `;
            })
            .filter(Boolean)
            .join('');
        diagnosticsLogWrapper.innerHTML = sections || '<p class="diag-empty">Нет логов по выбранным моделям.</p>';
        applyDiagnosticsExpandState();
        syncDevtoolsPanelHeight();
    }

    function renderDiagnostics(llmName) {
        const container = getDiagnosticsContainer(llmName);
        if (!container) {
            renderDiagnosticsModal();
            return;
        }
        const logArea = container.querySelector('.diag-log');
        const countEl = container.querySelector('.diag-count');
        const allLogs = llmLogs[llmName] || [];
        // Prefer explicit diagnostic entries to avoid duplication.
        const diagOnly = allLogs.filter((entry) => (
            entry?.scope === 'diagnostic'
            || entry?.type === 'diagnostic'
            || entry?.channel === 'diagnostic'
            || entry?.diagnostic === true
        ));
        const logs = diagOnly.length ? diagOnly : allLogs;
        if (countEl) {
            countEl.textContent = logs.length;
        }
        if (!logArea) return;
        if (!logs.length) {
            logArea.innerHTML = '<p class="diag-empty">Журнал пуст</p>';
            renderDiagnosticsModal();
            return;
        }
        logArea.innerHTML = buildDiagEntriesMarkup(logs);
    renderDiagnosticsModal();
    }

    document.addEventListener('click', (event) => {
        const btn = event.target.closest('#export-diagnostics-html');
        if (!btn) return;
        const selectedModels = getSelectedLLMs();
        const sources = selectedModels.filter((name) => (llmLogs[name] || []).length);
        if (!sources.length) {
            flashButtonFeedback(btn, 'warn');
            return;
        }
        const sectionsHtml = sources
            .map((name) => buildDiagnosticsSectionHtml(name, llmLogs[name] || []))
            .join('');
        const htmlContent = buildDiagnosticsExportHtml('Diagnostics Logs', sectionsHtml);
        downloadDiagnosticsHtml('Diagnostics Logs', htmlContent, btn);
    });

    if (diagnosticsLogWrapper) {
        diagnosticsLogWrapper.addEventListener('click', (event) => {
            const button = event.target.closest('.diag-action-btn');
            if (!button) return;
            const block = button.closest('.diag-modal-block');
            const modelName = block?.dataset?.llmName;
            if (!modelName) return;
            const action = button.dataset.action;
            if (action === 'export-html') {
                const entries = llmLogs[modelName] || [];
                if (!entries.length) {
                    flashButtonFeedback(button, 'warn');
                    return;
                }
                const sectionsHtml = buildDiagnosticsSectionHtml(modelName, entries);
                const htmlContent = buildDiagnosticsExportHtml(`Diagnostics ${modelName}`, sectionsHtml);
                downloadDiagnosticsHtml(`Diagnostics ${modelName}`, htmlContent, button);
                return;
            }
            if (action === 'copy-log') {
                const entries = llmLogs[modelName] || [];
                const logBody = entries.map((entry) => {
                    const time = formatDiagTimestamp(entry.ts);
                    const label = entry.label || '';
                    const details = entry.details ? ` – ${entry.details}` : '';
                    return `[${time}] ${label}${details}`;
                }).join('\n');
                const text = logBody
                    ? `<Dev logs ${modelName}>\n${logBody}\n</Dev logs>`
                    : '';
                if (navigator.clipboard && text) {
                    navigator.clipboard.writeText(text).catch(() => {
                        console.warn('[Diagnostics] Clipboard write failed');
                    });
                }
            }
            if (action === 'clear-log') {
                llmLogs[modelName] = [];
                renderDiagnostics(modelName);
            }
        });
    }


    function ingestLogs(llmName, logs = []) {
        if (!llmName || !Array.isArray(logs) || !logs.length) return;
        const state = ensureDiagnosticsState(llmName);
        const existing = llmLogs[llmName] || [];
        const map = new Map();
        [...existing, ...logs].forEach(entry => {
            if (!entry) return;
            const ts = entry.ts || Date.now();
            const key = `${ts}-${entry.label || ''}-${entry.details || ''}-${entry.type || ''}`;
            map.set(key, { ...entry, ts });
        });
        const merged = Array.from(map.values()).sort((a, b) => a.ts - b.ts);
        if (merged.length > MAX_DIAGNOSTIC_ENTRIES) {
            merged.splice(0, merged.length - MAX_DIAGNOSTIC_ENTRIES);
        }
        llmLogs[llmName] = merged;
        if (state && state.collapsed && !state.userToggled) {
            setDiagnosticsCollapsed(llmName, false);
        }
        renderDiagnostics(llmName);
    }

    function autoCollapseDiagnostics(llmName, answerText) {
        if (!llmName) return;
        const state = ensureDiagnosticsState(llmName);
        if (state.userToggled || state.collapsed) return;
        if (answerText && typeof answerText === 'string' && answerText.trim().startsWith('Error:')) {
            return;
        }
        setDiagnosticsCollapsed(llmName, true);
        state.collapsed = true;
    }

    function initializeDiagnosticsUI() {
        llmPanels.forEach(panel => {
            const llmTitleEl = panel.querySelector('.llm-title');
            if (!llmTitleEl) return;
            const llmName = llmTitleEl.textContent.trim();
            if (!llmName) return;
            ensureDiagnosticsState(llmName);
            if (panel.querySelector('.llm-diagnostics')) return;
            const diagContainer = document.createElement('div');
            diagContainer.className = 'llm-diagnostics';
            diagContainer.dataset.llmName = llmName;
            diagContainer.innerHTML = `
                <button type="button" class="diag-toggle" aria-expanded="true">
                    Диагностика <span class="diag-count">0</span>
                </button>
                <div class="diag-log"></div>
            `;
            const outputElement = panel.querySelector('.output');
            panel.insertBefore(diagContainer, outputElement);
            const toggleBtn = diagContainer.querySelector('.diag-toggle');
            if (toggleBtn) {
                toggleBtn.addEventListener('click', () => {
                    const state = ensureDiagnosticsState(llmName);
                    const nextCollapsed = !(state && state.collapsed === true);
                    state.userToggled = true;
                    setDiagnosticsCollapsed(llmName, nextCollapsed);
                });
            }
            setDiagnosticsCollapsed(llmName, false);
            renderDiagnostics(llmName);
        });
    }

    initializeDiagnosticsUI();
    initializeApiIndicators();

    // (reverted) Telemetry Dev UI removed to restore original layout and behavior.

    if (diagnosticsCollapseToggle) {
        diagnosticsCollapseToggle.addEventListener('click', () => {
            diagnosticsExpanded = !diagnosticsExpanded;
            applyDiagnosticsExpandState();
        });
    }
    applyDiagnosticsExpandState();
    if (clearDiagnosticsBtn) {
        clearDiagnosticsBtn.addEventListener('click', () => {
            Object.keys(llmLogs).forEach((llmName) => {
                llmLogs[llmName] = [];
                renderDiagnostics(llmName);
            });
            renderDiagnosticsModal();
            if (typeof showNotification === 'function') {
                showNotification('Diagnostics logs cleared.');
            }
        });
    }
    
    let autoMode = autoCheckbox ? autoCheckbox.checked : false;

    const newPagesStorageKey = 'llmComparatorNewPages';
    const storeNewPagesState = (checked) => {
        chrome.storage.local.set({ [newPagesStorageKey]: checked });
    };
    if (newPagesCheckbox) {
        chrome.storage.local.get(newPagesStorageKey, (data) => {
            const stored = data?.[newPagesStorageKey];
            if (typeof stored === 'boolean') {
                newPagesCheckbox.checked = stored;
            }
        });
        newPagesCheckbox.addEventListener('change', () => {
            storeNewPagesState(newPagesCheckbox.checked);
        });
    }

    const apiModeStorageKey = 'llmComparatorApiModeEnabled';
    if (apiModeCheckbox) {
        chrome.storage.local.get(apiModeStorageKey, (data) => {
            const stored = data?.[apiModeStorageKey];
            if (typeof stored === 'boolean') {
                apiModeCheckbox.checked = stored;
            }
            if (syncApiToggleState) syncApiToggleState();
        });
        apiModeCheckbox.addEventListener('change', () => {
            chrome.storage.local.set({ [apiModeStorageKey]: apiModeCheckbox.checked });
            if (syncApiToggleState) syncApiToggleState();
        });
    }

    const updateDevToolsStatus = (message, tone = 'info') => {
        if (!devToolsStatus) return;
        devToolsStatus.textContent = message || '';
        devToolsStatus.dataset.tone = tone;
    };

    if (refreshOverridesBtn) {
        refreshOverridesBtn.addEventListener('click', () => {
            refreshOverridesBtn.disabled = true;
            updateDevToolsStatus('Refreshing remote selectors…', 'pending');
            chrome.runtime.sendMessage({ type: 'REFRESH_SELECTOR_OVERRIDES' }, () => {
                refreshOverridesBtn.disabled = false;
                if (chrome.runtime.lastError) {
                    updateDevToolsStatus(`Refresh failed: ${chrome.runtime.lastError.message}`, 'error');
                }
                // success/failure will be reported via SELECTOR_OVERRIDE_REFRESH_RESULT
            });
        });
    }

    if (clearOverridesBtn) {
        clearOverridesBtn.addEventListener('click', () => {
            clearOverridesBtn.disabled = true;
            updateDevToolsStatus('Clearing overrides and cache…', 'pending');
            chrome.runtime.sendMessage({ type: 'CLEAR_SELECTOR_OVERRIDES_AND_CACHE' }, () => {
                clearOverridesBtn.disabled = false;
                if (chrome.runtime.lastError) {
                    updateDevToolsStatus(`Clear failed: ${chrome.runtime.lastError.message}`, 'error');
                }
                // final status handled via SELECTOR_OVERRIDE_CLEARED
            });
        });
    }
    
    if (clearSelectorCacheBtn) {
        clearSelectorCacheBtn.addEventListener('click', () => {
            clearSelectorCacheBtn.disabled = true;
            updateDevToolsStatus('Clearing selector cache…', 'pending');
            chrome.runtime.sendMessage({ type: 'CLEAR_SELECTOR_CACHE' }, (response) => {
                clearSelectorCacheBtn.disabled = false;
                if (chrome.runtime.lastError) {
                    updateDevToolsStatus(`Cache clear failed: ${chrome.runtime.lastError.message}`, 'error');
                    return;
                }
                if (response?.status === 'ok') {
                    updateDevToolsStatus(`Cache cleared (${response.removed || 0} entries)`, 'success');
                } else {
                    updateDevToolsStatus('Cache clear error', 'error');
                }
            });
        });
    }

    if (runSelectorHealthcheckBtn) {
        runSelectorHealthcheckBtn.addEventListener('click', () => {
            runSelectorHealthcheckBtn.disabled = true;
            updateDevToolsStatus('Running selector health-check…', 'pending');
            chrome.runtime.sendMessage({ type: 'RUN_SELECTOR_HEALTHCHECK' }, (response) => {
                runSelectorHealthcheckBtn.disabled = false;
                if (chrome.runtime.lastError) {
                    updateDevToolsStatus(`Health-check failed: ${chrome.runtime.lastError.message}`, 'error');
                    return;
                }
                if (response?.status === 'ok') {
                    const failures = (response.results || []).filter((entry) => !entry.ok).length;
                    if (failures) {
                        updateDevToolsStatus(`Health-check finished: ${failures} models need attention`, 'warning');
                    } else {
                        updateDevToolsStatus('Health-check finished: all models OK', 'success');
                    }
                    requestSelectorHealthSummary(false);
                } else {
                    updateDevToolsStatus(response?.error || 'Health-check error', 'error');
                }
            });
        });
    }

    const getSelectedElementType = () => liveSelectorElementSelect?.value || 'composer';

    const formatSelectorSample = (sample) => {
        if (!sample) return '';
        const tag = sample.tag ? `<${sample.tag.toLowerCase()}>` : '';
        const text = sample.text ? ` — ${sample.text}` : '';
        return `${tag}${text}`.trim();
    };

    const summarizeValidation = (entry) => {
        if (!entry) return { text: 'Нет данных', tone: 'warning' };
        if (entry.error) return { text: `Ошибка: ${entry.error}`, tone: 'error' };
        const matches = Number(entry.matches || 0);
        const sample = formatSelectorSample(entry.sample);
        const tail = sample ? ` · ${sample}` : '';
        const text = matches > 0 ? `Найдено: ${matches}${tail}` : `Не найдено: 0`;
        return { text, tone: matches > 0 ? 'success' : 'warning' };
    };

    if (selectorDetectedRefreshBtn) {
        selectorDetectedRefreshBtn.addEventListener('click', () => {
            refreshActiveSelectorSnapshot();
        });
    }

    if (selectorValidateBtn) {
        selectorValidateBtn.addEventListener('click', () => {
            const modelName = getSelectedModelName();
            const selectorValue = selectorOverrideInput?.value?.trim();
            if (!modelName) {
                updateDevToolsStatus('Выберите модель для проверки', 'warning');
                return;
            }
            if (!selectorValue) {
                updateDevToolsStatus('Введите CSS селектор для проверки', 'warning');
                return;
            }
            setSelectorValidationStatus('Проверяем селектор…');
            validateSelectorsOnModel(modelName, [selectorValue], (response) => {
                if (response?.status === 'no_tab') {
                    setSelectorValidationStatus('Нет активной вкладки для проверки', 'warning');
                    return;
                }
                if (response?.status !== 'ok') {
                    setSelectorValidationStatus(response?.error || 'Ошибка проверки селектора', 'error');
                    return;
                }
                const entry = response.results?.[0] || null;
                lastSelectorValidation = entry ? { ...entry, selector: selectorValue, modelName } : null;
                const summary = summarizeValidation(entry);
                setSelectorValidationStatus(summary.text, summary.tone);
            });
        });
    }

    if (selectorValidateActiveBtn) {
        selectorValidateActiveBtn.addEventListener('click', () => {
            const modelName = getSelectedModelName();
            const elementType = getSelectedElementType();
            const selectors = activeSelectorSnapshot?.selectors?.[elementType] || [];
            if (!modelName) {
                updateDevToolsStatus('Выберите модель для проверки', 'warning');
                return;
            }
            if (!selectors.length) {
                updateDevToolsStatus('Нет активных селекторов для проверки', 'warning');
                return;
            }
            updateDevToolsStatus('Проверяем активные селекторы…', 'pending');
            validateSelectorsOnModel(modelName, selectors, (response) => {
                if (response?.status === 'no_tab') {
                    updateDevToolsStatus('Нет активной вкладки для проверки', 'warning');
                    return;
                }
                if (response?.status !== 'ok') {
                    updateDevToolsStatus(response?.error || 'Ошибка проверки селекторов', 'error');
                    return;
                }
                activeSelectorValidationMap = new Map();
                (response.results || []).forEach((entry) => {
                    if (entry?.selector) activeSelectorValidationMap.set(entry.selector, entry);
                });
                renderActiveSelectors();
                updateDevToolsStatus('Проверка селекторов завершена', 'success');
            });
        });
    }

    if (selectorPickBtn) {
        selectorPickBtn.addEventListener('click', () => {
            const modelName = getSelectedModelName();
            const elementType = getSelectedElementType();
            if (!modelName) {
                updateDevToolsStatus('Выберите модель для выбора селектора', 'warning');
                return;
            }
            if (activePickerRequestId) {
                updateDevToolsStatus('Выбор уже активен — завершите его или нажмите ESC', 'warning');
                return;
            }
            selectorPickBtn.disabled = true;
            updateDevToolsStatus('Выбор активен: кликните элемент на вкладке модели', 'pending');
            chrome.runtime.sendMessage({ type: 'PICK_SELECTOR_START', modelName, elementType, mode: 'selector' }, (response) => {
                if (chrome.runtime.lastError) {
                    selectorPickBtn.disabled = false;
                    updateDevToolsStatus(`Не удалось запустить выбор: ${chrome.runtime.lastError.message}`, 'error');
                    return;
                }
                if (!response || response.status !== 'ok' || !response.requestId) {
                    selectorPickBtn.disabled = false;
                    updateDevToolsStatus(response?.error || 'Не удалось запустить выбор', 'error');
                    return;
                }
                activePickerRequestId = response.requestId;
                activePickerMode = 'override';
                if (pickerTimeoutId) clearTimeout(pickerTimeoutId);
                pickerTimeoutId = setTimeout(() => {
                    if (activePickerRequestId !== response.requestId) return;
                    activePickerRequestId = null;
                    activePickerMode = null;
                    selectorPickBtn.disabled = false;
                    updateDevToolsStatus('Выбор истек по таймауту', 'warning');
                }, 60000);
            });
        });
    }

    if (selectorHighlightBtn) {
        selectorHighlightBtn.addEventListener('click', () => {
            const modelName = getSelectedModelName();
            const selectorValue = selectorOverrideInput?.value?.trim();
            if (!modelName) {
                updateDevToolsStatus('Выберите модель для подсветки селектора', 'warning');
                return;
            }
            if (!selectorValue) {
                updateDevToolsStatus('Введите CSS селектор для подсветки', 'warning');
                return;
            }
            updateDevToolsStatus('Подсвечиваем селектор…', 'pending');
            chrome.runtime.sendMessage({ type: 'HIGHLIGHT_SELECTOR', modelName, selector: selectorValue }, (response) => {
                if (chrome.runtime.lastError) {
                    updateDevToolsStatus(`Подсветка не удалась: ${chrome.runtime.lastError.message}`, 'error');
                    return;
                }
                if (response?.status === 'ok') {
                    updateDevToolsStatus('Селектор подсвечен в активной вкладке', 'success');
                } else {
                    updateDevToolsStatus(response?.error || 'Не удалось подсветить селектор', 'error');
                }
            });
        });
    }

    if (selectorSaveOverrideBtn) {
        selectorSaveOverrideBtn.addEventListener('click', () => {
            const modelName = getSelectedModelName();
            const elementType = getSelectedElementType();
            const selectorValue = selectorOverrideInput?.value?.trim();
            const reasonValue = selectorOverrideReasonInput?.value?.trim();
            if (!modelName || !selectorValue) {
                updateDevToolsStatus('Выберите модель и введите селектор для сохранения', 'warning');
                return;
            }
            if (!reasonValue) {
                updateDevToolsStatus('Укажите причину или тикет для override', 'warning');
                return;
            }
            const finalizeSave = () => {
                selectorSaveOverrideBtn.disabled = true;
                updateDevToolsStatus('Сохраняем override…', 'pending');
                chrome.runtime.sendMessage(
                    { type: 'SAVE_SELECTOR_OVERRIDE', modelName, elementType, selector: selectorValue, reason: reasonValue },
                    (response) => {
                        selectorSaveOverrideBtn.disabled = false;
                        if (chrome.runtime.lastError) {
                            updateDevToolsStatus(`Сохранение не удалось: ${chrome.runtime.lastError.message}`, 'error');
                            return;
                        }
                        if (response?.status === 'ok') {
                            updateDevToolsStatus('Override сохранён. Обновите вкладку модели для применения.', 'success');
                            requestSelectorDefinitions(modelName);
                            refreshSelectorAudit(modelName);
                            refreshActiveSelectorSnapshot();
                            refreshSavedOverridesList();
                            if (selectorOverrideReasonInput) selectorOverrideReasonInput.value = '';
                        } else {
                            updateDevToolsStatus(response?.error || 'Ошибка сохранения override', 'error');
                        }
                    }
                );
            };
            validateSelectorsOnModel(modelName, [selectorValue], (response) => {
                if (response?.status === 'no_tab') {
                    updateDevToolsStatus('Нет активной вкладки, override сохранён без проверки', 'warning');
                    setSelectorValidationStatus('Нет активной вкладки для проверки', 'warning');
                    finalizeSave();
                    return;
                }
                if (response?.status !== 'ok') {
                    updateDevToolsStatus(response?.error || 'Проверка не удалась', 'error');
                    return;
                }
                const entry = response.results?.[0] || null;
                lastSelectorValidation = entry ? { ...entry, selector: selectorValue, modelName } : null;
                const summary = summarizeValidation(entry);
                setSelectorValidationStatus(summary.text, summary.tone);
                if (entry?.error) {
                    updateDevToolsStatus(summary.text, 'error');
                    return;
                }
                if (entry && Number(entry.matches || 0) === 0) {
                    const proceed = confirm('Селектор не найден в активной вкладке. Сохранить override всё равно?');
                    if (!proceed) return;
                }
                finalizeSave();
            });
        });
    }

    if (selectorAuditRefreshBtn) {
        selectorAuditRefreshBtn.addEventListener('click', () => refreshSelectorAudit());
    }
    
    // --- "SELECT ALL" CHECKBOX LOGIC ---
    const notifySelectionChanged = () => {
        try {
            document.dispatchEvent(new CustomEvent('llm-selection-change', { detail: { selected: getSelectedLLMs() } }));
        } catch (_) {}
    };

// Подстраховка: если модификаторы уже загружены до этого места — отрендерим повторно при изменении DOM
    const modifiersRowObserver = new MutationObserver(() => {
        const row = document.getElementById('modifiers-row');
        if (row && row.childElementCount === 0 && Object.keys(modifiersById || {}).length) {
            const merged = Object.values(modifiersById).sort((a,b) => (a.order||999)-(b.order||999));
            renderModifiersRow(merged);
        }
    });
    modifiersRowObserver.observe(document.body, { childList: true, subtree: true });
	    const setAllLLMsState = (shouldBeActive) => {
	        llmButtons.forEach(button => {
	            button.classList.toggle('active', shouldBeActive);
	            const llmId = button.id.replace('llm-', '');
	            const panel = document.getElementById(`panel-${llmId}`);
	            if (panel) {
	                panel.style.display = shouldBeActive ? 'block' : 'none';
	            }
	        });
	        checkCompareButtonState();
            renderDiagnosticsModal();
            notifySelectionChanged();
	    };

    const toggleAllLLMs = () => {
        const allActive = Array.from(llmButtons).every(btn => btn.classList.contains('active'));
        setAllLLMsState(!allActive);
    };

    // --- TEMPLATE FUNCTIONALITY ELEMENTS ---
    const templateSelect = document.getElementById('template-select');
    const createTemplateModal = document.getElementById('create-template-modal');
        const closeModal = createTemplateModal.querySelector('.close');
    const cancelTemplateButton = document.getElementById('cancel-template');
    const saveTemplateButton = document.getElementById('save-template');
    const addVariableButton = document.getElementById('add-variable');
    const templateNameInput = document.getElementById('template-name');
    const templatePrompt = document.getElementById('template-prompt');
    const templatePreview = document.getElementById('template-preview');
    const variablesList = document.getElementById('variables-list');
    const savedTemplatesList = document.getElementById('saved-templates-list');
    const systemTemplatesList = document.getElementById('system-templates-list');
    const savedTemplatesBox = document.getElementById('saved-templates-box');
    const savedTemplatesToggle = document.getElementById('saved-templates-toggle');
    const savedTemplatesContent = document.getElementById('saved-templates-content');
    const systemTemplatesBox = document.getElementById('system-templates-box');
    const systemTemplatesToggle = document.getElementById('system-templates-toggle');
    const systemTemplatesContent = document.getElementById('system-templates-content');
    const variableInputsContainer = document.getElementById('variable-inputs');
    const exportBtn = document.getElementById('export-templates-btn');
    const importBtn = document.getElementById('import-templates-btn');
    const importFileInput = document.getElementById('import-file-input');
    const confirmModal = document.getElementById('confirm-modal');
    const confirmMessage = document.getElementById('confirm-message');
    const deleteConfirmBtn = document.getElementById('delete-confirm');
    const cancelConfirmBtn = document.getElementById('cancel-confirm');
    const modelSelector = createTemplateModal.querySelector('.model-selector');
    const notificationModal = document.getElementById('notification-modal');
    const notificationMessage = document.getElementById('notification-message');
    const notificationOkBtn = document.getElementById('notification-ok-btn');
    const fileInput = document.getElementById('file-input');
    const fileNameDisplay = document.getElementById('file-name-display');
    const modalElements = Array.from(document.querySelectorAll('.modal'));
    const collapseStateStorageKey = 'templateCollapseStates';
    let collapseBoxStates = {};
    modalElements.forEach((modal) => {
        if (!modal.getAttribute('aria-hidden')) {
            modal.setAttribute('aria-hidden', 'true');
        }
        if (!modal.style.display) {
            modal.style.display = 'none';
        }
    });
    const loadCollapseStates = () => {
        try {
            const stored = localStorage.getItem(collapseStateStorageKey);
            collapseBoxStates = stored ? JSON.parse(stored) : {};
        } catch {
            collapseBoxStates = {};
        }
    };

    const saveCollapseStates = () => {
        try {
            localStorage.setItem(collapseStateStorageKey, JSON.stringify(collapseBoxStates));
        } catch (err) {
            console.warn('Failed to save collapse state', err);
        }
    };

    loadCollapseStates();

    const modalManager = (() => {
        const isModalVisible = () => Array.from(document.querySelectorAll('.modal')).some(modal => modal.style.display !== 'none');
        const show = (modal) => {
            if (!modal) return;
            modal.style.display = 'flex';
            modal.classList.add('is-visible');
            modal.setAttribute('aria-hidden', 'false');
            document.body.classList.add('modal-open');
        };
        const hide = (modal) => {
            if (!modal) return;
            modal.style.display = 'none';
            modal.classList.remove('is-visible');
            modal.setAttribute('aria-hidden', 'true');
            if (!isModalVisible()) {
                document.body.classList.remove('modal-open');
            }
        };
        const forceUnlock = () => {
            if (!isModalVisible()) {
                document.body.classList.remove('modal-open');
            }
        };
        return { show, hide, forceUnlock };
    })();
    modalElements.forEach((modal) => {
        modal.addEventListener('click', (event) => {
            if (event.target === modal) {
                modalManager.hide(modal);
            }
        });
    });

    function initializeCollapseBox(box, toggle, content, storageKey, collapsedByDefault = false) {
        if (!box || !toggle || !content) return;
        const storedState = storageKey ? collapseBoxStates[storageKey] : undefined;
        const initialCollapsed = typeof storedState === 'boolean' ? storedState : collapsedByDefault;

        const applyState = (collapsed) => {
            if (collapsed) {
                box.classList.add('collapsed');
                content.style.maxHeight = '0px';
                toggle.setAttribute('aria-expanded', 'false');
            } else {
                box.classList.remove('collapsed');
                content.style.maxHeight = `${content.scrollHeight}px`;
                toggle.setAttribute('aria-expanded', 'true');
            }
        };

        applyState(initialCollapsed);

        toggle.addEventListener('click', () => {
            const collapsed = box.classList.toggle('collapsed');
            toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            if (collapsed) {
                content.style.maxHeight = '0px';
            } else {
                content.style.maxHeight = `${content.scrollHeight}px`;
            }
            if (storageKey) {
                collapseBoxStates[storageKey] = collapsed;
                saveCollapseStates();
            }
        });
    }

    function refreshCollapseContentHeight(box, content) {
        if (!box || !content || box.classList.contains('collapsed')) return;
        content.style.maxHeight = `${content.scrollHeight}px`;
    }

    initializeCollapseBox(savedTemplatesBox, savedTemplatesToggle, savedTemplatesContent, 'savedTemplates', false);
    initializeCollapseBox(systemTemplatesBox, systemTemplatesToggle, systemTemplatesContent, 'systemTemplates', false);

    window.addEventListener('focus', () => modalManager.forceUnlock());
    window.addEventListener('blur', () => setTimeout(() => modalManager.forceUnlock(), 200));
    
    
    // --- STATE VARIABLES ---
    let savedTemplates = {};
    let templateVariables = {};
    let pendingResponses = {};
    let promptManuallyEdited = false;
    let systemTemplates = { templates: {}, variables: {} };
    let attachedFileContent = ''; // Здесь будет храниться текст из файла
    // --- STATUS INDICATOR LOGIC ---
    // New 9-state model mapping. Keep backward compatibility with older keys.
    const statusClassMap = {
        // Primary lifecycle states
        'IDLE': '',                 // not active
        'INITIALIZING': 'initializing',
        'INJECTING': 'generating',
        'PROMPT_READY': 'prompt-ready',
        'READY': 'success',
        'PROMPT_TO_LLM': 'generating',
        'SENDING': 'sending',
        'RECEIVING': 'receiving',

        // Terminal / outcome states
        'SUCCESS': 'success',
        'COMPLETE': 'success',
        'PARTIAL': 'warning',
        'STREAM_TIMEOUT_HIDDEN': 'warning',
        'RECOVERABLE_ERROR': 'error',
        'CRITICAL_ERROR': 'error',
        'NO_SEND': 'error',
        'EXTRACT_FAILED': 'error',
        'STREAM_TIMEOUT': 'error',

        // Backwards-compatible aliases (existing code might still emit these)
        'GENERATING': 'generating',
        'COPY_SUCCESS': 'success',
        'ERROR': 'error',
        'CIRCUIT_OPEN': 'error',
        'UNRESPONSIVE': 'error',
        'API_MODE': 'api-mode',
        'API_PENDING': 'api-mode',
        'API_FAILED': 'error'
    };

    function resolveIndicatorTooltip(status, data = {}) {
        // Human-friendly tooltips for the 9-state model; keep fallbacks for legacy keys
        switch (status) {
            case 'IDLE':
                return 'Ready';
            case 'INITIALIZING':
                return 'Search selector';
            case 'READY':
            case 'PROMPT_READY':
                return 'Wait send';
            case 'PROMPT_TO_LLM':
                return 'Prompt --> LLM';
            case 'SENDING':
                return 'Sending';
            case 'RECEIVING':
                return 'Получение ответа';
            case 'SUCCESS':
            case 'COMPLETE':
                return 'Complete';
            case 'PARTIAL':
                return 'Partial';
            case 'STREAM_TIMEOUT_HIDDEN':
                return 'Partial (timeout)';
            case 'RECOVERABLE_ERROR':
                return 'Error';
            case 'CRITICAL_ERROR':
                return 'Error';
            case 'NO_SEND':
                return 'Send failed';
            case 'EXTRACT_FAILED':
                return 'Extract failed';
            case 'STREAM_TIMEOUT':
                return 'Stream timeout';
            // legacy/alias fallbacks
            case 'GENERATING':
                return 'Prompt --> LLM';
            case 'INJECTING':
                return 'Injecting';
            case 'COPY_SUCCESS':
                return 'Complete';
            case 'ERROR': {
                return 'Error';
            }
            case 'CIRCUIT_OPEN':
                return 'Error';
            case 'UNRESPONSIVE':
                return 'Error';
            case 'API_MODE':
                return 'Ready';
            case 'API_PENDING':
                return 'Search selector';
            case 'API_FAILED':
                return 'Error';
            default:
                return 'Ready';
        }
    }

    function updateModelStatusUI(llmName, status, data = {}) {
        const normalizedName = (llmName || '').trim();
        const indicators = document.querySelectorAll(`.status-indicator[data-llm-name="${normalizedName}"]`);
        if (!indicators.length) return;

        indicators.forEach((indicator) => {
            const pipelineBlock = indicator.closest('.model-block');
            if (pipelineBlock) {
                const inputCb = pipelineBlock.querySelector('.model-input-checkbox');
                if (!inputCb || !inputCb.checked) {
                    indicator.className = 'status-indicator';
                    indicator.title = '';
                    return;
                }
            }
            indicator.className = 'status-indicator';
            const mappedClass = statusClassMap[status];
            if (mappedClass) {
                indicator.classList.add(mappedClass);
            }
            indicator.title = resolveIndicatorTooltip(status, data);
        });

        if (Object.prototype.hasOwnProperty.call(data, 'apiStatus')) {
            setApiIndicatorState(normalizedName, data.apiStatus, data);
        }
    }
    // --- END STATUS INDICATOR LOGIC ---

    // --- TEST / SMOKE HARNESS ---
    // Non-intrusive helper to validate STATUS_UPDATE rendering.
    // Usage:
    //  - From console: runStatusIndicatorSmokeTest();
    //  - Or set window.__LLM_RESULTS_DEBUG__ = true before loading to auto-run once.
    function runStatusIndicatorSmokeTest() {
        try {
            const testName = `__llm_test_${Date.now()}`;
            // create a temp indicator in the DOM (mirrors markup in result_new.html)
            const container = document.createElement('div');
            container.style.position = 'fixed';
            container.style.bottom = '6px';
            container.style.right = '6px';
            container.style.zIndex = '99999';
            container.id = testName;
            container.innerHTML = `<span class="status-indicator" data-llm-name="${testName}"></span><span style="margin-left:8px;font-size:12px">Smoke test</span>`;
            document.body.appendChild(container);

            const statusesToTest = [
                'IDLE', 'INITIALIZING', 'SENDING', 'RECEIVING', 'SUCCESS',
                'RECOVERABLE_ERROR', 'CRITICAL_ERROR', 'GENERATING', 'ERROR', 'no-answer'
            ];

            const results = [];
            statusesToTest.forEach((s) => {
                updateModelStatusUI(testName, s, { message: `msg for ${s}` });
                const el = document.querySelector(`.status-indicator[data-llm-name="${testName}"]`);
                const cls = el ? el.className : '(missing)';
                const title = el ? el.title : '(missing)';
                const pass = el && title && title.length > 0;
                results.push({ status: s, class: cls, title, pass });
            });

            console.group('[RESULTS] STATUS_INDICATOR SMOKE TEST');
            results.forEach(r => console.log(r));
            console.groupEnd();

            // cleanup after short delay to allow manual inspection
            setTimeout(() => {
                try { document.getElementById(testName)?.remove(); } catch (_) {}
            }, 3000);

            return results;
        } catch (err) {
            console.error('[RESULTS] Smoke test failed:', err);
            return null;
        }
    }

    // Auto-run once if explicitly opted-in (debug only)
    try {
        if (window.__LLM_RESULTS_DEBUG__ === true) {
            console.log('[RESULTS] Auto-running status indicator smoke test (debug flag set)');
            setTimeout(runStatusIndicatorSmokeTest, 600);
        }
    } catch (_) {}
    // --- END TEST / SMOKE HARNESS ---

    promptInput.addEventListener('input', () => {
        if (templateSelect.value !== 'manual') {
            promptManuallyEdited = true;
        }
    });

    // --- MAIN PAGE LOGIC ---
    chrome.runtime.sendMessage({ type: 'REGISTER_RESULTS_TAB' });

    if (autoCheckbox) {
        autoCheckbox.addEventListener('change', () => {
            autoMode = autoCheckbox.checked;
            if (syncAutoToggleState) syncAutoToggleState();
            console.log('[RESULTS] Auto mode:', autoMode);
        });
    }

    if (getItButton) {
        getItButton.disabled = true;
    }

    startButton.disabled = false;

        //-- 1.1. Скрываем секцию Comparative Analysis при инициализации --//
    if (comparisonSection) {
        comparisonSection.classList.add('hidden');
        comparisonSection.setAttribute('aria-hidden', 'true');
    }
    if (comparisonOutput) {
        comparisonOutput.innerHTML = '';
    }


    function storeResponseForManualMode(llmName, answer, html = '') {
        if (answer && typeof answer === 'object') {
            pendingResponses[llmName] = answer;
            return;
        }
        pendingResponses[llmName] = {
            text: String(answer ?? ''),
            html: String(html || '')
        };
        console.log(`[RESULTS] Stored response from ${llmName} (manual mode)`);
    }

    // NEW: Функция для конвертации текста с markdown в HTML
    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function normalizeLineEndings(text) {
        return (text || '').replace(/\r\n/g, '\n');
    }

    function removeExactBlock(source, block) {
        if (!source || !block) return source;
        const normalizedBlock = normalizeLineEndings(block).trim();
        if (!normalizedBlock) return source;
        if (source.startsWith(normalizedBlock)) {
            return source.slice(normalizedBlock.length).trim();
        }
        return source.replace(normalizedBlock, '').trim();
    }

    function sanitizeFinalAnswer(answer) {
        if (!answer) return '';

        let working = normalizeLineEndings(answer).trim();
        if (!working) return '';

        if (lastEvaluationPromptNormalized) {
            const promptBody = normalizeLineEndings(lastEvaluationPromptNormalized).trim();
            if (promptBody) {
                if (working.startsWith(promptBody)) {
                    working = working.slice(promptBody.length).trim();
                } else {
                    const promptIndex = working.indexOf(promptBody);
                    if (promptIndex !== -1) {
                        working = (working.slice(0, promptIndex) + working.slice(promptIndex + promptBody.length)).trim();
                    }
                }
            }
        }

        if (lastResponsesListNormalized) {
            const responsesBody = normalizeLineEndings(lastResponsesListNormalized).trim();
            if (responsesBody) {
                working = working.split(responsesBody).join(' ').trim();
            }
        }

        if (lastEvaluationPrefixNormalized) {
            working = removeExactBlock(working, lastEvaluationPrefixNormalized);
        }
        if (lastEvaluationSuffixNormalized) {
            working = removeExactBlock(working, lastEvaluationSuffixNormalized);
        }

        const instructionSnippets = [
            'Compare the following responses to the question',
            'Responses for analysis:',
            'Select the best response, briefly explain why, and present the result as a detailed, structured bulleted list. The evaluation must be comprehensive, considering relevance, detail, usefulness, and accuracy.',
            'can make mistakes. Please double-check responses.'
        ];

        instructionSnippets.forEach((snippet) => {
            const normalizedSnippet = normalizeLineEndings(snippet).trim();
            if (!normalizedSnippet) return;
            const regex = new RegExp(escapeRegExp(normalizedSnippet), 'gi');
            working = working.replace(regex, ' ').trim();
        });

        const separator = '-------------------------';
        const lastSeparatorIndex = working.lastIndexOf(separator);
        if (lastSeparatorIndex !== -1) {
            const afterSeparator = working.slice(lastSeparatorIndex + separator.length).trim();
            if (afterSeparator) {
                working = afterSeparator;
            } else {
                working = working.slice(0, lastSeparatorIndex).trim();
            }
        }

        working = working.replace(/[ \t]{2,}/g, ' ');
        working = working.replace(/\n{3,}/g, '\n\n').trim();

        return working;
    }

    function convertMarkdownToHTML(text) {
        if (!text) return '';
        
        // Сохраняем HTML теги, если они есть
        let html = text;
        
        // Конвертация markdown форматирования
        // Жирный текст **текст** или __текст__
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
        
        // Курсив *текст* или _текст_
        html = html.replace(/\*(.+?)\*(?!\*)/g, '<em>$1</em>');
        html = html.replace(/_(.+?)_(?!_)/g, '<em>$1</em>');
        
        // Заголовки
        html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
        
        // Списки (маркированные)
        html = html.replace(/^\* (.+)$/gm, '<li>$1</li>');
        html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
        
        // Списки (нумерованные)
        html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
        
        // Обернуть последовательные <li> в <ul>
        html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => {
            return '<ul>' + match + '</ul>';
        });
        
        // Код инлайн `код`
        html = html.replace(/`(.+?)`/g, '<code>$1</code>');
        
        // Блоки кода ```код```
        html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
        
        // Переносы строк
        html = html.replace(/\n\n/g, '</p><p>');
        html = html.replace(/\n/g, '<br>');
        
        // Обернуть в параграфы, если еще не обернуто
        if (!html.startsWith('<')) {
            html = '<p>' + html + '</p>';
        }
        
        return html;
    }

    // Listen for messages from the background script
    // Listen for messages from the background script
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        try {
            switch (message.type) {
                case 'LLM_JOB_CREATED':
                    mergeLLMMetadata(message.llmName, {
                        requestId: message.requestId || null,
                        url: message.metadata?.url || '',
                        createdAt: message.metadata?.createdAt || message.metadata?.timestamp || Date.now(),
                        completedAt: message.metadata?.completedAt || null
                    }, { reset: true });
                    break;
                case 'LLM_PARTIAL_RESPONSE':
                    if (autoMode) {
                        updateLLMPanelOutput(message.llmName, message.answer, message.answerHtml || message.html || '');
                    } else {
                        storeResponseForManualMode(message.llmName, message.answer, message.answerHtml || message.html || '');
                    }
                    pipelineWaiter.handleResponse(message.llmName, message.answer);
                    if (message.metadata || message.requestId) {
                        mergeLLMMetadata(message.llmName, {
                            requestId: message.requestId,
                            url: message.metadata?.url,
                            createdAt: message.metadata?.createdAt || message.metadata?.timestamp,
                            completedAt: message.metadata?.completedAt
                        });
                    }
                    if (Array.isArray(message.logs)) {
                        ingestLogs(message.llmName, message.logs);
                    }
                    if (typeof message.answer === 'string' && message.answer.trim().startsWith('Error:')) {
                        const errorDetails = message.answer.replace(/^Error:\s*/i, '').trim() || 'Ошибка повторной отправки';
                        settleManualResend(message.llmName, 'error', errorDetails);
                    } else {
                        settleManualResend(message.llmName, 'success', 'Ответ обновлен');
                    }
                    break;
                // --- V2.0 START: Status Update Handler ---
                case 'STATUS_UPDATE':
                    updateModelStatusUI(message.llmName, message.status, message.data || {});
                    if (Array.isArray(message.logs)) {
                        ingestLogs(message.llmName, message.logs);
                    }
                    if (['ERROR', 'UNRESPONSIVE', 'CIRCUIT_OPEN', 'NO_SEND', 'EXTRACT_FAILED', 'STREAM_TIMEOUT'].includes(message.status)) {
                        settleManualResend(message.llmName, 'error', (message.data && message.data.message) || 'Ошибка повторной отправки');
                    }
                    break;
                // --- V2.0 END: Status Update Handler ---
                case 'PROCESS_COMPLETE':
                    if (comparisonSpinner) comparisonSpinner.style.display = 'none';
                    const cleanedAnswer = sanitizeFinalAnswer(message.finalAnswer || '');
                    pendingJudgeAnswer = cleanedAnswer;
                    pendingJudgeHTML = cleanedAnswer
                        ? convertMarkdownToHTML(cleanedAnswer)
                        : '<p class="comparison-placeholder">No evaluation response received.</p>';
                    if (comparisonOutput) {
                        comparisonOutput.innerHTML = pendingJudgeHTML;
                    }
                    lastEvaluationPromptNormalized = '';
                    lastEvaluationPrefixNormalized = '';
                    lastEvaluationSuffixNormalized = '';
                    lastResponsesListNormalized = '';
                    break;
                case 'STARTING_EVALUATION':
                    if (comparisonSpinner) comparisonSpinner.style.display = 'block';
                    if (comparisonOutput) {
                        comparisonOutput.innerHTML = '<p class="comparison-placeholder">Collecting responses for evaluation...</p>';
                    }
                    break;
                case 'UPDATE_LLM_PANEL_OUTPUT':
                    updateLLMPanelOutput(message.llmName, message.answer, message.answerHtml || message.html || '');
                    break;
                case 'LLM_DIAGNOSTIC_EVENT':
                    if (Array.isArray(message.logs) && message.logs.length) {
                        ingestLogs(message.llmName, message.logs);
                    } else if (message.event) {
                        ingestLogs(message.llmName, [message.event]);
                    }
                    break;
                case 'MANUAL_PING_RESULT':
                    if (message.status === 'success') {
                        setPingButtonState(message.llmName, 'success', 'Ответ обновлен');
                    } else if (message.status === 'failed') {
                        setPingButtonState(message.llmName, 'error', message.error || 'Ошибка пинга');
                    } else if (message.status === 'unchanged') {
                        setPingButtonState(message.llmName, 'unchanged', 'Ответ не изменился');
                    }
                    break;
                case 'SELECTOR_OVERRIDE_CLEARED':
                    if (message.success === false) {
                        updateDevToolsStatus(`Clear failed: ${message.error || 'unknown error'}`, 'error');
                    } else {
                        updateDevToolsStatus('Overrides & caches cleared', 'success');
                    }
                    refreshSavedOverridesList();
                    refreshSelectorAudit();
                    break;
                case 'SELECTOR_OVERRIDE_REFRESH_RESULT':
                    if (message.result?.success) {
                        updateDevToolsStatus('Remote selectors refreshed', 'success');
                    } else {
                        updateDevToolsStatus(`Refresh failed: ${message.result?.error || 'unknown error'}`, 'error');
                    }
                    refreshSavedOverridesList();
                    refreshSelectorAudit();
                    break;
                case 'PICKER_RESULT': {
                    if (!message.requestId || message.requestId !== activePickerRequestId) break;
                    activePickerRequestId = null;
                    const pickedEntry = activePickerEntry;
                    const pickedMode = activePickerMode;
                    activePickerEntry = null;
                    activePickerMode = null;
                    if (pickedEntry?.pickBtn) pickedEntry.pickBtn.disabled = false;
                    if (pickedEntry?.recordBtn) pickedEntry.recordBtn.disabled = false;
                    if (selectorPickBtn) selectorPickBtn.disabled = false;
                    if (pickerTimeoutId) {
                        clearTimeout(pickerTimeoutId);
                        pickerTimeoutId = null;
                    }
                    const payload = message.payload || {};
                    if (payload.ok === false) {
                        if (pickedEntry) {
                            if (pickedEntry.recordBtn) pickedEntry.recordBtn.classList.remove('is-active');
                            showSelectorsWorkbenchStatus(payload.error || 'Pick failed');
                        } else {
                            updateDevToolsStatus(payload.error || 'Выбор не удался', 'error');
                        }
                        break;
                    }
                    if (pickedEntry && payload.selector) {
                        if (pickedEntry.recordBtn) pickedEntry.recordBtn.classList.remove('is-active');
                        updateWorkbenchSelectorInput(pickedEntry, payload.selector);
                        testWorkbenchSelectorEntry(pickedEntry);
                        showSelectorsWorkbenchStatus(pickedMode === 'workbench-record' ? 'Recorded' : 'Picked');
                    } else if (selectorOverrideInput && payload.selector) {
                        selectorOverrideInput.value = payload.selector;
                        updateDevToolsStatus('Селектор сохранен в поле', 'success');
                    } else {
                        if (pickedEntry) {
                            if (pickedEntry.recordBtn) pickedEntry.recordBtn.classList.remove('is-active');
                            showSelectorsWorkbenchStatus('Selector not found');
                        } else {
                            updateDevToolsStatus('Селектор не найден', 'error');
                        }
                    }
                    break;
                }
                case 'PICKER_CANCELLED':
                    if (message.requestId && message.requestId !== activePickerRequestId) break;
                    const cancelledMode = activePickerMode;
                    activePickerRequestId = null;
                    if (activePickerEntry?.pickBtn) activePickerEntry.pickBtn.disabled = false;
                    if (activePickerEntry?.recordBtn) {
                        activePickerEntry.recordBtn.disabled = false;
                        activePickerEntry.recordBtn.classList.remove('is-active');
                    }
                    activePickerEntry = null;
                    activePickerMode = null;
                    if (selectorPickBtn) selectorPickBtn.disabled = false;
                    if (pickerTimeoutId) {
                        clearTimeout(pickerTimeoutId);
                        pickerTimeoutId = null;
                    }
                    if (cancelledMode === 'override') {
                        updateDevToolsStatus('Выбор отменен', 'warning');
                    } else if (selectorsWorkbenchStatus) {
                        showSelectorsWorkbenchStatus(cancelledMode === 'workbench-record' ? 'Record cancelled' : 'Pick cancelled');
                    } else {
                        updateDevToolsStatus('Выбор отменен', 'warning');
                    }
                    break;
            }
            try { sendResponse?.({ ok: true }); } catch (_) {}
        } catch (err) {
            console.error('[RESULTS] onMessage handler failed:', err);
            try { sendResponse?.({ ok: false, error: err?.message || String(err) }); } catch (_) {}
        }
    });
        
    function updateLLMPanelOutput(llmName, answer, answerHtml = '') {
        const panelId = llmName.toLowerCase().replace(/\s+/g, '');
        const panel = document.getElementById(`panel-${panelId}`);
        const payload = (() => {
            if (answer && typeof answer === 'object') {
                return {
                    text: String(answer.text || answer.answer || ''),
                    html: String(answer.html || answer.answerHtml || '')
                };
            }
            return {
                text: String(answer ?? ''),
                html: String(answerHtml || '')
            };
        })();
        const normalizedText = payload.text || '';
        const rawHtml = payload.html || '';
        const sanitizedHtml = sanitizeInlineHtml(rawHtml);
        const resolvedHtml = sanitizedHtml || (looksLikeHtml(normalizedText) ? sanitizeInlineHtml(normalizedText) : '');
        if (panel) {
            const outputElement = panel.querySelector('.output');
            if (outputElement) {
                outputElement.innerHTML = resolvedHtml || convertMarkdownToHTML(normalizedText);
                outputElement.style.maxHeight = '315px';
                outputElement.style.overflowY = 'auto';
                outputElement.style.overflowX = 'hidden';
                outputElement.style.wordWrap = 'break-word';
            }
        }
        if (normalizedText && !normalizedText.trim().startsWith('Error:')) {
            autoCollapseDiagnostics(llmName, normalizedText);
        }
        checkCompareButtonState();
    }

    //-- 2. Добавляем обработчик для кнопки "Copy All" --//
function collectLLMResponses() {
    const panels = document.querySelectorAll('.llm-panel');
    const entries = [];
    const htmlSections = [];
    panels.forEach(panel => {
        const titleEl = panel.querySelector('.llm-title') || panel.querySelector('h3');
        const outputEl = panel.querySelector('.output');
        const name = titleEl ? titleEl.textContent.trim() : panel.id.replace('panel-', '').toUpperCase();
        const htmlContent = outputEl ? sanitizeInlineHtml(outputEl.innerHTML || '').trim() : '';
        const text = htmlContent
            ? plainTextFromHtml(htmlContent)
            : (outputEl ? (outputEl.innerText || outputEl.textContent || '').trim() : '');
        const isErrorResponse = typeof text === 'string' && text.startsWith('Error:');
        if (isErrorResponse) {
            return;
        }
        const hasContent = htmlContent || text;
        if (hasContent) {
            const metadataLine = buildMetadataLine(name);
            const headerParts = [`=== ${name} ===`];
            if (metadataLine) {
                headerParts.push(metadataLine);
            }
            const htmlBlock = buildResponseCopyHtmlBlock(name, metadataLine, htmlContent, text);
            if (htmlBlock) {
                htmlSections.push(htmlBlock);
            }
            entries.push({
                name,
                text,
                html: htmlContent,
                metadataLine,
                formatted: `${headerParts.join('\n')}\n${text}`
            });
        }
    });
    const combinedText = entries.map(entry => entry.formatted).join('\n\n').trim();
    const combinedHTML = wrapResponsesHtmlBundle(htmlSections.join('\n'));
    return { entries, combinedText, combinedHTML };
}
function setPromptContent(text) {
    if (!promptInput) return;
    const nextValue = (text || '').trim();
    promptInput.value = '';
    promptInput.value = nextValue;
    promptInput.dispatchEvent(new Event('input', { bubbles: true }));
    if (useInputRichMode && editorState?.mode === 'PROMPT' && typeof applyRichInputContent === 'function') {
        applyRichInputContent({ text: nextValue, html: '' });
        if (typeof syncPromptViewMode === 'function') {
            syncPromptViewMode();
        }
    }
    promptInput.focus();
    try {
        promptInput.setSelectionRange(0, 0);
    } catch (err) {
        // ignore for unsupported inputs
    }
}

const handlePromptDragOver = (event) => {
    if (!promptInput) return;
    if (event?.dataTransfer) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    }
    promptContainer?.classList.add('is-attachment-drag');
};

const handlePromptDragLeave = () => {
    promptContainer?.classList.remove('is-attachment-drag');
};

const handlePromptDrop = (event) => {
    if (!promptInput) return;
    event.preventDefault();
    event.stopPropagation();
    promptContainer?.classList.remove('is-attachment-drag');
    tryAddTransferAttachments(event.dataTransfer);
};

const handlePromptPaste = (event) => {
    if (!promptInput) return;
    const clipboard = event.clipboardData;
    if (tryAddTransferAttachments(clipboard)) {
        event.preventDefault();
        return;
    }
    if (!clipboard) return;
    const html = clipboard.getData('text/html');
    if (!html) return;
    const plain = plainTextFromHtml(html);
    if (!plain) return;
    event.preventDefault();
    insertTextAtCursor(promptInput, plain);
};

const promptDragTargets = [promptContainer, promptInput, promptNoteView];
promptDragTargets.forEach((target) => {
    if (!target) return;
    target.addEventListener('dragover', handlePromptDragOver, true);
    target.addEventListener('dragenter', handlePromptDragOver, true);
    target.addEventListener('dragleave', handlePromptDragLeave, true);
    target.addEventListener('drop', handlePromptDrop, true);
});
promptNoteView?.addEventListener('paste', handlePromptPaste, true);
promptInput?.addEventListener('paste', handlePromptPaste, true);

const isPointInsidePrompt = (event) => {
    if (!promptContainer || !event) return false;
    const rect = promptContainer.getBoundingClientRect();
    const x = Number(event.clientX);
    const y = Number(event.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
};

const transferHasFiles = (transfer) => {
    if (!transfer) return false;
    if (transfer.files && transfer.files.length) return true;
    const items = Array.from(transfer.items || []);
    return items.some((item) => item?.kind === 'file');
};

document.addEventListener('dragover', (event) => {
    if (!transferHasFiles(event.dataTransfer)) return;
    if (!isPointInsidePrompt(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    promptContainer?.classList.add('is-attachment-drag');
}, true);

document.addEventListener('drop', (event) => {
    if (!transferHasFiles(event.dataTransfer)) return;
    if (!isPointInsidePrompt(event)) return;
    event.preventDefault();
    event.stopPropagation();
    promptContainer?.classList.remove('is-attachment-drag');
    tryAddTransferAttachments(event.dataTransfer);
}, true);

document.addEventListener('dragend', () => {
    promptContainer?.classList.remove('is-attachment-drag');
}, true);

document.addEventListener('dragover', (event) => {
    const target = event.target;
    if (!promptContainer || !target) return;
    if (!promptContainer.contains(target)) return;
    if (!event?.dataTransfer) return;
    const hasFiles = (event.dataTransfer.files && event.dataTransfer.files.length) ||
        Array.from(event.dataTransfer.items || []).some((item) => item?.kind === 'file');
    if (!hasFiles) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
}, true);

document.addEventListener('drop', (event) => {
    const target = event.target;
    if (!promptContainer || !target) return;
    if (!promptContainer.contains(target)) return;
    if (!event?.dataTransfer) return;
    const hasFiles = (event.dataTransfer.files && event.dataTransfer.files.length) ||
        Array.from(event.dataTransfer.items || []).some((item) => item?.kind === 'file');
    if (!hasFiles) return;
    event.preventDefault();
    event.stopPropagation();
}, true);

//-- 2. Добавляем обработчик для кнопки "Copy All" --//
document.addEventListener('click', async (event) => {
    const btn = event.target.closest('#copy-all-btn');
    if (!btn) return;

    const { combinedText, combinedHTML } = collectLLMResponses();
    if (!combinedText && !combinedHTML) {
        flashButtonFeedback(btn, 'warn');
        return;
    }

    try {
        await writeRichContentToClipboard({
            text: combinedText,
            html: combinedHTML
        });
        flashButtonFeedback(btn, 'success');
    } catch (err) {
        console.error('[COPY ALL ERROR]', err);
        flashButtonFeedback(btn, 'error');
    }
});

//-- 2.2. Обработчик кнопки "Очистить все ответы" 
document.addEventListener('click', (event) => {
  const btn = event.target.closest('#clear-all-btn');
  if (!btn) return;

  // Собираем все элементы вывода внутри LLM панелей
  const outputs = document.querySelectorAll('.llm-panel .output');
  let clearedAny = false;

  outputs.forEach(outputEl => {
    // Полная очистка содержимого
    outputEl.innerHTML = '';
    outputEl.textContent = '';
    // Триггерим input чтобы другие слушатели обновились
    outputEl.dispatchEvent(new Event('input', { bubbles: true }));
    clearedAny = true;
  });

  // Обновляем состояние UI (если есть такая функция)
  try { if (typeof checkCompareButtonState === 'function') checkCompareButtonState(); } catch (e) { /* noop */ }

  flashButtonFeedback(btn, clearedAny ? 'success' : 'error');
  if (!clearedAny) console.warn('[RESULTS] clear-all: no outputs found to clear');
});



//-- Дополнительные действия с собранными ответами --//
document.addEventListener('click', (event) => {
    const btn = event.target.closest('#use-as-input-btn');
    if (!btn) return;

    const { combinedText, combinedHTML } = collectLLMResponses();
    if (!combinedText && !combinedHTML) {
        flashButtonFeedback(btn, 'warn');
        return;
    }

    const responsesBlock = buildLLMResponsesBlock();
    const textPayload = responsesBlock || combinedText;
    if (typeof applyRichInputContent === 'function') {
        useInputRichMode = true;
        applyRichInputContent({ text: textPayload, html: combinedHTML || '', textOverride: textPayload });
        if (typeof syncPromptViewMode === 'function') {
            syncPromptViewMode();
        }
    } else if (textPayload) {
        setPromptContent(textPayload);
    } else {
        flashButtonFeedback(btn, 'warn');
        return;
    }

    flashButtonFeedback(btn, 'success');
});

//- 1.2. Новый, более надёжный обработчик очистки ответа модели -//
document.addEventListener('click', (event) => {
    const btn = event.target.closest('.panel-clear-response-btn');
    if (!btn) return;

    // 1) Попытка по data-target
    let targetId = (btn.dataset && btn.dataset.target) ? btn.dataset.target.trim() : '';
    let outputEl = targetId ? document.getElementById(targetId) : null;

    // 2) Фоллбек: ищем output внутри той же панели (.llm-panel)
    if (!outputEl) {
        const panel = btn.closest('.llm-panel') || btn.closest('.panel') || null;
        if (panel) {
            outputEl = panel.querySelector('.output') || null;
            // если output найден, обновим targetId для логов / дебага
            if (outputEl && outputEl.id) targetId = outputEl.id;
        }
    }

    // 3) Финальный фоллбек: пробуем угадать id по названию модели в заголовке
    if (!outputEl) {
        try {
            const header = btn.closest('.llm-header') || btn.closest('.header-right')?.parentElement || null;
            const title = header ? (header.querySelector('.llm-title') || header.querySelector('h3')) : null;
            if (title) {
                const guessed = `output-${(title.textContent || '').trim().toLowerCase().replace(/\s+/g, '')}`;
                outputEl = document.getElementById(guessed) || null;
                if (outputEl) targetId = guessed;
            }
        } catch (e) {
            // ignore
        }
    }

    // 4) Если всё ещё не нашли — фейл с визуальным фидбеком
    if (!outputEl) {
        console.warn('[RESULTS] clear button: could not locate output element for', btn, 'data-target=', btn.dataset.target);
        flashButtonFeedback(btn, 'error');
        return;
    }

    // 5) Очищаем
    outputEl.innerHTML = '';
    outputEl.textContent = '';
    // триггерим input чтобы другие слушатели обновились
    outputEl.dispatchEvent(new Event('input', { bubbles: true }));

    // 6) Обновляем состояние UI (если есть соответствующие функции)
    try { if (typeof checkCompareButtonState === 'function') checkCompareButtonState(); } catch (e) { /* noop */ }

    // 7) Визуальный фидбек на кнопке
    flashButtonFeedback(btn, 'success');
});
//-- конец блока --//

document.addEventListener('click', (event) => {
    const btn = event.target.closest('#clear-prompt-btn');
    if (!btn) return;

    useInputRichMode = false;
    if (typeof syncPromptViewMode === 'function') {
        syncPromptViewMode();
    }
    setPromptContent('');
    if (promptNoteView && promptContainer?.classList.contains('is-note-viewing')) {
        promptNoteView.innerHTML = '';
    }
    if (setPromptEditorMode && editorState?.mode && editorState.mode !== 'PROMPT') {
        setPromptEditorMode('PROMPT');
    }
    if (typeof clearAllSelectedModifiers === 'function') {
        clearAllSelectedModifiers();
    }
    // Очищаем прикреплённые файлы вместе с текстом и модификаторами
    try {
        attachedFiles.splice(0, attachedFiles.length);
        attachmentKeys.clear();
        renderPromptAttachments && renderPromptAttachments();
    } catch (_) {}
});

// -- Кнопка копирования содержимого поля prompt --
document.addEventListener('click', async (event) => {
    const btn = event.target.closest('#prompt-copy-btn');
    if (!btn) return;

    const promptEl = document.getElementById('prompt-input');
    if (!promptEl) return;

    const text = applySelectedModifiersToPrompt(promptEl.value || '').trim();

    if (!text) {
        // краткий фидбек, если поле пустое
        flashButtonFeedback(btn, 'warn');
        return;
    }

    // Используем Clipboard API с fallback
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            // Fallback: временный textarea
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        // Успех — короткий флеш
        flashButtonFeedback(btn, 'success');
    } catch (err) {
        console.error('Copy failed', err);
        flashButtonFeedback(btn, 'error');
    }
});

//-- 3.1. Обновляем обработчик для экспорта полного промпта в JSON --//
document.addEventListener('click', async (event) => {
    const btn = event.target.closest('#prompt-export-json-btn');
    if (!btn) return;

    const promptEl = document.getElementById('prompt-input');
    if (!promptEl) return;

    const baseText = (promptEl.value || '').trim();

    // Собираем полный текст промпта с префиксами и суффиксами
    const fullPromptText = applySelectedModifiersToPrompt(baseText, { includeResponses: true });

    if (!fullPromptText) {
        flashButtonFeedback(btn, 'warn');
        return;
    }

    // Формируем объект для экспорта в JSON
    const dataToExport = {
        prompt: fullPromptText,
        timestamp: new Date().toISOString()
    };
    const dataStr = JSON.stringify(dataToExport, null, 2); // null, 2 для красивого форматирования

    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
    
    // Меняем расширение файла на .json
    a.download = `Prompt ${dateStr}.json`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    flashButtonFeedback(btn, 'success');
});

document.addEventListener('click', async (event) => {
    const btn = event.target.closest('#prompt-export-html-btn');
    if (!btn) return;

    const promptEl = document.getElementById('prompt-input');
    if (!promptEl) return;

    const baseText = (promptEl.value || '').trim();
    const richActive = promptContainer?.classList.contains('is-note-viewing');
    const richHtml = promptNoteView ? sanitizeInlineHtml(promptNoteView.innerHTML || '').trim() : '';
    const richText = promptNoteView
        ? String(promptNoteView.innerText || promptNoteView.textContent || '').trim()
        : '';
    const hasRichContent = !!(richActive && (richHtml || richText));
    let bodyHtml = '';
    if (hasRichContent) {
        bodyHtml = richHtml || buildHtmlFromText(richText);
    } else {
        const fullPromptText = applySelectedModifiersToPrompt(baseText, { includeResponses: true });
        if (!fullPromptText) {
            flashButtonFeedback(btn, 'warn');
            return;
        }
        bodyHtml = `<pre>${escapeHtml(fullPromptText)}</pre>`;
    }

    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Prompt Export</title>
    <style>
        body { font-family: sans-serif; line-height: 1.6; padding: 2em; }
        pre { white-space: pre-wrap; word-wrap: break-word; background: #f4f4f4; padding: 1em; border-radius: 5px; }
    </style>
</head>
<body>
    ${bodyHtml}
</body>
</html>`;

    // 3. Скачиваем файл
    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
    
    a.download = `Prompt ${dateStr}.html`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    flashButtonFeedback(btn, 'success');
});


//-- 1.1. Исправляем экспорт всех ответов в HTML и формат имени файла --//
document.addEventListener('click', (event) => {
    const btn = event.target.closest('#export-html-btn');
    if (!btn) return;

    const promptEl = document.getElementById('prompt-input');
    const basePromptText = (promptEl?.value || '').trim();
    let promptBlock = '';
    if (basePromptText) {
        const fullPrompt = applySelectedModifiersToPrompt(basePromptText, { includeResponses: true }) || '';
        promptBlock = fullPrompt.replace(/<Ответы LLM-моделей>[\s\S]*?<\/>/gi, '').trim();
    }

    const { entries } = collectLLMResponses();
    if (!entries.length) {
        flashButtonFeedback(btn, 'warn');
        return;
    }

    const htmlSections = entries.map(({ name, text, metadataLine }) => `
        <section>
            <h2>${escapeHtml(name)}</h2>
            ${metadataLine ? `<p class="response-meta">${escapeHtml(metadataLine)}</p>` : ''}
            <pre>${escapeHtml(text)}</pre>
        </section>
    `).join('\n');

    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>LLM Responses Export</title>
    <style>
        body { font-family: Arial, sans-serif; background: #ffffff; color: #111; padding: 24px; line-height: 1.5; }
        section { margin-bottom: 24px; }
        h2 { margin: 0 0 12px; font-size: 20px; }
        pre { background: #f6f8fa; padding: 12px; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; }
        .response-meta { margin: 0 0 12px; color: #555; font-size: 14px; }
    </style>
</head>
<body>
${promptBlock ? `
    <section>
        <h2>Prompt</h2>
        <pre>${escapeHtml(promptBlock)}</pre>
    </section>
    <hr>
` : ''}
    <h2>Ответы LLM-моделей</h2>
${htmlSections}
</body>
</html>`;

    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    // Формируем имя файла "Ответы LLM-s <date>.html"
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
    a.download = `Ответы LLM-s ${dateStr}.html`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    flashButtonFeedback(btn, 'success');
});

document.addEventListener('click', (event) => {
    const btn = event.target.closest('.panel-use-input-btn');
    if (!btn) return;

    const targetId = btn.dataset.target;
    const outputEl = targetId ? document.getElementById(targetId) : null;
    const rawHtml = outputEl ? outputEl.innerHTML || '' : '';
    const sanitizedHtml = rawHtml ? sanitizeInlineHtml(rawHtml) : '';
    const text = sanitizedHtml
        ? plainTextFromHtml(sanitizedHtml)
        : (outputEl ? (outputEl.innerText || outputEl.textContent || '').trim() : '');

    if (!text && !sanitizedHtml) {
        flashButtonFeedback(btn, 'warn');
        return;
    }
    if (typeof applyRichInputContent === 'function') {
        useInputRichMode = true;
        applyRichInputContent({ text, html: sanitizedHtml });
        if (typeof syncPromptViewMode === 'function') {
            syncPromptViewMode();
        }
    } else if (text) {
        setPromptContent(text);
    } else {
        flashButtonFeedback(btn, 'warn');
        return;
    }

    flashButtonFeedback(btn, 'success');
});

//-- 1.1. Модифицируем экспорт для добавления имени модели-судьи --//
document.addEventListener('click', (event) => {
    const btn = event.target.closest('.panel-export-html-btn');
    if (!btn) return;

    const targetId = btn.dataset.target;
    const outputEl = targetId ? document.getElementById(targetId) : null;
    const text = outputEl ? outputEl.innerText.trim() : '';

    if (!text) {
        flashButtonFeedback(btn, 'warn');
        return;
    }

    const modelName = btn.dataset.name || 'Model';
    const metadataLine = buildMetadataLine(modelName);
    const metadataHtml = metadataLine ? `<p class="response-meta">${escapeHtml(metadataLine)}</p>` : '';
    let htmlBodyContent; // Создаем переменную для тела HTML

    // Проверяем, является ли это панелью Comparative Analysis
    if (modelName === 'Comparative Analysis') {
        const judgeName = evaluatorSelect ? evaluatorSelect.value : 'Unknown';
        htmlBodyContent = `
            <h1>${escapeHtml(modelName)}</h1>
            <h3 style="color: #555; font-weight: normal;">Generated by: ${escapeHtml(judgeName)}</h3>
            ${metadataHtml}
            <pre>${escapeHtml(text)}</pre>
        `;
    } else {
        // Стандартная логика для всех остальных панелей
        htmlBodyContent = `
            <h1>${escapeHtml(modelName)} Response</h1>
            ${metadataHtml}
            <pre>${escapeHtml(text)}</pre>
        `;
    }

    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${escapeHtml(modelName)} Response</title>
    <style>
        body { font-family: Arial, sans-serif; background: #ffffff; color: #111; padding: 24px; line-height: 1.5; }
        h1 { font-size: 24px; margin-bottom: 8px; }
        h3 { font-size: 16px; margin-top: 0; margin-bottom: 20px; }
        pre { background: #f6f8fa; padding: 12px; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; }
        .response-meta { margin: 0 0 12px; color: #555; font-size: 14px; }
    </style>
</head>
<body>
    ${htmlBodyContent}
</body>
</html>`;

    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;

    const modelForFile = String(modelName || 'Model').replace(/[\/\\:?<>|*"']/g, '').trim() || 'Model';
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
    const fileBase = `Ответ ${modelForFile} - ${dateStr}`;
    anchor.download = `${fileBase.replace(/[\/\\:?<>|*"']/g, '').trim()}.html`;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);

    flashButtonFeedback(btn, 'success');
});


        //-- 3. Добавляем обработчик кнопок копирования --//
        document.addEventListener('click', async (event) => {
            const btn = event.target.closest('.copy-btn');
            if (!btn) return;

            const targetId = btn.dataset.target;
            const outputEl = document.getElementById(targetId);
            if (!outputEl) return;

            const text = (outputEl.innerText || '').trim();
            const html = (outputEl.innerHTML || '').trim();
            if (!text && !html) {
                flashButtonFeedback(btn, 'warn');
                return;
            }

            try {
                await writeRichContentToClipboard({ text, html });
                flashButtonFeedback(btn, 'success');
            } catch (err) {
                console.error('[COPY ERROR]', err);
                flashButtonFeedback(btn, 'error');
            }
        });

function checkCompareButtonState() {
    const activeLLMs = getSelectedLLMs();
    let responsesCount = 0;
    activeLLMs.forEach(llm => {
        const outputId = llm.toLowerCase().replace(/\s+/g, '');
        const outputElement = document.getElementById(`output-${outputId}`);
        const output = outputElement ? outputElement.textContent : '';
        if(output && !output.startsWith("Error:")) {
            responsesCount++;
        }
    });
compareButton.disabled = responsesCount < 2;
if (smartCompareButton) { // Добавляем проверку на случай, если элемента нет
    smartCompareButton.disabled = responsesCount < 2;
}
}

    function getSelectedLLMs() {
        const selected = [];
        const nameMap = {
            'gpt': 'GPT', 'gemini': 'Gemini', 'claude': 'Claude',
            'grok': 'Grok', 'lechat': 'Le Chat', 'qwen': 'Qwen',
            'deepseek': 'DeepSeek', 'perplexity': 'Perplexity'
        };
        llmButtons.forEach(button => {
            if (button.classList.contains('active')) {
                const idName = button.id.replace('llm-', '');
                if (nameMap[idName]) {
                    selected.push(nameMap[idName]);
                }
            }
        });
        return selected;
    }
    if (window.ResultsShared && !window.ResultsShared.getSelectedLLMs) {
        window.ResultsShared.getSelectedLLMs = getSelectedLLMs;
    }

    //-- 2.1. Выносим функцию сборки промпта в общую область видимости --//
    function buildLLMResponsesBlock() {
        const { combinedText } = collectLLMResponses();
        if (!combinedText) return '';
        return `<Ответы LLM-моделей>\n${combinedText}\n</>`;
    }

    function wrapResponsesBlock(content = '') {
        const trimmed = (content || '').trim();
        if (!trimmed) return '';
        return `<Ответы LLM-моделей>\n${trimmed}\n</>`;
    }

    function splitPromptAndEmbeddedResponses(rawText = '') {
        const text = rawText || '';
        if (!text.trim()) {
            return { promptCore: '', embeddedResponses: '' };
        }

        const tagRegex = /<Ответы LLM-моделей>\s*([\s\S]*?)\s*<\/>/i;
        const tagMatch = text.match(tagRegex);
        if (tagMatch) {
            const withoutTag = (text.slice(0, tagMatch.index) + text.slice(tagMatch.index + tagMatch[0].length)).trim();
            return {
                promptCore: withoutTag,
                embeddedResponses: tagMatch[1].trim()
            };
        }

        const lines = text.split('\n');
        let splitIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().startsWith('===')) {
                splitIndex = i;
                break;
            }
        }

        if (splitIndex === -1) {
            return { promptCore: text.trim(), embeddedResponses: '' };
        }

        const promptCore = lines.slice(0, splitIndex).join('\n').trim();
        const embedded = lines.slice(splitIndex).join('\n').trim();
        return { promptCore, embeddedResponses: embedded };
    }

    function applySelectedModifiersToPrompt(baseText, options = {}) {
        const includeResponses = !!options.includeResponses;
        const wrapPromptTag = options.wrapPromptTag !== false;
        const prefixParts = [];
        const suffixParts = [];
        const { promptCore, embeddedResponses } = splitPromptAndEmbeddedResponses(baseText);

        if (selectedModifierIds && selectedModifierIds.length > 0) {
            const selected = selectedModifierIds
                .map(id => modifiersById[id])
                .filter(Boolean);

            selected.forEach(mod => {
                let cleanText = getEffectiveModifierText(mod);

                if (!cleanText) return;

                const categoryLabel = (mod.groupLabel || '').trim() ||
                    (mod.type === 'suffix' ? 'Output' : 'Instruction');
                const formatted = `<${categoryLabel}: ${cleanText}>`;

                if (mod.type === 'suffix') {
                    suffixParts.push(formatted);
                } else {
                    prefixParts.push(formatted);
                }
            });
        }

        const finalParts = [];
        prefixParts.forEach(part => finalParts.push(part));

        if (promptCore) {
            if (wrapPromptTag) {
                finalParts.push(`<Prompt>\n${promptCore}\n</Prompt>`);
            } else {
                finalParts.push(promptCore);
            }
        }

        if (includeResponses) {
            let responsesBlock = buildLLMResponsesBlock();
            if (!responsesBlock && embeddedResponses) {
                responsesBlock = wrapResponsesBlock(embeddedResponses);
            }
            if (responsesBlock) {
                finalParts.push(responsesBlock);
            }
        }

        suffixParts.forEach(part => finalParts.push(part));

        return finalParts.join('\n\n');
    }

    startButton.addEventListener('click', async () => {
        if (getItButton) {
            getItButton.disabled = true;
        }

        try {
            let finalPrompt = promptInput.value;
            if (!finalPrompt) {
                alert('Please enter a prompt.');
                return;
            }

            finalPrompt = applySelectedModifiersToPrompt(finalPrompt);
            const selectedLLMs = getSelectedLLMs();
            if (selectedLLMs.length === 0) {
                showNotification('Please select at least one LLM.');
                return;
            }

            const forceNewTabs = newPagesCheckbox ? newPagesCheckbox.checked : true;
            const useApiFallback = apiModeCheckbox ? apiModeCheckbox.checked : true;
            const attachmentsPayload = await buildAttachmentPayload();
            if (attachmentsPayload.length) {
                const unsupported = selectedLLMs.filter((name) => ATTACH_CAPABILITY[name] === false);
                if (unsupported.length) {
                    showNotification(`Эти LLM могут не поддерживать вложения: ${unsupported.join(', ')}`, 'warn');
                }
            }

            let response = null;
            try {
                response = await sendToBackground({
                    type: 'START_FULLPAGE_PROCESS',
                    prompt: finalPrompt,
                    selectedLLMs: selectedLLMs,
                    forceNewTabs,
                    useApiFallback,
                    attachments: attachmentsPayload
                });
            } catch (err) {
                console.warn('[RESULTS] Failed to start with attachments, retrying without them', err);
                response = await sendToBackground({
                    type: 'START_FULLPAGE_PROCESS',
                    prompt: finalPrompt,
                    selectedLLMs: selectedLLMs,
                    forceNewTabs,
                    useApiFallback
                });
            }

            if (!response || response.status !== 'process_started') {
                showNotification(`Запуск процесса: неожиданный ответ background (${response?.status || 'no_response'})`, 'warn');
            }

            if (forceNewTabs && newPagesCheckbox) {
                newPagesCheckbox.checked = false;
                storeNewPagesState(false);
            }
        } catch (err) {
            console.error('[RESULTS] Failed to start process', err);
            showNotification(`Не удалось отправить запрос: ${err?.message || String(err)}`, 'error');
        } finally {
            if (getItButton) {
                getItButton.disabled = false;
            }
        }
    });
    
if (getItButton) {
    getItButton.addEventListener('click', () => {
        if (getItButton.disabled) return;
        console.log('[RESULTS] Get Answers clicked: requesting latest responses from open LLM tabs');
        const selectedLLMs = getSelectedLLMs();
        selectedLLMs.forEach(llmName => {
            chrome.runtime.sendMessage({ 
                type: 'REQUEST_LLM_RESPONSE', 
                llmName: llmName 
            });
        });
        Object.keys(pendingResponses).forEach(llmName => {
            updateLLMPanelOutput(llmName, pendingResponses[llmName]);
        });
        pendingResponses = {};
        checkCompareButtonState();
    });
}

    function getSelectedJudgeSystemPrompt() {
        if (!judgeSystemPromptSelect || !judgeSystemPrompts.length) return null;
        const selectedId = judgeSystemPromptSelect.value;
        return judgeSystemPrompts.find((prompt) => prompt.id === selectedId) || judgeSystemPrompts[0] || null;
    }

    function buildJudgeEvaluationPrompt(systemPromptText = '', originalPrompt = '', responsesList = '') {
        const trimmedSystemPrompt = String(systemPromptText || '').trim();
        const trimmedOriginalPrompt = String(originalPrompt || '').trim();
        const trimmedResponses = String(responsesList || '').trim();

        if (!trimmedSystemPrompt) {
            return (prompts?.evaluationTemplate || '')
                .replace('{originalPrompt}', trimmedOriginalPrompt)
                .replace('{responsesList}', trimmedResponses)
                .trim();
        }

        let promptBody = trimmedSystemPrompt;
        const hasOriginalPlaceholder = promptBody.includes('{originalPrompt}');
        const hasResponsesPlaceholder = promptBody.includes('{responsesList}');

        if (hasOriginalPlaceholder) {
            promptBody = promptBody.replace('{originalPrompt}', trimmedOriginalPrompt);
        }
        if (hasResponsesPlaceholder) {
            promptBody = promptBody.replace('{responsesList}', trimmedResponses);
        }

        const parts = [promptBody];
        if (!hasOriginalPlaceholder && trimmedOriginalPrompt) {
            parts.push(`Запрос пользователя:\n${trimmedOriginalPrompt}`);
        }
        if (!hasResponsesPlaceholder && trimmedResponses) {
            parts.push(`Ответы для анализа:\n\n${trimmedResponses}`);
        }
        return parts.join('\n\n').trim();
    }



//-- 2.1. Обработчик для кнопки "Send" (оставляем отправку оценки, но НЕ показываем Comparative Analysis) --//
//- 1.1 replace compareButton handler -//
compareButton.addEventListener('click', () => {
    if (compareButton.disabled) return;
    if (!prompts || !prompts.evaluationTemplate) {
        console.error('[RESULTS] Evaluation template not loaded, using default');
        prompts = prompts || {};
        prompts.evaluationTemplate = "Compare the following responses to the question: \"{originalPrompt}\".\n\nResponses for analysis:\n\n{responsesList}\n\nSelect the best response, briefly explain why, and present the result as a detailed, structured bulleted list. The evaluation must be comprehensive, considering relevance, detail, usefulness, and accuracy.";
    }
    console.log('[RESULTS] Compare button clicked, preparing evaluation prompt.');

    // 1) Гарантируем, что секция Comparative Analysis скрыта при Send
    if (comparisonSection) {
        comparisonSection.classList.add('hidden');
        comparisonSection.setAttribute('aria-hidden', 'true');
    }

    // 2) Показываем только спиннер (секция Comparative Analysis остаётся скрытой до нажатия Smart)
    if (comparisonSpinner) comparisonSpinner.style.display = 'block';
    if (comparisonOutput) {
        comparisonOutput.innerHTML = '<p class="comparison-placeholder">Waiting for the judge response...</p>';
    }
    pendingJudgeAnswer = '';
    pendingJudgeHTML = '';

    // 3) Собираем ответы
    const activeLLMs = getSelectedLLMs();
    let responsesList = '';
    let validResponsesCount = 0;

    activeLLMs.forEach(llm => {
        const outputId = llm.toLowerCase().replace(/\s+/g, '');
        const outputElement = document.getElementById(`output-${outputId}`);
        const output = outputElement ? outputElement.textContent.trim() : '';

        if (output && !output.startsWith("Error:")) {
            responsesList += `-------------------------\n\n**${llm}:**\n${output}\n\n`;
            validResponsesCount++;
        }
    });

    // 4) Добавляем финальный разделитель для завершения списка
    if (validResponsesCount > 0) {
        responsesList += '-------------------------';
    }

    // 5) Проверка минимального количества ответов
    if (validResponsesCount < 2) {
        showNotification('Need at least two valid responses to compare.');
        if (comparisonSpinner) comparisonSpinner.style.display = 'none';
        return;
    }

    const originalPrompt = promptInput.value || 'the user\'s request';
    
    // 6) Формируем полный промпт для модели-оценщика
    const selectedSystemPrompt = getSelectedJudgeSystemPrompt();
    const evaluationPrompt = buildJudgeEvaluationPrompt(
        selectedSystemPrompt ? selectedSystemPrompt.text : '',
        originalPrompt,
        responsesList
    );

    const normalizedPrompt = normalizeLineEndings(evaluationPrompt).trim();
    const normalizedResponses = normalizeLineEndings(responsesList.trim());

    lastEvaluationPromptNormalized = normalizedPrompt;
    lastResponsesListNormalized = normalizedResponses;

    if (normalizedPrompt && normalizedResponses) {
        const responsesIndex = normalizedPrompt.indexOf(normalizedResponses);
        if (responsesIndex !== -1) {
            lastEvaluationPrefixNormalized = normalizedPrompt.slice(0, responsesIndex).trim();
            lastEvaluationSuffixNormalized = normalizedPrompt.slice(responsesIndex + normalizedResponses.length).trim();
        } else {
            lastEvaluationPrefixNormalized = '';
            lastEvaluationSuffixNormalized = '';
        }
    } else {
        lastEvaluationPrefixNormalized = '';
        lastEvaluationSuffixNormalized = '';
    }

    const selectedEvaluator = evaluatorSelect ? evaluatorSelect.value : 'Claude';
    
    console.log(`[RESULTS] Sending evaluation request to ${selectedEvaluator} (background, no focus change)`);
    console.log(`[RESULTS] Evaluation prompt length: ${evaluationPrompt.length} characters`);
    
    // 7) Отправляем сообщение в background.js с флагом openEvaluatorTab:false (чтобы вкладка судьи не открывалась)
    chrome.runtime.sendMessage({ 
        type: 'START_EVALUATION_WITH_PROMPT', 
        evaluationPrompt: evaluationPrompt,
        evaluatorLLM: selectedEvaluator,
        openEvaluatorTab: false
    });
});

//- end replace -//



    //-- 3.1. Обработчик кнопки "Smart": показывает Comparative Analysis ТОЛЬКО при нажатии Smart.
//-- Если результат оценки уже пришёл (comparisonOutput непустой) — показываем его.
//-- Иначе: fallback — копируем ответ из выбранной модели в секцию сравнения.
if (smartCompareButton) {
    smartCompareButton.addEventListener('click', () => {
        if (smartCompareButton.disabled) return;

        console.log('[RESULTS] Smart button clicked.');

        const evaluationReady = pendingJudgeAnswer && pendingJudgeAnswer.trim().length > 0;
        const hasComparisonContent = pendingJudgeHTML && pendingJudgeHTML.trim().length > 0;
        const spinnerActive = comparisonSpinner && comparisonSpinner.style.display === 'block';

        if (comparisonSection) {
            comparisonSection.classList.remove('hidden');
            comparisonSection.setAttribute('aria-hidden', 'false');
        }

        if (evaluationReady || hasComparisonContent) {
            if (comparisonOutput) {
                comparisonOutput.innerHTML = hasComparisonContent
                    ? pendingJudgeHTML
                    : convertMarkdownToHTML(pendingJudgeAnswer);
            }
            return;
        }

        if (spinnerActive) {
            return;
        }

        // Фоллбек: показываем готовый ответ выбранной модели (как до этого было)
        const selectedEvaluator = evaluatorSelect ? evaluatorSelect.value : 'Claude';
        const outputId = selectedEvaluator.toLowerCase().replace(/\s+/g, '');
        const outputElement = document.getElementById(`output-${outputId}`);

        // Показываем секцию перед выводом, чтобы пользователь видел результат
        if (comparisonSection) {
            comparisonSection.classList.remove('hidden');
            comparisonSection.setAttribute('aria-hidden', 'false');
        }

        if (!outputElement) {
            if (comparisonOutput) comparisonOutput.innerHTML = '<p>Error: Selected model panel not found.</p>';
            return;
        }

        const answer = outputElement.textContent.trim();

        if (!answer || answer.startsWith("Error:")) {
            if (comparisonOutput) comparisonOutput.innerHTML = '<p>Error: No valid response from selected model.</p>';
            return;
        }

        // Копируем готовый ответ в секцию сравнения
        if (comparisonOutput) comparisonOutput.innerHTML = convertMarkdownToHTML(answer);
    });
}




    llmButtons.forEach(button => {
        const llmId = button.id.replace('llm-', '');
        const panel = document.getElementById(`panel-${llmId}`);
        if (panel) {
            panel.style.display = button.classList.contains('active') ? 'block' : 'none';
        }
        button.addEventListener('click', () => {
            button.classList.toggle('active');
            if (panel) {
                panel.style.display = button.classList.contains('active') ? 'block' : 'none';
            }
            checkCompareButtonState();
            renderDiagnosticsModal();
            notifySelectionChanged();
        });
        button.addEventListener('dblclick', (event) => {
            event.preventDefault();
            toggleAllLLMs();
        });
    });
    checkCompareButtonState();

    // --- TEMPLATE FUNCTIONALITY LOGIC ---
    function updateAllLists() {
        updateSavedTemplatesList();
        updateTemplateSelect();
    }
    
    function saveTemplatesToStorage() {
        const dataToStore = { templates: savedTemplates, variables: templateVariables };
        chrome.storage.local.set({ llmComparatorTemplates: dataToStore });
    }
    
    function loadTemplatesFromStorage() {
        chrome.storage.local.get(['llmComparatorTemplates'], (result) => {
            if (result.llmComparatorTemplates) {
                const data = result.llmComparatorTemplates;
                savedTemplates = data.templates || {};
                templateVariables = data.variables || {};
                updateAllLists();
            }
        });
    }

    function showNotification(message) {
        if (notificationModal && notificationMessage) {
            notificationMessage.textContent = message;
            modalManager.show(notificationModal);
        } else {
            alert(message);
        }
    }

    if (notificationOkBtn) {
        notificationOkBtn.addEventListener('click', () => {
            modalManager.hide(notificationModal);
        });
    }

    function showConfirm(message) {
        return new Promise((resolve) => {
            if (confirmModal && confirmMessage) {
                confirmMessage.textContent = message;
                modalManager.show(confirmModal);

                const onConfirm = () => {
                    modalManager.hide(confirmModal);
                    cleanupListeners();
                    resolve(true);
                };

                const onCancel = () => {
                    modalManager.hide(confirmModal);
                    cleanupListeners();
                    resolve(false);
                };

                const cleanupListeners = () => {
                    deleteConfirmBtn.removeEventListener('click', onConfirm);
                    cancelConfirmBtn.removeEventListener('click', onCancel);
                };

                deleteConfirmBtn.addEventListener('click', onConfirm, { once: true });
                cancelConfirmBtn.addEventListener('click', onCancel, { once: true });
            } else {
                resolve(confirm(message));
            }
        });
    }
    
    function updateLivePreview() {
        let previewText = templatePrompt.value;
        variablesList.querySelectorAll('.variable-group').forEach(group => {
            const variableName = group.querySelector('.variable-name-input').value.trim();
            const labelName = group.querySelector('.variable-label-input').value.trim();
            if (variableName) {
                const placeholder = labelName ? `[${labelName}]` : `[${variableName}]`;
                previewText = previewText.replace(new RegExp(`{${variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}}`, 'g'), () => placeholder);
            }
        });
        templatePreview.textContent = previewText || 'Preview will appear here...';
    }
    
    function clearTemplateForm() {
        templateNameInput.value = '';
        templatePrompt.value = '';
        variablesList.innerHTML = '';
        updateLivePreview();
    }
    function openCreateTemplateModal() {
        if (!createTemplateModal) return;
        modalManager.show(createTemplateModal);
    }
    function closeCreateTemplateModal() {
        if (!createTemplateModal) return;
        modalManager.hide(createTemplateModal);
        if (templateSelect) {
            templateSelect.value = 'manual';
        }
    }
    
    function loadTemplateForEditingInModal(templateName) {
        let templatePromptText = null;
        let templateVars = null;

        // Явно ищем сначала в пользовательских шаблонах
        if (templateName in savedTemplates) {
            templatePromptText = savedTemplates[templateName];
            templateVars = templateVariables[templateName];
        // Если не нашли, ищем в системных
        } else if (templateName in systemTemplates.templates) {
            templatePromptText = systemTemplates.templates[templateName];
            templateVars = systemTemplates.variables[templateName];
        }

        if (!templatePromptText) {
            console.error(`Template "${templateName}" not found.`);
            return;
        }

        templateNameInput.value = templateName;
        templatePrompt.value = templatePromptText;
        variablesList.innerHTML = '';
        const variables = templateVars || {};
        Object.keys(variables).forEach(varName => {
            const variableGroup = document.createElement('div');
            variableGroup.className = 'variable-group';
            variableGroup.innerHTML = `
                <input type="text" class="variable-name-input" placeholder="variable_name" value="${varName}">
                <input type="text" class="variable-label-input" placeholder="Label for User" value="${variables[varName]}">
                <button class="remove-variable" title="Remove variable">&times;</button>
            `;
            variablesList.appendChild(variableGroup);
        });
        updateLivePreview();
        openCreateTemplateModal();
    }
    
    closeModal.addEventListener('click', closeCreateTemplateModal);
    
    cancelTemplateButton.addEventListener('click', () => {
        clearTemplateForm();
        closeCreateTemplateModal();
    });
    
    if (modelSelector) {
        modelSelector.addEventListener('click', (event) => {
            if (event.target.classList.contains('model-btn')) {
                modelSelector.querySelectorAll('.model-btn').forEach(btn => btn.classList.remove('active'));
                event.target.classList.add('active');
            }
        });
    }
    
    addVariableButton.addEventListener('click', () => {
        const variableGroup = document.createElement('div');
        variableGroup.className = 'variable-group';
        variableGroup.innerHTML = `
            <input type="text" class="variable-name-input" placeholder="variable_name">
            <input type="text" class="variable-label-input" placeholder="Label for User">
            <button class="remove-variable" title="Remove variable">&times;</button>
        `;
        variablesList.appendChild(variableGroup);
        updateLivePreview();
    });
    
    variablesList.addEventListener('input', updateLivePreview);
    variablesList.addEventListener('click', (event) => {
        if (event.target.classList.contains('remove-variable')) {
            event.target.closest('.variable-group').remove();
            updateLivePreview();
        }
    });
    
    templatePrompt.addEventListener('input', updateLivePreview);

    saveTemplateButton.addEventListener('click', async () => {
        const templateName = templateNameInput.value.trim();
        const promptText = templatePrompt.value.trim();
        if (!templateName || !promptText) {
            showNotification('Please enter a template name and prompt.');
            return;
        }

        if (savedTemplates[templateName]) {
            const shouldOverwrite = await showConfirm(`Template "${templateName}" already exists. Overwrite it?`);
            if (!shouldOverwrite) {
                return;
            }
        }
        
        savedTemplates[templateName] = promptText;
        templateVariables[templateName] = {};
        variablesList.querySelectorAll('.variable-group').forEach(group => {
            const varName = group.querySelector('.variable-name-input').value.trim();
            const labelName = group.querySelector('.variable-label-input').value.trim();
            if (varName) {
                templateVariables[templateName][varName] = labelName;
            }
        });
        updateAllLists();
        saveTemplatesToStorage();
        showNotification(`Template "${templateName}" saved!`);
    });

    function updateSavedTemplatesList() {
        savedTemplatesList.innerHTML = '';
        Object.keys(savedTemplates).sort().forEach(templateName => {
            const templateItem = document.createElement('li');
            templateItem.className = 'saved-template-item';
            templateItem.innerHTML = `
                <span class="template-name" data-template-name="${templateName}">${templateName}</span>
                <div class="template-actions">
                    <button class="action-btn-icon export-template" data-template-name="${templateName}" title="Export this template">⤓</button>
                    <button class="action-btn-icon remove-template" data-template-name="${templateName}" title="Delete this template">&times;</button>
                </div>`;
            savedTemplatesList.appendChild(templateItem);
        });

        refreshCollapseContentHeight(savedTemplatesBox, savedTemplatesContent);
    }
    
    function updateSystemTemplatesList() {
        if (!systemTemplatesList) return;

        systemTemplatesList.innerHTML = '';
        Object.keys(systemTemplates.templates).sort().forEach(templateName => {
            const templateItem = document.createElement('li');
            templateItem.className = 'saved-template-item';
            templateItem.innerHTML = `
                <span class="template-name" data-template-name="${templateName}">${templateName}</span>
                <div class="template-actions">
                    <button class="action-btn-icon export-template" data-template-name="${templateName}" title="Export this template">⤓</button>
                </div>`;
            systemTemplatesList.appendChild(templateItem);
        });

        refreshCollapseContentHeight(systemTemplatesBox, systemTemplatesContent);
    }

    savedTemplatesList.addEventListener('click', (event) => {
        const target = event.target;
        const templateName = target.closest('[data-template-name]')?.dataset.templateName;
        
        if (!templateName) return;

        if (target.closest('.remove-template')) {
            const nameForDeletion = templateName;
            showConfirm(`Are you sure you want to delete the template "${nameForDeletion}"?`).then((confirmed) => {
                if (!confirmed) return;
                delete savedTemplates[nameForDeletion];
                delete templateVariables[nameForDeletion];
                updateAllLists();
                saveTemplatesToStorage();
            });
        } else if (target.closest('.export-template')) {
            // Вызываем экспорт без второго аргумента, чтобы он использовал глобальные savedTemplates
            exportSingleTemplate(templateName);
        } else if (target.classList.contains('template-name')) {
            loadTemplateForEditingInModal(templateName);
        }
    });
    if (systemTemplatesList) {
        systemTemplatesList.addEventListener('click', (event) => {
            const target = event.target;
            const templateName = target.closest('[data-template-name]')?.dataset.templateName;

            if (!templateName) return;

            if (target.closest('.export-template')) {
                exportSingleTemplate(templateName, systemTemplates);
            } else if (target.classList.contains('template-name')) {
                loadTemplateForEditingInModal(templateName);
            }
        });
    }
    
    const judgeDefault = 'Claude';

    function sortJudgeSystemPrompts(list = []) {
        return list
            .filter((prompt) => prompt && prompt.id && prompt.text)
            .sort((a, b) => {
                const orderA = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
                const orderB = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
                if (orderA !== orderB) return orderA - orderB;
                const labelA = String(a.label || a.id || '');
                const labelB = String(b.label || b.id || '');
                return labelA.localeCompare(labelB);
            });
    }

    function updateJudgeSystemPromptOptions() {
        if (!judgeSystemPromptSelect) return;
        const orderedPrompts = sortJudgeSystemPrompts(judgeSystemPrompts);
        const currentSelection = judgeSystemPromptSelect.value;
        judgeSystemPromptSelect.innerHTML = '';
        orderedPrompts.forEach((prompt) => {
            const option = document.createElement('option');
            option.value = prompt.id;
            option.textContent = prompt.label || prompt.id;
            option.title = prompt.label || prompt.id;
            judgeSystemPromptSelect.appendChild(option);
        });
        const fallbackSelection = orderedPrompts.find((prompt) => prompt.id === currentSelection) || orderedPrompts[0];
        if (fallbackSelection) {
            judgeSystemPromptSelect.value = fallbackSelection.id;
        }
        judgeSystemPromptSelect.disabled = orderedPrompts.length === 0;
        judgeSystemPrompts = orderedPrompts;
    }

    function updateEvaluatorOptions() {
        if (!evaluatorSelect) return;
        const currentSelection = evaluatorSelect.value || judgeDefault;
        evaluatorSelect.innerHTML = '';
        llmNames.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            evaluatorSelect.appendChild(opt);
        });
        if (llmNames.includes(currentSelection)) {
            evaluatorSelect.value = currentSelection;
        } else if (llmNames.includes(judgeDefault)) {
            evaluatorSelect.value = judgeDefault;
        } else if (llmNames.length) {
            evaluatorSelect.value = llmNames[0];
        }
    }

    updateJudgeSystemPromptOptions();
    updateEvaluatorOptions();

    function updateTemplateSelect() {
        const currentSelection = templateSelect.value;
        templateSelect.innerHTML = `
            <option value="manual">Select Template...</option>
            <option value="create">Create Template…</option>
        `;
        Object.keys(savedTemplates).sort().forEach(template => {
            const option = document.createElement('option');
            option.value = template;
            option.textContent = template.length > 18 ? `${template.slice(0, 18)}…` : template;
            option.title = template;
            templateSelect.appendChild(option);
        });
        if (currentSelection && currentSelection !== 'create' && savedTemplates[currentSelection]) {
            templateSelect.value = currentSelection;
        } else {
            templateSelect.value = 'manual';
        }
        templateSelect.dispatchEvent(new Event('change'));
    }
    
    templateSelect.addEventListener('change', () => {
        const selectedTemplate = templateSelect.value;
        variableInputsContainer.innerHTML = '';
        if (selectedTemplate === 'create') {
            openCreateTemplateModal();
            templateSelect.value = 'manual';
            return;
        }
        if (selectedTemplate === 'manual' || !savedTemplates[selectedTemplate]) {
            promptInput.value = '';
            promptInput.readOnly = false;
            return;
        }
        promptInput.readOnly = false;
        promptManuallyEdited = false;

        const variables = templateVariables[selectedTemplate] || {};
        
        Object.keys(variables).forEach(varName => {
            const label = document.createElement('label');
            const labelText = variables[varName] || varName;
            
            const input = document.createElement('input');
            input.type = 'text';
            input.dataset.variable = varName;
            input.placeholder = labelText;
            
            input.addEventListener('input', function() {
                this.style.width = '200px';
                
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                context.font = getComputedStyle(this).font;
                const textWidth = context.measureText(this.value || this.placeholder).width;
                
                const neededWidth = Math.min(Math.max(textWidth + 40, 200), variableInputsContainer.offsetWidth);
                this.style.width = neededWidth + 'px';
            });
            
            label.appendChild(input);
            variableInputsContainer.appendChild(label);
        });

        updatePromptFromTemplate();
    });
    
    variableInputsContainer.addEventListener('input', updatePromptFromTemplate);
    
    function updatePromptFromTemplate() {
        const selectedTemplate = templateSelect.value;
        if (selectedTemplate === 'manual' || !savedTemplates[selectedTemplate]) return;

        if (promptManuallyEdited) return;

        let promptText = savedTemplates[selectedTemplate];
        const inputs = variableInputsContainer.querySelectorAll('input[data-variable]');
        inputs.forEach(input => {
            const varName = input.dataset.variable;
            const value = input.value.trim();
            const label = templateVariables[selectedTemplate][varName] || varName;
            const placeholder = `[${label}]`;
            promptText = promptText.replace(new RegExp(`{${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}}`, 'g'), value || placeholder);
        });
        promptInput.value = promptText;
    }

function exportSingleTemplate(templateName, sourceData = null) {
        const templates = sourceData ? sourceData.templates : savedTemplates;
        const variables = sourceData ? sourceData.variables : templateVariables; // <-- ИСПРАВЛЕНА ОПЕЧАТКА
        
        if (!templates[templateName]) {
            console.error("Template not found for export:", templateName);
            return;
        }

        const singleTemplateData = {
            templates: {
                [templateName]: templates[templateName]
            },
            variables: {
                [templateName]: variables[templateName] || {}
            }
        };

        const dataStr = JSON.stringify(singleTemplateData, null, 2);
        const blob = new Blob([dataStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;

        // Формат имени: "Prompt - Template Name" (Template Name берётся из templateName)
        const rawFileName = `Prompt - ${templateName || 'unnamed'}`;
        // Санитизация: удаляем только запрещённые символы файловой системы (/, \, :, ?, <, >, |, *, ", ')
        const safeFileName = rawFileName.replace(/[\/\\:?<>|*"']/g, '').trim();

        // Готовый файл будет иметь расширение .json
        a.download = `${safeFileName}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

    }

    //-- 1.1. Добавляем динамическое имя файла для экспорта всех шаблонов --//
    exportBtn.addEventListener('click', () => {
        if (Object.keys(savedTemplates).length === 0) return alert("No templates to export.");
        const dataStr = JSON.stringify({ templates: savedTemplates, variables: templateVariables }, null, 2);
        const blob = new Blob([dataStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;

        // Формируем имя файла с датой
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
        a.download = `Prompts Templates ${dateStr}.json`;

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });
    
    importBtn.addEventListener('click', () => { importFileInput.click(); });
    
    importFileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (data && typeof data.templates === 'object' && typeof data.variables === 'object') {
                    const templatesToImport = data.templates;
                    const variablesToImport = data.variables || {};

                    for (const templateName in templatesToImport) {
                        if (savedTemplates[templateName]) {
                            const shouldOverwrite = await showConfirm(`Template "${templateName}" already exists. Overwrite it?`);
                            if (!shouldOverwrite) {
                                delete templatesToImport[templateName];
                                if (variablesToImport[templateName]) {
                                    delete variablesToImport[templateName];
                                }
                            }
                        }
                    }

                    Object.assign(savedTemplates, templatesToImport);
                    Object.assign(templateVariables, variablesToImport);
                    
                    updateAllLists();
                    saveTemplatesToStorage();
                    showNotification('Templates imported successfully!');
                } else {
                    showNotification('Invalid template file format.');
                }
            } catch (error) {
                console.error('Error reading or parsing file:', error);
                showNotification('Error reading or parsing file. Please ensure it is a valid JSON.');
                }
        };
        reader.readAsText(file);
        importFileInput.value = '';
    });

    // --- INITIALIZATION ---
    await loadModifierPresets(); // <-- грузим пресеты модификаторов и рендерим список
    loadTemplatesFromStorage();
    loadSystemTemplates();


    if (fileInput) {
        fileInput.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (!file) {
                fileNameDisplay.textContent = 'No file attached';
                attachedFileContent = '';
                return;
            }

            fileNameDisplay.textContent = `File: ${file.name}`;
            const reader = new FileReader();

            // --- ОБРАБОТКА ПРОСТЫХ ТЕКСТОВЫХ ФАЙЛОВ ---
            if (file.type.startsWith('text/') || file.name.endsWith('.md') || file.name.endsWith('.js') || file.name.endsWith('.json')) {
                reader.onload = (e) => {
                    attachedFileContent = e.target.result;
                    showNotification(`Text file "${file.name}" loaded successfully.`);
                };
                reader.onerror = () => {
                    showNotification(`Error reading file: ${file.name}`);
                    attachedFileContent = '';
                };
                reader.readAsText(file);
            } 
            // --- ЗАГЛУШКИ ДЛЯ БУДУЩЕЙ РАБОТЫ С PDF/DOCX ---
            else if (file.name.endsWith('.pdf')) {
                 showNotification('PDF parsing is not implemented yet. Please add a library like PDF.js.');
                 attachedFileContent = '';
            } else if (file.name.endsWith('.docx')) {
                 showNotification('DOCX parsing is not implemented yet. Please add a library like Mammoth.js.');
                 attachedFileContent = '';
            } 
            else {
                showNotification(`Unsupported file type: ${file.type}`);
                fileNameDisplay.textContent = 'Unsupported file';
                attachedFileContent = '';
            }
        });
    }
// --- V2.0 START: API Keys Modal Logic ---
    const apiKeysModal = document.getElementById('api-keys-modal');
    const openApiKeysBtn = document.getElementById('open-api-keys-btn');
    const closeApiKeysModal = document.getElementById('close-api-keys-modal');
    const saveApiKeysBtn = document.getElementById('save-api-keys');
    
    const apiKeyInputs = {
        openai: document.getElementById('api-key-openai'),
        anthropic: document.getElementById('api-key-anthropic'),
        google: document.getElementById('api-key-google'),
        grok: document.getElementById('api-key-grok'),
        lechat: document.getElementById('api-key-lechat'),
        qwen: document.getElementById('api-key-qwen'),
        deepseek: document.getElementById('api-key-deepseek'),
        perplexity: document.getElementById('api-key-perplexity')
    };
    const apiKeyStorageMap = {
        openai: 'apiKey_openai',
        anthropic: 'apiKey_anthropic',
        google: 'apiKey_google',
        grok: 'apiKey_grok',
        lechat: 'apiKey_lechat',
        qwen: 'apiKey_qwen',
        deepseek: 'apiKey_deepseek',
        perplexity: 'apiKey_perplexity'
    };

    const devtoolsTabs = Array.from(document.querySelectorAll('.devtools-tab'));
    const devtoolsPanels = Array.from(document.querySelectorAll('.devtools-tabpanel'));
    const DEFAULT_DEVTOOLS_TAB_ID = 'logs-tabpanel';
    let activeDevtoolsTabId = devtoolsTabs.find(tab => tab.classList.contains('is-active'))?.dataset.tabTarget ||
        devtoolsPanels[0]?.id || DEFAULT_DEVTOOLS_TAB_ID;

    const setActiveDevtoolsTab = (targetId) => {
        try {
            if (!targetId || !devtoolsTabs.length || !devtoolsPanels.length) return;
            activeDevtoolsTabId = targetId;
            devtoolsTabs.forEach((tab) => {
                try {
                    const isActive = tab.dataset.tabTarget === targetId;
                    tab.classList.toggle('is-active', isActive);
                    tab.setAttribute('aria-selected', String(isActive));
                    tab.tabIndex = isActive ? 0 : -1;
                } catch (err) { console.error('[results] error updating devtools tab state', err); }
            });
            devtoolsPanels.forEach((panel) => {
                try {
                    const isActive = panel.id === targetId;
                    panel.classList.toggle('is-active', isActive);
                    if (isActive) {
                        panel.removeAttribute('hidden');
                    } else {
                        panel.setAttribute('hidden', '');
                    }
                } catch (err) { console.error('[results] error updating devtools panel state', err); }
            });
            if (targetId === DEFAULT_DEVTOOLS_TAB_ID) {
                syncDevtoolsPanelHeight();
            }
            // (reverted) telemetry auto-refresh dispatch removed
        } catch (err) {
            console.error('[results] setActiveDevtoolsTab top-level error', err);
        }
    };

    if (devtoolsTabs.length && devtoolsPanels.length) {
        devtoolsTabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                setActiveDevtoolsTab(tab.dataset.tabTarget);
            });
            tab.addEventListener('keydown', (event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const currentIndex = devtoolsTabs.indexOf(tab);
                const offset = event.key === 'ArrowLeft' ? -1 : 1;
                const nextIndex = (currentIndex + offset + devtoolsTabs.length) % devtoolsTabs.length;
                devtoolsTabs[nextIndex].focus();
                setActiveDevtoolsTab(devtoolsTabs[nextIndex].dataset.tabTarget);
            });
        });
        setActiveDevtoolsTab(activeDevtoolsTabId || DEFAULT_DEVTOOLS_TAB_ID);
    }
    window.addEventListener('resize', () => {
        syncDevtoolsPanelHeight();
    });

    if (apiKeysModal && closeApiKeysModal && saveApiKeysBtn) {
        const openDevtoolsModal = () => {
            setActiveDevtoolsTab(DEFAULT_DEVTOOLS_TAB_ID);
            diagnosticsExpanded = true;
            applyDiagnosticsExpandState();
            refreshActiveSelectorSnapshot();
            refreshSelectorAudit();
            requestSelectorHealthSummary(true);
            // Загружаем ключи при открытии
            chrome.storage.local.get(Object.values(apiKeyStorageMap), (result) => {
                Object.entries(apiKeyInputs).forEach(([key, input]) => {
                    if (!input) return;
                    const storageKey = apiKeyStorageMap[key];
                    if (!storageKey) return;
                    input.value = result?.[storageKey] || '';
                });
            });
            modalManager.show(apiKeysModal);
            syncDevtoolsPanelHeight();
        };

        if (openApiKeysBtn) {
            openApiKeysBtn.addEventListener('click', openDevtoolsModal);
        }

        try {
            if (apiToggleBtn && typeof openDevtoolsModal === 'function') {
                apiToggleBtn.addEventListener('dblclick', () => {
                    try { openDevtoolsModal(); } catch (err) { console.error('[results] openDevtoolsModal error', err); }
                });
            }

            if (closeApiKeysModal && modalManager && typeof modalManager.hide === 'function') {
                closeApiKeysModal.addEventListener('click', () => {
                    try { modalManager.hide(apiKeysModal); } catch (err) { console.error('[results] modalManager.hide error', err); }
                });
            }

            if (saveApiKeysBtn) {
                saveApiKeysBtn.addEventListener('click', () => {
                    try {
                        const keysToSave = {};
                        Object.entries(apiKeyInputs).forEach(([key, input]) => {
                            if (!input) return;
                            const storageKey = apiKeyStorageMap[key];
                            if (!storageKey) return;
                            const trimmed = input.value.trim();
                            if (trimmed) {
                                keysToSave[storageKey] = trimmed;
                            }
                        });
                        chrome.storage.local.set(keysToSave, () => {
                            try { showNotification('API Keys saved successfully!'); } catch (_) {}
                            try { modalManager && modalManager.hide && modalManager.hide(apiKeysModal); } catch (err) { console.error('[results] modalManager.hide after save error', err); }
                        });
                    } catch (err) { console.error('[results] saveApiKeysBtn handler error', err); }
                });
            }

            const openDiagnosticsFromIndicator = () => {
                try {
                    if (!apiKeysModal) return;
                    try { setActiveDevtoolsTab('logs-tabpanel'); } catch (err) { console.error('[results] setActiveDevtoolsTab error', err); }
                    try { modalManager && modalManager.show && modalManager.show(apiKeysModal); } catch (err) { console.error('[results] modalManager.show error', err); }
                } catch (err) { console.error('[results] openDiagnosticsFromIndicator error', err); }
            };
            document.querySelectorAll('.status-indicator').forEach((indicator) => {
                try { indicator.addEventListener('click', openDiagnosticsFromIndicator); } catch (err) { console.error('[results] indicator addEventListener error', err); }
            });
        } catch (err) {
            console.error('[results] modal wiring top-level error', err);
        }
    }
    // --- V2.0 END: API Keys Modal Logic ---
});
//-- 3.1. Добавляем обработчик для новой кнопки закрытия панели сравнения --//
document.addEventListener('click', (event) => {
    // Ищем кнопку закрытия по её ID
    const closeBtn = event.target.closest('#close-comparison-btn');
    if (!closeBtn) return; // Если клик был не по кнопке, ничего не делаем

    // Находим родительскую секцию, которую нужно скрыть
    const sectionToClose = document.getElementById('comparison-section');
    if (sectionToClose) {
        sectionToClose.classList.add('hidden'); // Добавляем класс, который делает её невидимой
        sectionToClose.setAttribute('aria-hidden', 'true');
    }
});

// --- DevTools extracted to results-devtools.js ---

} // end guard __RESULTS_PAGE_LOADED
