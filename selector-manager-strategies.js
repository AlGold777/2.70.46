(function () {
  const globalObject = typeof window !== 'undefined' ? window : self;
  if (globalObject.SelectorManagerStrategies) return;

  const wrapResult = (element, confidence) => {
    if (!element || !(element instanceof Element)) return null;
    return { element, confidence };
  };

  const getTextContent = (node) => (node?.innerText || node?.textContent || '').trim();

  const findTextualDescendant = (root) => {
    if (!root || !(root instanceof Element)) return null;
    const preferred = root.querySelector?.('article, [data-testid*="answer"], .prose');
    if (preferred) {
      const text = getTextContent(preferred);
      if (text.length > 0) return preferred;
    }
    return getTextContent(root).length > 0 ? root : null;
  };

  globalObject.SelectorManagerStrategies = {
    composer: [
      () => {
        const candidates = Array.from(document.querySelectorAll('textarea, textarea[placeholder], textarea[data-testid], textarea[data-qa]'));
        const element = candidates.find((el) => {
          const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
          const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
          const rect = el.getBoundingClientRect?.();
          const sizeOk = rect && rect.width >= 200 && rect.height >= 40;
          const matchesPlaceholder = /\b(ask|type|message|prompt|question)\b/.test(`${placeholder} ${ariaLabel}`);
          return el && el instanceof Element && (matchesPlaceholder || sizeOk);
        });
        return wrapResult(element, 95);
      },
      () => {
        const contentEditable = Array.from(document.querySelectorAll('div[contenteditable="true"], [role="textbox"]'));
        const element = contentEditable.find((el) => {
          const rect = el.getBoundingClientRect?.();
          const sizeOk = rect && rect.width >= 200 && rect.height >= 40;
          const parent = el.closest('[class*="composer"], [class*="input"], [data-testid*="composer"]');
          return el && el instanceof Element && (sizeOk || parent);
        });
        return wrapResult(element, 85);
      },
      () => {
        const forms = Array.from(document.querySelectorAll('form, section, main'));
        for (const form of forms) {
          const candidate = form.querySelector('div[contenteditable="true"], textarea, [role="textbox"]');
          if (candidate && candidate instanceof Element) {
            return wrapResult(candidate, 78);
          }
        }
        return null;
      }
    ],
    sendButton: [
      (reference) => {
        const container = reference?.closest?.('form, div, section') || document;
        const candidate = container.querySelector?.('button[aria-label*="send" i], button[aria-label*="submit" i]');
        return wrapResult(candidate, 90);
      },
      (reference) => {
        const searchScope = reference?.parentElement || document;
        const buttons = Array.from(searchScope.querySelectorAll('button, div[role="button"], span[role="button"]'));
        const element = buttons.find((btn) => {
          const label = (btn.getAttribute('aria-label') || btn.innerText || '').toLowerCase();
          const hasSvg = !!btn.querySelector('svg');
          const rect = btn.getBoundingClientRect?.();
          const isPositionedRight = reference && rect && reference.getBoundingClientRect && rect.left >= reference.getBoundingClientRect().right - 10;
          return btn && btn instanceof Element && (/\b(send|post|submit|ответ)\b/.test(label) || hasSvg || isPositionedRight);
        });
        const confidence = element ? (/\b(send|post|submit|ответ)\b/.test((element.getAttribute('aria-label') || element.innerText || '').toLowerCase()) ? 85 : 75) : 0;
        return wrapResult(element, confidence);
      },
      (reference) => {
        if (reference) {
          const siblingButton = reference.parentElement?.querySelector?.('button[type="submit"], button[data-testid*="send"]');
          if (siblingButton && siblingButton instanceof Element) return wrapResult(siblingButton, 82);
        }
        const btn = document.querySelector('button[type="submit"], button[data-testid*="send"]');
        return wrapResult(btn, btn ? 75 : 0);
      }
    ],
    response: [
      () => {
        const roles = Array.from(document.querySelectorAll('[role="log"], [role="main"], [role="feed"]'));
        const element = roles.map(findTextualDescendant).find(Boolean);
        return wrapResult(element, element ? 85 : 0);
      },
      () => {
        const classes = Array.from(document.querySelectorAll('[class*="message"], [class*="response"], [class*="chat"], [class*="conversation"]'));
        const element = classes.map(findTextualDescendant).find(Boolean);
        return wrapResult(element, element ? 80 : 0);
      },
      () => {
        const articles = Array.from(document.querySelectorAll('article'));
        for (let i = articles.length - 1; i >= 0; i--) {
          const el = articles[i];
          const text = (el.innerText || el.textContent || '').trim();
          if (el && el instanceof Element && text.length > 0) return wrapResult(el, 60);
        }
        return null;
      }
    ]
  };
})();
