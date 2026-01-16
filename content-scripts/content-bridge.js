(function () {
  if (window.__ExtMainBridge) return;
  window.__ExtMainBridge = true;

  const dataUrlToFile = (item) => {
    try {
      const match = (item?.base64 || '').match(/^data:([^;]+);base64,(.*)$/);
      const base64Part = match ? match[2] : item?.base64 || '';
      const binary = atob(base64Part);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
      return new File([bytes], item.name || 'file', { type: item.type || 'application/octet-stream' });
    } catch (err) {
      console.warn('[MainBridge] dataUrlToFile failed', err);
      return null;
    }
  };

  const toFiles = (arr) => (arr || []).map(dataUrlToFile).filter(Boolean);

  const safeQuery = (root, selector) => {
    try {
      return root.querySelector(selector);
    } catch (_) {
      return null;
    }
  };

  const collectShadowRoots = (root = document, maxRoots = 150) => {
    const roots = [];
    const queue = [root];
    const seen = new Set();
    while (queue.length && roots.length < maxRoots) {
      const current = queue.shift();
      let walker = null;
      try {
        walker = document.createTreeWalker(current, NodeFilter.SHOW_ELEMENT);
      } catch (_) {
        continue;
      }
      let node = walker.currentNode;
      while (node) {
        const shadow = node.shadowRoot;
        if (shadow && !seen.has(shadow)) {
          seen.add(shadow);
          roots.push(shadow);
          if (roots.length >= maxRoots) break;
          queue.push(shadow);
        }
        node = walker.nextNode();
      }
    }
    return roots;
  };

  const querySelectorDeep = (selector, shadowRoots = null) => {
    const direct = safeQuery(document, selector);
    if (direct) return direct;
    const roots = shadowRoots || collectShadowRoots();
    for (const root of roots) {
      const found = safeQuery(root, selector);
      if (found) return found;
    }
    return null;
  };

  const findFirst = (sels = [], shadowRoots = null) => {
    for (const sel of sels) {
      const el = querySelectorDeep(sel, shadowRoots);
      if (el) return el;
    }
    return null;
  };

  const setNativeValue = (el, value) => {
    try {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      const setter = desc && desc.set;
      const ownSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      (ownSetter || setter)?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      try {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (_) {}
    }
  };

  const dispatchDrop = (el, dt) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
    const coords = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    for (const t of ['dragenter', 'dragover', 'drop']) {
      const ev = new DragEvent(t, Object.assign({ bubbles: true, cancelable: true, dataTransfer: dt }, coords));
      ev.preventDefault?.();
      el.dispatchEvent(ev);
    }
    return true;
  };

  window.addEventListener('EXT_ATTACH', (ev) => {
    try {
      const d = ev.detail || {};
      const files = toFiles(d.attachments);
      if (!files.length) return;
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      dt.effectAllowed = 'copy';
      const shadowRoots = collectShadowRoots();

      const dropSelectors = d.dropSelectors || [];
      for (const sel of dropSelectors) {
        const el = querySelectorDeep(sel, shadowRoots);
        if (dispatchDrop(el, dt)) return;
      }

      const attachBtn = findFirst(d.attachSelectors || [], shadowRoots);
      if (attachBtn) {
        try {
          attachBtn.click();
        } catch (_) {}
      }

      const fileInput =
        findFirst(d.inputSelectors || [], shadowRoots) || querySelectorDeep('input[type="file"]', shadowRoots);
      if (fileInput) {
        try {
          fileInput.files = dt.files;
        } catch (_) {}
        try {
          fileInput.dispatchEvent(new Event('input', { bubbles: true }));
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        } catch (_) {}
      }

      const pasteSelectors = d.pasteSelectors || dropSelectors;
      const pasteTargets = pasteSelectors.map((sel) => querySelectorDeep(sel, shadowRoots)).filter(Boolean);
      for (const el of pasteTargets) {
        try {
          const evPaste = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
          if (!evPaste.clipboardData) {
            Object.defineProperty(evPaste, 'clipboardData', { value: dt });
          }
          el.dispatchEvent(evPaste);
          el.dispatchEvent(evPaste);
          return;
        } catch (_) {}
      }
    } catch (err) {
      console.warn('[MainBridge] EXT_ATTACH error', err);
    }
  });

  window.addEventListener('EXT_SET_TEXT', (ev) => {
    try {
      const d = ev.detail || {};
      const text = d.text || '';
      const shadowRoots = collectShadowRoots();
      const sel = findFirst(d.selectors || [], shadowRoots);
      if (!sel) return;
      if ('value' in sel) {
        setNativeValue(sel, text);
      } else {
        sel.textContent = text;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (err) {
      console.warn('[MainBridge] EXT_SET_TEXT error', err);
    }
  });
})();
