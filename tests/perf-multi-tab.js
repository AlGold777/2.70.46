/**
 * Simple Playwright harness to measure timings for:
 *  - Opening N tabs
 *  - Finding composer
 *  - Typing prompt
 *  - Clicking send
 *
 * Usage:
 *   1) npm i playwright   (if not installed)
 *   2) node tests/perf-multi-tab.js
 *
 * Adjust the CONFIG below for your platform (selectors + URLs + prompt).
 */
const { chromium } = require('playwright');

// Allow overriding userDataDir/headless via CLI flags or env:
//   node tests/perf-multi-tab.js --userDataDir="/path/to/profile" --headless=true
const argv = process.argv.slice(2);
const getFlag = (name, fallback) => {
  const prefixed = `--${name}=`;
  const direct = argv.find((a) => a.startsWith(prefixed));
  if (direct) return direct.slice(prefixed.length);
  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  if (process.env[name.toUpperCase()]) return process.env[name.toUpperCase()];
  return fallback;
};
const getBoolFlag = (name, fallback) => {
  const raw = getFlag(name, null);
  if (raw == null) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
};

const urlsFlag = getFlag('urls', null);
const promptFlag = getFlag('prompt', null);

const CONFIG = {
  headless: false,
  usePersistentContext: true, // set true to reuse /tmp/pw-home for logged-in sessions
  userDataDir: getFlag(
    'userDataDir',
    require('path').join(require('os').tmpdir(), 'pw-home', 'profile')
  ),
  headlessFlag: getFlag('headless', null),
  prompt: promptFlag || 'Test prompt',
  keepOpen: getBoolFlag('keepOpen', true), // можно переопределить: --keepOpen=false
  urls: urlsFlag ? urlsFlag.split(',').map((u) => u.trim()).filter(Boolean) : [
    'https://chat.openai.com/',
    'https://chatgpt.com/',
    'https://claude.ai/',
    'https://gemini.google.com/',
    'https://grok.com/',
    'https://www.perplexity.ai/',
    'https://chat.deepseek.com/',
    'https://chat.qwen.ai/'
  ],
  selectors: {
    // NOTE: :visible is important because many platforms keep hidden fallback textareas (e.g. wcDTda_fallbackTextarea / reCAPTCHA).
    composer: 'textarea:visible, div[contenteditable="true"]:visible, [role="textbox"]:visible',
    sendButton: [
      'button[data-testid*="send"]:not([disabled]):visible',
      'button[aria-label*="Send"]:not([disabled]):visible',
      'button[type="submit"]:not([disabled]):visible',
      'button:not([disabled]):has-text("Send"):visible'
    ].join(', '),
    perUrl: {
      'chat.openai.com': {
        composer: [
          'textarea[data-testid="prompt-textarea"]:visible',
          'textarea[name="prompt-textarea"]:visible',
          'textarea#prompt-textarea:visible',
          'div[contenteditable="true"][role="textbox"]:visible',
          '[role="textbox"]:visible'
        ].join(', '),
        sendButton: [
          'button[data-testid="send-button"]:not([disabled]):visible',
          'button[aria-label*="Send"]:not([disabled]):visible',
          'button[type="submit"]:not([disabled]):visible'
        ].join(', ')
      },
      'chatgpt.com': {
        composer: [
          'textarea[data-testid="prompt-textarea"]:visible',
          'textarea[name="prompt-textarea"]:visible',
          'textarea#prompt-textarea:visible',
          'div[contenteditable="true"][role="textbox"]:visible',
          '[role="textbox"]:visible'
        ].join(', '),
        sendButton: [
          'button[data-testid="send-button"]:not([disabled]):visible',
          'button[aria-label*="Send"]:not([disabled]):visible',
          'button[type="submit"]:not([disabled]):visible'
        ].join(', ')
      },
      'grok.com': {
        composer: [
          'div[contenteditable="true"].ProseMirror:visible',
          'div[contenteditable="true"][role="textbox"]:visible',
          '[role="textbox"]:visible',
          'textarea:visible'
        ].join(', '),
        sendButton: [
          'button[aria-label*="Send"]:not([disabled]):visible',
          'button[type="submit"]:not([disabled]):visible',
          'button:not([disabled]):has-text("Send"):visible'
        ].join(', ')
      },
      'chat.deepseek.com': {
        composer: [
          'textarea:not([name="g-recaptcha-response"]):visible',
          'div[contenteditable="true"]:visible',
          '[role="textbox"]:visible'
        ].join(', '),
        sendButton: [
          'button[aria-label*="Send"]:not([disabled]):visible',
          'button[type="submit"]:not([disabled]):visible',
          'button:not([disabled]):has-text(\"Send\"):visible'
        ].join(', ')
      },
      'chat.qwen.ai': {
        composer: 'div[contenteditable="true"][role="textbox"]:visible, textarea:visible',
        sendButton: 'button:not([disabled]):has-text("Send"):visible, button[data-testid*="send"]:not([disabled]):visible, button[aria-label*="Send"]:not([disabled]):visible, button[type="submit"]:not([disabled]):visible'
      },
      'chat.mistral.ai': {
        composer: 'div[contenteditable="true"]:visible, textarea:visible, [data-testid*="textarea"]:visible',
        sendButton: 'button[data-testid*="send"]:not([disabled]):visible, button:not([disabled]):has-text("Send"):visible, button[type="submit"]:not([disabled]):visible'
      }
    }
  },
  timeouts: {
    nav: 20000,
    composer: 15000,
    send: 5000
  }
};

async function measureTab(page, url, cfg) {
  const result = {
    url,
    tNav: null,
    tComposer: null,
    tType: null,
    tSend: null,
    error: null
  };
  const start = Date.now();
  try {
    await page.goto(url, { timeout: cfg.timeouts.nav, waitUntil: 'domcontentloaded' });
    result.tNav = Date.now() - start;

    const u = new URL(url);
    const overrides = cfg.selectors.perUrl?.[u.host] || {};
    const composerSelector = overrides.composer || cfg.selectors.composer;
    const sendSelector = overrides.sendButton || cfg.selectors.sendButton;

    const composerStart = Date.now();
    const composer = page.locator(composerSelector).first();
    await composer.waitFor({ state: 'visible', timeout: cfg.timeouts.composer });
    result.tComposer = Date.now() - composerStart;

    const typeStart = Date.now();
    await composer.fill(cfg.prompt);
    result.tType = Date.now() - typeStart;

    const sendStart = Date.now();
    try {
      const send = page.locator(sendSelector).first();
      await send.waitFor({ state: 'visible', timeout: cfg.timeouts.send });
      await send.click({ timeout: cfg.timeouts.send });
      result.tSend = Date.now() - sendStart;
    } catch (sendErr) {
      // Fallback: press Enter in composer if button is missing/disabled (some platforms hide/disable the button)
      await composer.press('Enter');
      result.tSend = Date.now() - sendStart;
    }
  } catch (err) {
    result.error = err.message || String(err);
  }
  return result;
}

async function main() {
  const fs = require('fs');
  const armPath = '/Users/restart/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  const x64Path = '/Users/restart/Library/Caches/ms-playwright/chromium-1200/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  const execPath = fs.existsSync(armPath)
    ? armPath
    : fs.existsSync(x64Path)
      ? x64Path
      : chromium.executablePath();

  // Гарантируем существование профиля и фиксируем параметры запуска для диагностики.
  if (CONFIG.usePersistentContext && CONFIG.userDataDir) {
    fs.mkdirSync(CONFIG.userDataDir, { recursive: true });
  }
  console.log(
    `[perf-multi-tab] launch with execPath="${execPath}", persistent=${CONFIG.usePersistentContext}, ` +
    `userDataDir="${CONFIG.userDataDir}", headless=${CONFIG.headlessFlag ?? CONFIG.headless}`
  );

  let context;
  let browser;
  if (CONFIG.usePersistentContext) {
    browser = await chromium.launchPersistentContext(CONFIG.userDataDir, {
      headless: CONFIG.headlessFlag ? CONFIG.headlessFlag === 'true' : CONFIG.headless,
      executablePath: execPath,
      viewport: { width: 1280, height: 720 },
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-crash-reporter',
        '--disable-crashpad'
      ],
      timeout: 60000
    });
    context = browser;
  } else {
    browser = await chromium.launch({
      headless: CONFIG.headlessFlag ? CONFIG.headlessFlag === 'true' : CONFIG.headless,
      executablePath: execPath,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-crashpad']
    });
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  }

  const rows = [];
  for (const url of CONFIG.urls) {
    const page = await context.newPage();
    const res = await measureTab(page, url, CONFIG);
    rows.push(res);
    if (!CONFIG.keepOpen) {
      await page.close().catch(() => {});
    }
  }

  if (!CONFIG.keepOpen) {
    await browser.close();
  }

  const header = ['#', 'URL', 'Nav(ms)', 'Composer(ms)', 'Type(ms)', 'Send(ms)', 'Error'];
  console.log(header.join('\t'));
  rows.forEach((r, idx) => {
    console.log([
      idx + 1,
      r.url,
      r.tNav ?? '-',
      r.tComposer ?? '-',
      r.tType ?? '-',
      r.tSend ?? '-',
      r.error ?? ''
    ].join('\t'));
  });

  // Если оставляем окно открытым — даём пользователю управлять вкладками вручную.
  if (CONFIG.keepOpen) {
    console.log('\n[perf-multi-tab] Вкладки оставлены открытыми. Закройте их вручную и завершите процесс Ctrl+C.');
    await new Promise(() => {});
  }
}

main().catch((err) => {
  console.error('Perf harness failed:', err);
  process.exit(1);
});
