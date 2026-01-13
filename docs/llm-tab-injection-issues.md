## Multi-LLM injection issues — summary for external review

Цель: зафиксировать все найденные блокеры при запуске промпта в Grok / LeChat / Perplexity, чтобы сторонняя модель могла быстро понять контекст.

### Наблюдавшиеся ошибки
- `content-perplexity.js:724 Uncaught SyntaxError: missing ) after argument list` — остаток Python f-string в `findAndCacheElement` ломал загрузку всего скрипта Perplexity.
- `unified-answer-pipeline.js:12 [UnifiedAnswerPipeline] Missing dependencies (modules/config/selectors/watcher/sanity)` — падает, когда один из модулей не загрузился (часто из-за синтакс-ошибки выше).
- CSP: `Executing inline script violates... fetch-monitor.js` — inline-инъекция fetch hook блокировалась CSP.
- ERR_FAILED при ленивой загрузке `scroll-toolkit.js` / `humanoid.js` — не были в `web_accessible_resources`.
- Grok parse error: `Invalid optional chain from new expression` — конструкция `new Modules.TabProtector?.()` ломала парсинг.
- Perplexity CF Access: CORS/redirect на `perplexity-ai.cloudflareaccess.com` блокирует ресурсы без прохождения логина.
- `[SelectorConfig] Duplicate load prevented` — вторичная загрузка после того, как первичная упала; сама по себе не критична.

### Применённые исправления
- Perplexity: исправлена f-string на template literal в `content-scripts/content-perplexity.js` (строка с `findAndCacheElement`).
- Unified pipeline: заменён `new Modules.TabProtector?.()` на условный `new Modules.TabProtector()` без optional chaining (`content-scripts/unified-answer-pipeline.js`).
- Fetch monitor: вынесен hook в `content-scripts/fetch-monitor-bridge.js` и подключён через `src` вместо inline (`content-scripts/fetch-monitor.js`, манифест).
- Manifest: добавлены в `web_accessible_resources` `fetch-monitor-bridge.js`, `scroll-toolkit.js`, `humanoid.js` для ленивой загрузки.
- Тесты: `npm test -- --runInBand` проходят локально (есть только jsdom предупреждения про `window.scrollBy`).
- Tabs/dispatch: добавлен сериализованный диспетчер отправки промпта по вкладкам + подтверждение `PROMPT_SUBMITTED`, чтобы не зависеть от ручной активации вкладки и не ловить “залипание фокуса”. Файлы: `background.js`, `content-scripts/content-*.js`.
- Focus: отключена самoактивация вкладки пайплайном (config `preparation.allowTabActivation=false`), чтобы не было “войны фокусов”. Файлы: `content-scripts/pipeline-config.js`, `content-scripts/unified-answer-pipeline.js`.
- Claude/Perplexity: main‑world bridge больше не вставляется inline (CSP), теперь подключается как `script.src` на `content-scripts/content-bridge.js`. Файлы: `content-scripts/content-claude.js`, `content-scripts/content-perplexity.js`.
- Perplexity: убрана двойная вставка промпта (main-world setText + humanoid typing), теперь используется детерминированная установка значения. Файл: `content-scripts/content-perplexity.js`.

### Текущее состояние по платформам
- GPT / Gemini / Qwen: запускаются без изменений; скрипты грузятся, промпт доставляется.
- Grok: после фикса optional chaining парсинг нормализован; требуется проверить ввод/селекторы.
- LeChat: аналогично Grok; нужно проверять ввод/EXT_SET_TEXT.
- Perplexity: синтаксис исправлен, но если страница под Cloudflare Access (CORS на restricted-resource), промпт не дойдёт без прохождения access/login.
- Grok / Qwen / DeepSeek: UI может быть медленным на “Send”; для них timeout подтверждения `PROMPT_SUBMITTED` поднят до 9 сек (остальные — 7 сек).
- GPT: на некоторых сессиях Send активируется позже (React/disabled→enabled). Для GPT увеличен timeout `PROMPT_SUBMITTED` до 12 сек и добавлен poll “wait send enabled” до 2.5 сек.
- DeepSeek: исправлен выбор composer/send (убраны Grok‑селекторы + защита от `g-recaptcha-response`).
- Qwen: вставка промпта делается “instant” (без долгого human‑typing), sendButton берётся через `SelectorFinder` (если доступен).
- Grok: подтверждение отправки стало “мягким” — если старт ответа медленный, скрипт не падает на `send_failed`, а продолжает ждать ответ; `PROMPT_SUBMITTED` шлётся с `meta.confirmed`.

### Что проверить в браузере
1) После перезагрузки расширения открыть Perplexity/Grok/LeChat и убедиться, что в console нет SyntaxError.
2) Для Perplexity пройти CF Access/login, чтобы снять CORS-блок.
3) Проверить, появляются ли логи `[UnifiedAnswerPipeline] Missing dependencies` — если да, прислать актуальный console log (с указанием строки), значит какой-то модуль всё ещё не грузится.
4) Проверить доставку промпта: наличие `[content-xxx] ... GET_ANSWER`, селектор composer/send, срабатывание EXT_SET_TEXT.

### Файлы, которые правились
- `content-scripts/content-perplexity.js` — фикса синтаксиса.
- `content-scripts/unified-answer-pipeline.js` — TabProtector без optional chaining.
- `content-scripts/fetch-monitor.js`, `content-scripts/fetch-monitor-bridge.js` — CSP-safe hook.
- `manifest.json` — web_accessible_resources обновлены.
