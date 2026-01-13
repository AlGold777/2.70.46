(() => {
  if (globalThis.CodexElementPicker) return;

  const state = {
    active: false,
    overlay: null,
    highlight: null,
    cursorStyle: null,
    mode: null,
    elementType: null,
    requestId: null,
    resolve: null,
    reject: null
  };

  const cssEscape = (value) => {
    if (globalThis.CSS && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  };

  const isUniqueSelector = (selector, root = document) => {
    try {
      return root.querySelectorAll(selector).length === 1;
    } catch (_) {
      return false;
    }
  };

  const isDynamicClass = (className) => {
    if (!className) return true;
    if (className.length > 32) return true;
    if (/^[a-f0-9]{6,}$/i.test(className)) return true;
    if (/\d{6,}/.test(className)) return true;
    if (/^(css|sc|jss|chakra|mui)-/.test(className)) return true;
    return false;
  };

  const getStableClasses = (element) =>
    Array.from(element.classList || []).filter((cls) => !isDynamicClass(cls));

  const getNthOfTypeIndex = (element) => {
    const parent = element.parentElement;
    if (!parent) return 1;
    const siblings = Array.from(parent.children).filter(
      (child) => child.tagName === element.tagName
    );
    return siblings.indexOf(element) + 1;
  };

  const needsNthOfType = (element) => {
    const parent = element.parentElement;
    if (!parent) return false;
    const siblings = Array.from(parent.children).filter(
      (child) => child.tagName === element.tagName
    );
    return siblings.length > 1;
  };

  const buildAttributeSelector = (element) => {
    const attrs = [
      'data-testid',
      'data-test-id',
      'data-qa',
      'data-qa-id',
      'data-qa-name',
      'data-cy',
      'data-automation-id',
      'data-automation',
      'aria-label',
      'aria-labelledby',
      'name',
      'title',
      'placeholder',
      'role'
    ];
    const tag = element.tagName ? element.tagName.toLowerCase() : '';
    for (const attr of attrs) {
      const value = element.getAttribute(attr);
      if (!value) continue;
      const selector = `[${attr}="${cssEscape(value)}"]`;
      const tagged = tag ? `${tag}${selector}` : selector;
      if (tag && isUniqueSelector(tagged)) return tagged;
      if (isUniqueSelector(selector)) return selector;
    }
    return null;
  };

  const buildPathSelector = (element) => {
    const parts = [];
    let current = element;

    while (current && current.nodeType === 1 && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      let part = tag;

      const classes = getStableClasses(current).slice(0, 2);
      if (classes.length) {
        part += `.${classes.map(cssEscape).join('.')}`;
      }

      if (needsNthOfType(current)) {
        part += `:nth-of-type(${getNthOfTypeIndex(current)})`;
      }

      parts.unshift(part);
      const selector = parts.join(' > ');
      if (isUniqueSelector(selector)) {
        return selector;
      }

      current = current.parentElement;
    }

    return parts.join(' > ');
  };

  const buildSelector = (element) => {
    if (!element || element.nodeType !== 1) return null;

    if (element.id) {
      const idSelector = `#${cssEscape(element.id)}`;
      if (isUniqueSelector(idSelector)) return idSelector;
    }

    const attrSelector = buildAttributeSelector(element);
    if (attrSelector) return attrSelector;

    const pathSelector = buildPathSelector(element);
    if (pathSelector) return pathSelector;

    return element.tagName ? element.tagName.toLowerCase() : null;
  };

  const createOverlay = () => {
    state.overlay = document.createElement('div');
    state.overlay.id = 'codex-element-picker-overlay';
    state.overlay.style.cssText = `
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483647;
    `;

    state.highlight = document.createElement('div');
    state.highlight.id = 'codex-element-picker-highlight';
    state.highlight.style.cssText = `
      position: absolute;
      border: 2px solid #ff6b3d;
      background: rgba(255, 107, 61, 0.12);
      box-shadow: 0 0 0 3px rgba(255, 107, 61, 0.18);
      border-radius: 6px;
      transition: all 0.05s ease;
    `;

    state.overlay.appendChild(state.highlight);
    document.documentElement.appendChild(state.overlay);

    state.cursorStyle = document.createElement('style');
    state.cursorStyle.textContent = '* { cursor: crosshair !important; }';
    document.documentElement.appendChild(state.cursorStyle);
  };

  const removeOverlay = () => {
    if (state.overlay?.parentNode) {
      state.overlay.parentNode.removeChild(state.overlay);
    }
    if (state.cursorStyle?.parentNode) {
      state.cursorStyle.parentNode.removeChild(state.cursorStyle);
    }
    state.overlay = null;
    state.highlight = null;
    state.cursorStyle = null;
  };

  const updateHighlight = (element) => {
    if (!state.highlight || !element) return;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      state.highlight.style.opacity = '0';
      return;
    }
    state.highlight.style.opacity = '1';
    state.highlight.style.top = `${rect.top}px`;
    state.highlight.style.left = `${rect.left}px`;
    state.highlight.style.width = `${rect.width}px`;
    state.highlight.style.height = `${rect.height}px`;
  };

  const isIgnoredTarget = (element) => {
    if (!element) return true;
    if (element === document.documentElement || element === document.body) return true;
    if (element.closest?.('#codex-element-picker-overlay')) return true;
    if (element.closest?.('#codex-notes-sidebar-host')) return true;
    return false;
  };

  const resolveRecordTarget = (element) => {
    if (!element) return null;
    if (state.elementType === 'sendButton') {
      return element.closest?.('button, [role="button"], input[type="submit"], input[type="button"]') || element;
    }
    return element;
  };

  const resolveTarget = (event) => {
    const node = event.target;
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element || isIgnoredTarget(element)) return null;
    if (state.mode === 'record') {
      return resolveRecordTarget(element);
    }
    return element;
  };

  const getSelectionText = () => {
    const selection = globalThis.getSelection?.();
    return selection ? selection.toString().trim() : '';
  };

  const getTextContent = (node) =>
    (node?.innerText || node?.textContent || '').trim();

  const INLINE_STYLE_PROPERTIES = [
    'color',
    'background-color',
    'font-size',
    'font-family',
    'font-weight',
    'font-style',
    'font-variant',
    'line-height',
    'letter-spacing',
    'word-spacing',
    'text-align',
    'text-transform',
    'text-decoration',
    'white-space',
    'display',
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'border-top',
    'border-right',
    'border-bottom',
    'border-left',
    'border-radius',
    'list-style-type',
    'list-style-position'
  ];

  const buildInlineStyle = (element) => {
    if (!element || element.nodeType !== 1) return '';
    const computed = getComputedStyle(element);
    return INLINE_STYLE_PROPERTIES.map((prop) => {
      const value = computed.getPropertyValue(prop);
      return value ? `${prop}:${value.trim()};` : '';
    }).join('');
  };

  const applyInlineStyles = (source, target) => {
    const style = buildInlineStyle(source);
    if (style) {
      target.setAttribute('style', style);
    }
  };

  const cloneElementWithInlineStyles = (element) => {
    const clone = element.cloneNode(true);
    const sourceWalker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT, null);
    const cloneWalker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT, null);
    let sourceNode = element;
    let cloneNode = clone;
    while (sourceNode && cloneNode) {
      applyInlineStyles(sourceNode, cloneNode);
      sourceNode = sourceWalker.nextNode();
      cloneNode = cloneWalker.nextNode();
    }
    return clone;
  };

  const getSelectionHtml = () => {
    const selection = globalThis.getSelection?.();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return '';
    const range = selection.getRangeAt(0);
    const root = range.commonAncestorContainer?.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer?.parentElement;
    const fragment = range.cloneContents();
    const container = document.createElement('div');
    container.appendChild(fragment);
    if (!root) return container.innerHTML || '';
    const token = `codex-inline-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const attr = 'data-codex-inline-id';
    const elementMap = new Map();
    let counter = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => {
        try {
          return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        } catch (_) {
          return NodeFilter.FILTER_REJECT;
        }
      }
    });
    let current = walker.currentNode;
    while (current) {
      const id = `${token}-${counter}`;
      counter += 1;
      current.setAttribute(attr, id);
      elementMap.set(id, current);
      current = walker.nextNode();
    }
    try {
      container.querySelectorAll(`[${attr}]`).forEach((node) => {
        const id = node.getAttribute(attr);
        const original = elementMap.get(id);
        if (original) applyInlineStyles(original, node);
        node.removeAttribute(attr);
      });
    } finally {
      elementMap.forEach((element) => element.removeAttribute(attr));
    }
    return container.innerHTML || '';
  };

  const findBlockElement = (element) => {
    if (!element || element.nodeType !== 1) return null;
    const preferred = element.closest(
      'article, section, main, [role="article"], [role="main"], [data-testid*="answer"], .prose'
    );
    if (preferred && preferred !== document.body && preferred !== document.documentElement) {
      return preferred;
    }
    let current = element;
    while (current && current.nodeType === 1 && current !== document.body) {
      if (getTextContent(current).length >= 120) return current;
      current = current.parentElement;
    }
    return element;
  };

  const buildPayload = (element) => {
    const url = window.location.href;
    const title = document.title;
    if (state.mode === 'selector') {
      const selector = buildSelector(element);
      if (!selector) return { ok: false, error: 'Unable to build selector' };
      return { ok: true, mode: 'selector', selector, url, title };
    }

    if (state.mode === 'block') {
      const block = findBlockElement(element) || element;
      const text = getTextContent(block);
      const html = cloneElementWithInlineStyles(block).outerHTML;
      if (!text) return { ok: false, error: 'No text found' };
      return {
        ok: true,
        mode: 'block',
        text,
        html,
        selector: buildSelector(block),
        url,
        title
      };
    }

    const selectionText = getSelectionText();
    const selectionHtml = getSelectionHtml();
    const text = selectionText || getTextContent(element);
    const html = selectionHtml || cloneElementWithInlineStyles(element).outerHTML;
    if (!text) return { ok: false, error: 'No text found' };
    return {
      ok: true,
      mode: 'text',
      text,
      html,
      selector: buildSelector(element),
      url,
      title
    };
  };

  const cleanupPicker = () => {
    state.active = false;
    state.mode = null;
    state.requestId = null;
    state.resolve = null;
    state.reject = null;
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('keydown', handleKeydown, true);
    removeOverlay();
  };

  const finishPicker = (payload, cancelled = false, reason = null) => {
    const requestId = state.requestId;
    const resolve = state.resolve;
    const reject = state.reject;
    cleanupPicker();
    if (cancelled) {
      if (reject) reject(new Error(reason || 'cancelled'));
      if (requestId) {
        chrome.runtime.sendMessage({ type: 'PICKER_CANCELLED', requestId, reason });
      }
      return;
    }
    if (resolve) resolve(payload);
    if (requestId) {
      chrome.runtime.sendMessage({ type: 'PICKER_RESULT', requestId, payload });
    }
  };

  const handleMouseMove = (event) => {
    if (!state.active) return;
    const target = resolveTarget(event);
    if (!target) return;
    updateHighlight(target);
  };

  const handleClick = (event) => {
    if (!state.active) return;
    if (event.button !== 0) return;
    const target = resolveTarget(event);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const payload = buildPayload(target);
    finishPicker(payload, false);
  };

  const handleKeydown = (event) => {
    if (!state.active) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      finishPicker(null, true, 'cancelled');
    }
  };

  const startPick = ({ mode = 'selector', requestId = null, elementType = null } = {}) => {
    if (state.active) {
      finishPicker(null, true, 'restarted');
    }
    state.active = true;
    state.mode = mode;
    state.elementType = elementType;
    state.requestId = requestId;
    if (mode !== 'record') {
      createOverlay();
      document.addEventListener('mousemove', handleMouseMove, true);
    }
    document.addEventListener('click', handleClick, true);
    document.addEventListener('keydown', handleKeydown, true);
    return new Promise((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
    });
  };

  const cancelPick = (reason = 'cancelled') => {
    if (!state.active) return;
    finishPicker(null, true, reason);
  };

  chrome.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
    if (message?.type === 'PICKER_START') {
      startPick({
        mode: message.mode || 'selector',
        requestId: message.requestId || null,
        elementType: message.elementType || null
      });
      sendResponse?.({ ok: true });
      return true;
    }
    if (message?.type === 'PICKER_CANCEL') {
      cancelPick('cancelled');
      sendResponse?.({ ok: true });
      return true;
    }
    return false;
  });

  globalThis.CodexElementPicker = {
    startPick,
    cancelPick
  };
})();
