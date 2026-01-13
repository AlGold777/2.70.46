(function () {
  const globalObject = typeof window !== 'undefined' ? window : self;
  if (globalObject.Humanoid) {
    console.warn('[Humanoid] Duplicate load prevented');
    return;
  }

  globalObject.LLMExtension = globalObject.LLMExtension || {};

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const randomBetween = (min, max) => Math.random() * (max - min) + min;

  class CursorGhost {
    constructor() {
      this.node = null;
      this.styleNode = null;
      this.enabled = this.shouldEnable();
      this.hideTimer = null;
      if (this.enabled) {
        this.ensure();
      }
    }

    shouldEnable() {
      try {
        return localStorage.getItem('__debug_cursor') === 'true';
      } catch (_) {
        return false;
      }
    }

    enable() {
      this.enabled = true;
      this.ensure();
    }

    disable() {
      this.enabled = false;
      if (this.node?.parentNode) this.node.parentNode.removeChild(this.node);
      if (this.styleNode?.parentNode) this.styleNode.parentNode.removeChild(this.styleNode);
      this.node = null;
      this.styleNode = null;
      if (this.hideTimer) clearTimeout(this.hideTimer);
    }

    ensure() {
      if (this.node) return;
      const style = document.createElement('style');
      style.id = 'cursor-ghost-style';
      style.textContent = `
        #cursor-ghost {
          position: fixed;
          width: 16px;
          height: 16px;
          margin: -8px 0 0 -8px;
          border: 2px solid rgba(255,138,0,0.95);
          border-radius: 50%;
          background: rgba(255,138,0,0.25);
          pointer-events: none;
          z-index: 2147483647;
          transition: transform 0.25s ease, opacity 0.4s ease;
          opacity: 0;
        }
      `;
      const node = document.createElement('div');
      node.id = 'cursor-ghost';
      document.documentElement.appendChild(style);
      document.documentElement.appendChild(node);
      this.node = node;
      this.styleNode = style;
    }

    move(x, y) {
      if (!this.enabled) {
        if (!this.shouldEnable()) return;
        this.enable();
      }
      if (!this.node) this.ensure();
      if (!this.node) return;
      this.node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      this.node.style.opacity = '1';
      if (this.hideTimer) clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => {
        if (this.node) this.node.style.opacity = '0';
      }, 900);
    }
  }

  const cursorGhost = new CursorGhost();
  globalObject.LLMExtension.cursorGhost = cursorGhost;

  class MouseSimulator {
    constructor() {
      this.currentX = (globalObject.innerWidth || 0) / 2;
      this.currentY = (globalObject.innerHeight || 0) / 2;
    }

    dispatchMouseMove(x, y) {
      this.currentX = x;
      this.currentY = y;
      const evt = new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        movementX: 0,
        movementY: 0,
        view: globalObject
      });
      globalObject.dispatchEvent(evt);
      cursorGhost.move(x, y);
    }

    async moveTo(x, y) {
      const steps = 4;
      const startX = this.currentX;
      const startY = this.currentY;
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad
        const jitterX = (Math.random() - 0.5) * 6;
        const jitterY = (Math.random() - 0.5) * 3;
        this.dispatchMouseMove(
          startX + (x - startX) * eased + jitterX,
          startY + (y - startY) * eased + jitterY
        );
        await sleep(12 + Math.random() * 18);
      }
    }

    async scrollWithMouse(deltaY) {
      const steps = Math.abs(deltaY) > 500 ? 5 : 3;
      const stepAmount = deltaY / steps;
      for (let i = 0; i < steps; i += 1) {
        const jitterX = (Math.random() - 0.5) * 20;
        const jitterY = (Math.random() - 0.5) * 10;
        this.dispatchMouseMove(
          this.currentX + jitterX,
          this.currentY + jitterY
        );
        globalObject.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: stepAmount,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          clientX: this.currentX,
          clientY: this.currentY
        }));
        await sleep(100 + Math.random() * 100);
      }
    }
  }

  const READING_CONFIG = {
    WPM_SLOW: 150,
    WPM_NORMAL: 250,
    WPM_FAST: 350,
    AVG_WORD_LENGTH: 5,
    PARAGRAPH_PAUSE_MS: 500,
    SECTION_PAUSE_MS: 1000,
    SCROLL_STEP_PX: 100,
    SCROLL_PAUSE_MS: 200
  };

  class ReadingSimulator {
    constructor(mouseSimulator) {
      this.wpm = READING_CONFIG.WPM_NORMAL;
      this.isReading = false;
      this.mouseSimulator = mouseSimulator;
    }

    setSpeed(speed) {
      if (speed === 'slow') this.wpm = READING_CONFIG.WPM_SLOW;
      else if (speed === 'fast') this.wpm = READING_CONFIG.WPM_FAST;
      else this.wpm = READING_CONFIG.WPM_NORMAL;
    }

    calculateReadingTime(text) {
      if (!text) return 0;
      const words = text.length / READING_CONFIG.AVG_WORD_LENGTH;
      const minutes = words / this.wpm;
      const variation = 0.8 + Math.random() * 0.4;
      return Math.round(minutes * 60 * 1000 * variation);
    }

    async readPage(durationMs = 1500) {
      if (this.isReading) return;
      this.isReading = true;
      try {
        const startTime = Date.now();
        while (Date.now() - startTime < durationMs) {
          const action = Math.random();
          if (action < 0.4) {
            const scrollAmount = (Math.random() - 0.3) * READING_CONFIG.SCROLL_STEP_PX * 2;
            if (this.mouseSimulator) {
              await this.mouseSimulator.scrollWithMouse(scrollAmount);
            } else {
              globalObject.scrollBy({ top: scrollAmount, behavior: 'smooth' });
            }
          } else if (action < 0.7 && this.mouseSimulator) {
            const x = this.mouseSimulator.currentX + (Math.random() - 0.5) * 100;
            const y = this.mouseSimulator.currentY + (Math.random() - 0.5) * 50;
            const safeX = Math.max(50, Math.min((globalObject.innerWidth || 0) - 50, x));
            const safeY = Math.max(50, Math.min((globalObject.innerHeight || 0) - 50, y));
            await this.mouseSimulator.moveTo(safeX, safeY);
          } else {
            await sleep(200 + Math.random() * 300);
          }
          await sleep(100 + Math.random() * 200);
        }
      } finally {
        this.isReading = false;
      }
    }

    async readElement(element) {
      if (!element) return;
      const text = element.textContent || '';
      const readingTime = this.calculateReadingTime(text);
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(300);
      await this.readPage(readingTime);
    }

    async preInputScan() {
      await this.readPage(500 + Math.random() * 500);
    }
  }

  const mouseSimulator = new MouseSimulator();
  const readingSimulator = new ReadingSimulator(mouseSimulator);
  globalObject.LLMExtension.mouseSimulator = mouseSimulator;
  globalObject.LLMExtension.readingSimulator = readingSimulator;


  const getScrollToolkit = (() => {
    let cached = null;
    let failed = false;
    return () => {
      if (cached) return cached;
      if (failed) return null;
      try {
        const Toolkit = window.__UniversalScrollToolkit;
        if (!Toolkit) return null;
        cached = new Toolkit({
          idleThreshold: 900,
          driftStepMs: 40,
          maxShadowDepth: 6,
          maxIframeDepth: 3
        });
        return cached;
      } catch (err) {
        console.warn('[Humanoid] ScrollToolkit init failed', err);
        failed = true;
        return null;
      }
    };
  })();

  const isElement = (value) => value && typeof value === 'object' && value instanceof Element;

  const ensureElement = (element) => {
    if (!isElement(element)) {
      throw new Error('[Humanoid] Provided target is not a valid DOM element');
    }
    return element;
  };

  const dispatchMouseEvent = (element, type) => {
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2 + randomBetween(-3, 3);
    const clientY = rect.top + rect.height / 2 + randomBetween(-3, 3);
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY
    });
    element.dispatchEvent(event);
  };

//-- 1.1. Надёжный плавный скролл: вычисляет целевую позицию и использует native smooth, а при отсутствии — rAF-фоллбек --//
const scrollIntoViewSmoothly = async (element) => {
  try {
    const toolkit = getScrollToolkit();
    if (toolkit?.scrollElementIntoView) {
      await toolkit.scrollElementIntoView(element, { settle: true, offset: 18 });
      return;
    }
  } catch (_) {
    // fallback ниже
  }
  const rect = element.getBoundingClientRect();
  const elementCenterY = rect.top + rect.height / 2 + window.scrollY;
  const targetY = Math.max(0, Math.round(elementCenterY - window.innerHeight / 2));

  // Если браузер поддерживает объектный аргумент для scrollTo - используем native smooth
  try {
    if (typeof window.scrollTo === 'function') {
      window.scrollTo({ top: targetY, behavior: 'smooth' });
      const start = Date.now();
      // Ждём завершения (или таймаут) — с небольшими паузами, чтобы не блокировать поток
      while (Math.abs(window.scrollY - targetY) > 2 && Date.now() - start < 1200) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(30);
      }
    } else {
      throw new Error('no-native-scroll');
    }
  } catch (_) {
    // rAF fallback: плавная анимация с easeInOut
    const startY = window.scrollY;
    const delta = targetY - startY;
    const duration = 420 + Math.floor(Math.random() * 160);
    await new Promise((resolve) => {
      let startTs = null;
      function step(ts) {
        if (!startTs) startTs = ts;
        const t = Math.min(1, (ts - startTs) / duration);
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad
        window.scrollTo(0, Math.round(startY + delta * ease));
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
  }

  await sleep(randomBetween(120, 220));
};




  const dispatchInputEvent = (element, data = '', inputType = 'insertText') => {
    try {
      const inputEvent = new InputEvent('input', { data, bubbles: true, inputType });
      element.dispatchEvent(inputEvent);
    } catch (_) {
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  const setCaretToEnd = (element) => {
    try {
      element.focus({ preventScroll: true });
    } catch (_) {
      element.focus();
    }
    const selection = window.getSelection?.();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const sanitizeValue = (value) => String(value ?? '').replace(/\u200b/g, '');

  const readElementValue = (element) => {
    if (!element) return '';
    if (typeof element.value === 'string') return sanitizeValue(element.value);
    if (typeof element.innerText === 'string' && element.innerText.trim()) return sanitizeValue(element.innerText);
    if (typeof element.textContent === 'string') return sanitizeValue(element.textContent);
    return '';
  };

  const replaceContentEditableText = (element, text) => {
    const selection = window.getSelection?.();
    const normalized = sanitizeValue(text);
    try {
      element.focus({ preventScroll: true });
    } catch (_) {
      element.focus?.();
    }

    let range = null;
    if (selection) {
      range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    let execOk = false;
    try {
      if (typeof InputEvent === 'function') {
        const beforeEvent = new InputEvent('beforeinput', {
          data: normalized,
          inputType: 'insertReplacementText',
          bubbles: true,
          cancelable: true
        });
        element.dispatchEvent(beforeEvent);
        if (beforeEvent.defaultPrevented) {
          execOk = true;
        } else if (document.execCommand) {
          execOk = document.execCommand('insertText', false, normalized);
        }
      } else if (document.execCommand) {
        execOk = document.execCommand('insertText', false, normalized);
      }
    } catch (_) {
      execOk = false;
    }

    if (!execOk && range) {
      range.deleteContents();
      range.insertNode(document.createTextNode(normalized));
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    if (!execOk && typeof element.textContent === 'string') {
      element.textContent = normalized;
    }
    element.dispatchEvent(new InputEvent('input', {
      data: normalized,
      inputType: 'insertFromPaste',
      bubbles: true
    }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    setCaretToEnd(element);
  };

  const typeCharacter = async (element, char, isContentEditable) => {
    const keyboardEventInit = {
      bubbles: true,
      cancelable: true,
      key: char,
      char,
      keyCode: char.charCodeAt(0),
      which: char.charCodeAt(0)
    };
    element.dispatchEvent(new KeyboardEvent('keydown', keyboardEventInit));
    element.dispatchEvent(new KeyboardEvent('keypress', keyboardEventInit));

    if (isContentEditable) {
      setCaretToEnd(element);
      const execSucceeded = document.execCommand && document.execCommand('insertText', false, char);
      if (!execSucceeded) {
        const selection = window.getSelection?.();
        const range = selection && selection.rangeCount ? selection.getRangeAt(0) : document.createRange();
        if (range) {
          range.deleteContents();
          const textNode = document.createTextNode(char);
          range.insertNode(textNode);
          range.setStartAfter(textNode);
          range.setEndAfter(textNode);
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
      }
    } else if ('value' in element) {
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? element.value.length;
      const newValue = `${element.value.slice(0, start)}${char}${element.value.slice(end)}`;
      element.value = newValue;
      element.selectionStart = element.selectionEnd = start + 1;
    }

    dispatchInputEvent(element, char);
    element.dispatchEvent(new KeyboardEvent('keyup', keyboardEventInit));
  };

  const humanoid = {
    async lookAt(target) {
      const element = ensureElement(target);
      await scrollIntoViewSmoothly(element);
      await sleep(randomBetween(180, 320));
    },

    async moveTo(target) {
      const element = ensureElement(target);
      await this.lookAt(element);
      dispatchMouseEvent(element, 'mouseover');
      await sleep(randomBetween(60, 140));
    },

    async humanScroll(distance, options = {}) {
      const target = options.targetNode?.element || options.targetNode || window;
      try {
        if (mouseSimulator) {
          await mouseSimulator.scrollWithMouse(distance);
          return true;
        }
      } catch (err) {
        console.warn('[Humanoid] humanScroll via MouseSimulator failed, continue', err);
      }
      try {
        const toolkit = getScrollToolkit();
        if (toolkit?.humanScrollBy) {
          await toolkit.humanScrollBy(distance, Object.assign({ settle: true }, options));
          return true;
        }
      } catch (err) {
        console.warn('[Humanoid] humanScroll via ScrollToolkit failed, fallback', err);
      }

      if (target && typeof target.scrollBy === 'function') {
        try {
          target.scrollBy({ top: distance, behavior: 'smooth' });
        } catch (_) {
          target.scrollTop += distance;
        }
      } else {
        window.scrollBy({ top: distance, behavior: 'smooth' });
      }
      await sleep(Math.min(Math.max(Math.abs(distance) * 0.4, 120), 600));
      return false;
    },

    async click(target) {
      const element = ensureElement(target);
      await this.moveTo(element);
      dispatchMouseEvent(element, 'mousedown');
      await sleep(randomBetween(30, 90));
      dispatchMouseEvent(element, 'mouseup');
      element.click();
      await sleep(randomBetween(90, 180));
    },

    async typeText(target, text, options = {}) {
      const element = ensureElement(target);
      const wpm = Number.isFinite(options.wpm) ? Math.max(20, options.wpm) : 120;
      const averageMsPerChar = (60000 / (wpm * 5)) * randomBetween(0.9, 1.1);
      /*.  Включаем выключаем печать посимвольно */
      /* const useInstantMode = options.instant === true || options.mode === 'instant';*/
      //-- 1.1. Принудительно вставлять весь текст целиком (instant mode) --//
      const useInstantMode = true;


      
      const isContentEditable = element.isContentEditable || element.getAttribute?.('contenteditable') === 'true';

      await this.lookAt(element);
      await this.click(element);

      if (!isContentEditable && 'value' in element) {
        element.value = '';
        dispatchInputEvent(element, '', 'deleteContentBackward');
      } else if (!isContentEditable) {
        element.textContent = '';
        dispatchInputEvent(element, '', 'deleteContentBackward');
      }

      if (useInstantMode) {
        if (isContentEditable) {
          replaceContentEditableText(element, text);
        } else if ('value' in element) {
          const normalized = sanitizeValue(text);
          element.value = normalized;
          element.selectionStart = element.selectionEnd = element.value.length;
          dispatchInputEvent(element, normalized, 'insertFromPaste');
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          const normalized = sanitizeValue(text);
          element.textContent = normalized;
          dispatchInputEvent(element, normalized, 'insertFromPaste');
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await sleep(randomBetween(120, 220));
        if (readElementValue(element).trim().length) {
          return;
        }
        console.warn('[Humanoid:typeText] Instant insertion empty, falling back to manual typing');
      }

      for (const char of String(text)) {
        await typeCharacter(element, char, isContentEditable);
        const jitter = randomBetween(-averageMsPerChar * 0.2, averageMsPerChar * 0.2);
        await sleep(Math.max(30, averageMsPerChar + jitter));
      }
      await sleep(randomBetween(120, 220));
    },

    async readPage(durationMs = 1500) {
      const end = Date.now() + durationMs;
      while (Date.now() < end) {
        const direction = Math.random() > 0.5 ? 1 : -1;
        const distance = randomBetween(150, 450) * direction;
        window.scrollBy({ top: distance, behavior: 'smooth' });
        await sleep(randomBetween(180, 320));
      }
      await sleep(randomBetween(150, 280));
    }
  };

  globalObject.Humanoid = humanoid;

})();
