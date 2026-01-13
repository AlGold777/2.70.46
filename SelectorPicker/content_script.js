const state = {
  active: false,
  overlay: null,
  highlight: null,
  cursorStyle: null,
  currentBlockId: null
};

const cssEscape = (value) => {
  if (window.CSS && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
};

const isUniqueSelector = (selector) => {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch (error) {
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

const getStableClasses = (element) => {
  return Array.from(element.classList || []).filter((cls) => !isDynamicClass(cls));
};

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

  const attrs = ['data-testid', 'data-test-id', 'aria-label', 'name'];
  for (const attr of attrs) {
    const value = element.getAttribute(attr);
    if (!value) continue;
    const selector = `[${attr}="${cssEscape(value)}"]`;
    if (isUniqueSelector(selector)) return selector;
  }

  const pathSelector = buildPathSelector(element);
  if (pathSelector) return pathSelector;

  return element.tagName ? element.tagName.toLowerCase() : null;
};

const createOverlay = () => {
  state.overlay = document.createElement('div');
  state.overlay.id = 'apicker-overlay';
  state.overlay.style.cssText = `
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 2147483647;
  `;

  state.highlight = document.createElement('div');
  state.highlight.id = 'apicker-highlight';
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

const sendMessage = (action, data) => {
  chrome.runtime.sendMessage({ action, data });
};

const handleMouseMove = (event) => {
  if (!state.active) return;
  const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
  if (!target || target === document.documentElement || target === document.body) return;
  updateHighlight(target);
};

const handleClick = (event) => {
  if (!state.active) return;
  event.preventDefault();
  event.stopPropagation();

  const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
  const selector = buildSelector(target);

  if (!selector) {
    sendMessage('pickerError', { error: 'Unable to build selector' });
    deactivatePicker(true);
    return;
  }

  sendMessage('selectorCaptured', {
    selector,
    blockId: state.currentBlockId,
    url: window.location.href,
    title: document.title
  });
  deactivatePicker(false);
};

const handleKeydown = (event) => {
  if (!state.active) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    deactivatePicker(true);
  }
};

const activatePicker = (blockId) => {
  if (state.active) return;
  state.active = true;
  state.currentBlockId = blockId || null;
  createOverlay();
  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeydown, true);
};

const deactivatePicker = (cancelled) => {
  if (!state.active) return;
  state.active = false;
  state.currentBlockId = null;
  document.removeEventListener('mousemove', handleMouseMove, true);
  document.removeEventListener('click', handleClick, true);
  document.removeEventListener('keydown', handleKeydown, true);
  removeOverlay();
  if (cancelled) {
    sendMessage('pickerCancelled', {});
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === 'activatePicker') {
    activatePicker(message.blockId);
    sendResponse({ success: true });
    return true;
  }

  if (message?.action === 'deactivatePicker') {
    deactivatePicker(true);
    sendResponse({ success: true });
    return true;
  }

  return false;
});
