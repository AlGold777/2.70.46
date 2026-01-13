# Перф-харнесс для открытия вкладок и отправки запроса

Этот сценарий (tests/perf-multi-tab.js) на Playwright измеряет время:
- навигации к странице,
- поиска поля ввода (composer),
- ввода текста,
- клика по кнопке отправки.

## Быстрый запуск
1) Установите Playwright (если не установлен): `npm i playwright`
2) Запустите: `node tests/perf-multi-tab.js`

## Пошагово: логин в persistent профиле и повтор
1) Первый прогон (оставить вкладки открытыми):  
`node tests/perf-multi-tab.js --keepOpen=true --userDataDir=".pw-profile/perf"`  
2) В открывшихся вкладках вручную залогиньтесь (и пройдите капчи, если есть).
3) Остановите процесс `Ctrl+C` (профиль останется на диске).
4) Повторите замер с тем же профилем:  
`node tests/perf-multi-tab.js --keepOpen=false --userDataDir=".pw-profile/perf"`

## Полезные флаги
- `--urls="https://chat.qwen.ai/,https://www.perplexity.ai/"` — прогон только нужных платформ.
- `--prompt="..."` — текст запроса.
- `--headless=true|false` — режим браузера.

## Что настраивается
В начале файла задайте:
- `urls` — список из 8 URL платформ.
- `selectors.composer` и `selectors.sendButton` — под ваши платформы.
- `prompt` — текст запроса.
- `timeouts` — время ожидания навигации/композитора/кнопки.

## Типовые проблемы (и почему добавлен `:visible`)
- Многие платформы держат скрытые fallback-элементы (например, скрытый textarea у ChatGPT или `g-recaptcha-response` у DeepSeek); без `:visible` Playwright может «выбрать первый матч» и зависнуть на ожидании видимости.
- Для динамических UI (например, Grok) надёжнее использовать `locator()` вместо `elementHandle`, чтобы переживать re-render.

## Вывод
Сценарий печатает TSV-таблицу: №, URL, Nav(ms), Composer(ms), Type(ms), Send(ms), Error.
Если селектор не найден или кнопка недоступна, поле Error содержит текст ошибки.

## Ограничения
- Сценарий не загружает расширение, работает как чистый браузер.
- Для каждой платформы возможно понадобится логин; добавьте куки/контекст в Playwright при необходимости.
- Для логики вкладок/селекторов расширения (dispatch, health ping, PROMPT_SUBMITTED) используйте DevTools/Diagnostics внутри `result_new.html`, а не Playwright‑харнесс.
