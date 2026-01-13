## Change Log — Codex Agent (start 2025-11-30)

### 2026-01-11 11:12 — v2.70.54

- Для чего: синхронизировать боковые блоки селекторов с выбранной моделью Workbench. Изменение: Active selectors, Overrides history, Saved Overrides и Candidates рендерятся по выбранной Platform и обновляются при смене модели. Файл: `results.js`.
- Для чего: показать Saved Overrides как отдельный сворачиваемый блок. Изменение: добавлен блок Saved Overrides и идентификаторы списков боковой панели. Файл: `result_new.html`.
- Для чего: улучшить читаемость списков в боковых блоках. Изменение: добавлены стили строк, лейблов и чипов селекторов. Файл: `styles.css`.
- Для чего: зафиксировать поведение боковых блоков в документации. Изменение: описание фильтрации по Platform и добавлен раздел Saved Overrides. Файл: `docs/devtools-selectors-user-guide.md`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.70.54. Файл: `manifest.json`.

### 2026-01-08 17:26 — v2.70.26

- Для чего: убрать таймауты селекторного поиска ответа Grok. Изменение: ответ берется из DOM‑fallback/снэпшота без SelectorFinder для response. Файл: `content-scripts/content-grok.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.70.26. Файл: `manifest.json`.

### 2026-01-08 15:08 — v2.70.25

- Для чего: видеть timing посещений в логах. Изменение: логирование TAB_VISIT с duration/startedAt/endedAt/source/reason при каждом визите. Файл: `background.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.70.25. Файл: `manifest.json`.

### 2026-01-08 15:00 — v2.70.24

- Для чего: убрать ложное определение композера Grok по активной кнопке ответа. Изменение: композер принимается только если это textarea/contenteditable/role=textbox, иначе падаем на SelectorFinder. Файл: `content-scripts/content-grok.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.70.24. Файл: `manifest.json`.

### 2026-01-08 14:06 — v2.70.23

- Для чего: видеть длительность каждого посещения вкладки LLM. Изменение: трекинг start/stop на активации вкладки, blur и human‑visit с сохранением длительностей в состоянии. Файл: `background.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.70.23. Файл: `manifest.json`.

### 2026-01-08 13:53 — v2.70.22

- Для чего: обеспечить отправку Grok через 2 секунды после вставки. Изменение: тайминг Ctrl+Enter привязан к моменту завершения инъекции и добавлен диагностический маркер Prompt injected. Файл: `content-scripts/content-grok.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.70.22. Файл: `manifest.json`.

### 2026-01-08 13:43 — v2.70.21

- Для чего: стабилизировать отправку Grok через Ctrl+Enter. Изменение: фокусировка композера, отправка через activeElement, добавлен keypress и повтор Ctrl+Enter перед fallback. Файл: `content-scripts/content-grok.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.70.21. Файл: `manifest.json`.

### 2026-01-08 11:02 — v2.70.20

- Для чего: сократить повторы отправки Claude на длинных промптах. Изменение: адаптивный таймаут подтверждения отправки и запрет ретрая во время typing по диагностике. Файл: `background.js`.
- Для чего: снизить шум мониторинга при успешном ответе. Изменение: PIPELINE_ERROR: hard_timeout переводится в warning после COPY_SUCCESS, телеметрия помечается degraded. Файлы: `background.js`, `results-devtools.js`.
- Для чего: ускорить Grok и стабилизировать контейнер ответа. Изменение: ограничен таймаут autodiscovery и добавлен селектор message-bubble для ответа в пайплайне и конфиге. Файлы: `content-scripts/content-grok.js`, `content-scripts/answer-pipeline-selectors.js`, `selectors/grok.config.js`, `selectors/config-bundle.json`, `selectors/config-bundle.js`.
- Для чего: убрать лишний поиск кнопки отправки DeepSeek. Изменение: подтверждение отправки через Ctrl+Enter и DOM-сигналы без поиска sendButton. Файл: `content-scripts/content-deepseek.js`.
- Для чего: снизить ложные ретраи Le Chat. Изменение: таймаут подтверждения отправки увеличен до 20000мс. Файл: `background.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.70.20. Файл: `manifest.json`.

### 2026-01-07 09:12 — v2.70.19

- Для чего: отфильтровать reasoning/думалку Claude, когда ответ подхватывается не тем узлом. Изменение: приоритет message-text, расширенные фильтры thinking и сужение селекторов ответа Claude в пайплайне и бандлах. Файлы: `content-scripts/content-claude.js`, `content-scripts/answer-pipeline-selectors.js`, `selectors/config-bundle.json`, `selectors/config-bundle.js`, `selectors/claude.config.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.70.19. Файл: `manifest.json`.

### 2026-01-07 00:10 — v2.70.18

- Для чего: не подхватывать в Claude блоки “thinking/рассуждения” вместо финального ответа. Изменение: фильтр DOM‑извлечения и пайплайна для пропуска thinking‑узлов, уточнённые селекторы ответа Claude. Файлы: `content-scripts/content-claude.js`, `content-scripts/answer-pipeline-selectors.js`, `selectors/config-bundle.json`, `selectors/config-bundle.js`, `selectors/claude.config.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.70.18. Файл: `manifest.json`.

### 2026-01-06 22:43 — v2.70.17

- Для чего: не отдавать пустой ответ Grok до завершения DOM‑fallback. Изменение: финальная проверка ответа с коротким fallback до возврата результата. Файл: `content-scripts/content-grok.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.70.17. Файл: `manifest.json`.

### 2026-01-06 16:01 — v2.70.16

- Для чего: предотвратить “пустые” ответы и красный статус при реальном ответе. Изменение: добавлен базовый якорь ответа и короткий fallback на DOM при слишком коротком/пустом результате, а также передача базовой истории для Qwen. Файлы: `content-scripts/content-grok.js`, `content-scripts/content-qwen.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.70.16. Файл: `manifest.json`.

### 2026-01-06 14:19 — v2.70.15

- Для чего: отправлять промпт быстрее и без скролла — Ctrl+Enter через 2 секунды после вставки, поиск кнопки только после неуспеха, SmartScroll/ReadPage отключены до подтверждения отправки. Изменение: перестроен порядок отправки и блокировки скролла в контент‑скриптах LLM. Файлы: `content-scripts/content-chatgpt.js`, `content-scripts/content-claude.js`, `content-scripts/content-gemini.js`, `content-scripts/content-grok.js`, `content-scripts/content-lechat.js`, `content-scripts/content-qwen.js`, `content-scripts/content-deepseek.js`, `content-scripts/content-perplexity.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.70.15. Файл: `manifest.json`.

### 2026-01-03 00:34 — v2.70.02

- Для чего: поставить Ctrl+Enter как основной способ отправки, чтобы снизить сбои подтверждения отправки (включая Le Chat). Изменение: переставлен порядок отправки во всех контент‑скриптах LLM. Файлы: `content-scripts/content-chatgpt.js`, `content-scripts/content-claude.js`, `content-scripts/content-gemini.js`, `content-scripts/content-grok.js`, `content-scripts/content-lechat.js`, `content-scripts/content-qwen.js`, `content-scripts/content-deepseek.js`, `content-scripts/content-perplexity.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.70.02. Файл: `manifest.json`.

### 2025-12-25 17:04 — v2.55.09

- Для чего: передать коллегам полный пакет изменений одной заплаткой. Изменение: сформирован diff/patch файл с изменениями текущей сессии. Файл: `codex-session-changes-2025-12-25.patch`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.55.09. Файл: `manifest.json`.

### 2025-12-25 15:56 — v2.55.08

- Для чего: снизить нагрузку от телеметрии селекторов. Изменение: добавлен батчинг и отложенная запись метрик с flush при suspend. Файл: `background.js`.
- Для чего: зафиксировать правила записи метрик в документации. Изменение: указана батчевая запись Selector Health. Файл: `docs/tabs-and-selectors.md`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.55.08. Файл: `manifest.json`.

### 2025-12-25 15:02 — v2.55.07

- Для чего: дать полностью самостоятельную инструкцию по вкладке Selectors для первого запуска. Изменение: добавлен подробный пользовательский гайд. Файл: `docs/selectors-tab-first-run-guide.md`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.55.07. Файл: `manifest.json`.

### 2025-12-25 14:51 — v2.55.06

- Для чего: добавить быстрые действия Selector Health. Изменение: кнопки Copy/Export рядом с обновлением. Файл: `result_new.html`.
- Для чего: поддержать копирование/экспорт статуса здоровья селекторов. Изменение: формирование текста и JSON, обработчики копирования и экспорта. Файл: `results.js`.
- Для чего: визуально выровнять набор действий Selector Health. Изменение: добавлен блок действий в заголовке. Файл: `styles.css`.
- Для чего: обновить документацию по Selector Health. Изменение: описаны кнопки Copy/Export. Файлы: `docs/devtools-tab-user-guide.md`, `docs/tabs-and-selectors.md`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.55.06. Файл: `manifest.json`.

### 2025-12-25 14:28 — v2.55.05

- Для чего: заменить Version Watch на Selector Health с рабочими метриками. Изменение: новая карточка Selector Health в DevTools. Файл: `result_new.html`.
- Для чего: визуализировать здоровье селекторов и метрики слоя. Изменение: добавлены стили таблицы, чипов и статусов Selector Health. Файл: `styles.css`.
- Для чего: показать и обновлять здоровье селекторов в UI. Изменение: запрос и рендер Selector Health, обработка состояния данных. Файл: `results.js`.
- Для чего: собрать метрики здоровья селекторов и отдавать сводку в UI. Изменение: учёт L1–L4, fail/error, активных версий и health‑check результатов. Файл: `background.js`.
- Для чего: зафиксировать правила и назначение Selector Health в документации. Изменение: обновлены описания вкладки Selectors и архитектуры. Файлы: `docs/devtools-tab-user-guide.md`, `docs/tabs-and-selectors.md`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.55.05. Файл: `manifest.json`.

### 2025-12-25 12:14 — v2.55.04

- Для чего: явно показывать ошибки проверки активных селекторов. Изменение: ошибка выделяется отдельным статусом при валидации списка селекторов. Файл: `results.js`.
- Для чего: не сохранять override при некорректном CSS‑селекторе. Изменение: сохранение прерывается при ошибке валидации. Файл: `results.js`.
- Для чего: корректно отображать ошибки загрузки истории override. Изменение: показ сообщения об ошибке при неудачном запросе. Файл: `results.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.55.04. Файл: `manifest.json`.

### 2025-12-25 12:08 — v2.55.03

- Для чего: сделать работу с селекторами управляемой и проверяемой. Изменение: добавлены блоки Active UI version/Active selectors, проверка селекторов, поле причины и история override. Файлы: `result_new.html`, `styles.css`.
- Для чего: валидировать селекторы и фиксировать историю изменений. Изменение: логика проверки селекторов, актуальной версии и журнал override в UI. Файл: `results.js`.
- Для чего: поддержать проверку селекторов и аудит на фоне. Изменение: добавлены IPC‑обработчики и хранение истории override. Файл: `background.js`.
- Для чего: обновить документацию по вкладке Selectors. Изменение: описаны проверки, причины и история override. Файлы: `docs/devtools-tab-user-guide.md`, `docs/tabs-and-selectors.md`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.55.03. Файл: `manifest.json`.

### 2025-12-25 10:54 — v2.54.28

- Для чего: вернуть постоянную высоту DevTools‑панелей без динамического пересчёта. Изменение: фиксированная высота задаётся через CSS‑переменную и используется при синхронизации. Файлы: `results.js`, `styles.css`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.54.28. Файл: `manifest.json`.

### 2025-12-25 10:48 — v2.54.27

- Для чего: убрать из DevTools вкладки Commands/Dev Diag/Storage, чтобы оставить только рабочие разделы. Изменение: удалены кнопки и панели вкладок. Файл: `result_new.html`.
- Для чего: удалить неиспользуемую логику Dev Diag/Commands из скриптов DevTools. Изменение: `results-devtools.js` оставлен только с Telemetry. Файл: `results-devtools.js`.
- Для чего: убрать обработчики Storage‑телеметрии после удаления вкладки. Изменение: удалён блок `attachTelemetryButtons`. Файл: `results.js`.
- Для чего: обновить документацию по доступным вкладкам DevTools. Изменение: разделы Commands/Dev Diag/Storage удалены. Файл: `docs/devtools-tab-user-guide.md`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.54.27. Файл: `manifest.json`.

### 2025-12-25 02:35 — v2.54.26

- Для чего: показывать в Logs только выбранные модели и синхронизировать DevTools с текущим выбором. Изменение: фильтрация карточек Logs и Copy all по выбранным моделям, добавлено уведомление об изменении выбора. Файл: `results.js`.
- Для чего: ограничить Telemetry платформы выбранными моделями. Изменение: список платформ строится по текущему выбору, телеметрия фильтруется по выбранным моделям. Файл: `results-devtools.js`.
- Для чего: исправить копирование телеметрии и добавить тегированный экспорт JSON. Изменение: Copy использует безопасный fallback, Export группирует события по тегам вида `<GPT>`. Файл: `results-devtools.js`.
- Для чего: убрать конфликт идентификаторов кнопок Telemetry Copy в DevTools/Storage. Изменение: переименована кнопка копирования в Storage и обновлен обработчик. Файлы: `result_new.html`, `results.js`.
- Для чего: зафиксировать изменения в гайде DevTools. Изменение: описаны Logs/Telemetry и правила выбора моделей для копирования/экспорта. Файл: `docs/devtools-tab-user-guide.md`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.54.26. Файл: `manifest.json`.

### 2025-12-23 07:38 — v2.54.24

- Для чего: корректно фиксировать границу ответа Claude после отправки и не попадать в хвост предыдущего ответа. Изменение: добавлен поиск последнего ассистентского сообщения для baseline‑anchor. Файл: `content-scripts/content-claude.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.54.24. Файл: `manifest.json`.

### 2025-12-22 19:34 — v2.54.23

- Для чего: не обрезать ответ Claude до последней строки. Изменение: расширен поиск контейнера ответа и исключены p‑селекторы из fallback. Файл: `content-scripts/content-claude.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.54.23. Файл: `manifest.json`.

### 2025-12-22 13:25 — v2.54.22

- Для чего: не отдавать нижний кусок предыдущего ответа в Claude. Изменение: добавлен anchor‑фильтр по последнему ответу до отправки и отбрасывание stale‑ответов. Файл: `content-scripts/content-claude.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.54.22. Файл: `manifest.json`.

### 2025-12-22 11:14 — v2.54.21

- Для чего: не принимать служебные статусы Grok (“Поиск в сети” и аналоги) за ответ. Изменение: добавлен фильтр service‑status текстов при DOM‑fallback и обработке ответа. Файл: `content-scripts/content-grok.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.54.21. Файл: `manifest.json`.

### 2025-12-22 09:53 — v2.54.20

- Для чего: быстро применять нужные фильтры телеметрии без ручного ввода. Изменение: добавлены пресеты фильтров в Telemetry UI и активное состояние кнопок. Файлы: `result_new.html`, `styles.css`, `results-devtools.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.54.20. Файл: `manifest.json`.

### 2025-12-22 09:39 — v2.54.19

- Для чего: видеть успех/таймаут DOM-fallback при извлечении ответа Grok. Изменение: добавлены события DOM_FALLBACK_START/SUCCESS/TIMEOUT. Файл: `content-scripts/content-grok.js`.
- Для чего: повысить устойчивость извлечения ответа Grok без смены primary-селекторов. Изменение: добавлен fallback-селектор ответа в Grok-конфиг и список lastMessage. Файлы: `selectors/grok.config.js`, `selectors/config-bundle.js`, `selectors/config-bundle.json`, `content-scripts/answer-pipeline-selectors.js`, `content-scripts/content-grok.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.54.19. Файл: `manifest.json`.

### 2025-12-21 23:54 — v2.54.18

- Для чего: повысить шанс извлечения ответа Grok при сбоях селекторов. Изменение: добавлен DOM-fallback с ожиданием стабилизации текста параллельно response-селекторам. Файл: `content-scripts/content-grok.js`.
- Для чего: исключить повторную отправку результата при нескольких источниках ответа. Изменение: добавлен guard `responseDelivered` и единый `deliverAnswer` для завершения пайплайна. Файл: `content-scripts/content-grok.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.54.18. Файл: `manifest.json`.

### 2025-12-21 23:09 — v2.54.17

- Для чего: видеть факт загрузки Grok-скрипта и набор активных хендлеров. Изменение: добавлен SCRIPT_LOADED диагностический эвент. Файл: `content-scripts/content-grok.js`.
- Для чего: диагностировать поиск композера на Grok. Изменение: добавлены события COMPOSER_FOUND/COMPOSER_NOT_FOUND с деталями попыток. Файл: `content-scripts/content-grok.js`.
- Для чего: проверять готовность Grok перед отправкой. Изменение: добавлен обработчик CHECK_READINESS с диагностикой и причинами отказа. Файл: `content-scripts/content-grok.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.54.17. Файл: `manifest.json`.

### 2025-12-21 22:13 — v2.54.16

- Для чего: фиксировать диагностику выбора селекторов по слоям. Изменение: добавлены события SELECTOR с суммарной статистикой и итогом. Файл: `selector-manager.js`.
- Для чего: видеть причину провалов/успехов по попыткам. Изменение: сбор счетчиков попыток и причин отказа в каждом слое. Файл: `selector-manager.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.54.16. Файл: `manifest.json`.

### 2025-12-21 21:39 — v2.54.15

- Для чего: добавить сводку телеметрии по run для быстрой диагностики. Изменение: добавлена карточка Telemetry Summary в Devtools. Файл: `result_new.html`.
- Для чего: агрегировать метрики run и статусы ошибок. Изменение: добавлен расчет и рендер сводки по requestId. Файл: `results-devtools.js`.
- Для чего: визуально отделить Summary от таймлайна. Изменение: добавлены стили для сводки телеметрии. Файл: `styles.css`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.54.15. Файл: `manifest.json`.

### 2025-12-21 18:23 — v2.54.14

- Для чего: закрепить вкладки Devtools и прокручивать только контент под ними. Изменение: таблист остается на месте, а область вкладок стала скроллируемой с фиксированной высотой. Файлы: `styles.css`, `results.js`.
- Для чего: синхронизировать высоту всех вкладок с Logs. Изменение: добавлен расчет высоты панели на основе Logs и перерасчет при обновлении/resize. Файл: `results.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.54.14. Файл: `manifest.json`.

### 2025-12-21 18:14 — v2.54.13

- Для чего: оставить в Logs только диагностику без вложенных переключателей. Изменение: упрощен заголовок Logs и переименованы идентификаторы вкладки. Файл: `result_new.html`.
- Для чего: убрать следы User Log и легенды статусов из логики Devtools. Изменение: удалены устаревшие блоки и обновлена дефолтная вкладка Logs. Файл: `results.js`.
- Для чего: согласовать стили Logs с новым заголовком. Изменение: удалены стили dual-log и добавлены стили для действий заголовка. Файл: `styles.css`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.54.13. Файл: `manifest.json`.

### 2025-12-21 17:44 — v2.54.12

- Для чего: автo‑обновлять телеметрию только при активной вкладке Telemetry. Изменение: добавлен автопулл с остановкой при уходе с вкладки. Файл: `results-devtools.js`.
- Для чего: экспортировать телеметрию в JSON одним кликом. Изменение: добавлена кнопка `{ }` и обработчик экспорта. Файлы: `result_new.html`, `results-devtools.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.54.12. Файл: `manifest.json`.

### 2025-12-21 17:14 — v2.54.11

- Для чего: показать телеметрию отправки в Devtools‑модале Results UI. Изменение: добавлена вкладка Telemetry с фильтрами и таймлайном событий. Файл: `result_new.html`.
- Для чего: отрисовать и управлять таймлайном телеметрии. Изменение: добавлен рендеринг, фильтры, копирование и обновление данных Telemetry. Файл: `results-devtools.js`.
- Для чего: визуально отделить таймлайн телеметрии от остальных логов. Изменение: добавлены стили для telemetry‑таймлайна и статусов. Файл: `styles.css`.
- Для чего: хранить телеметрию от контент‑скриптов в общем пуле диагностик. Изменение: LLM_DIAGNOSTIC_EVENT сохраняется в `__diagnostics_events__`. Файл: `background.js`.
- Для чего: зафиксировать выпуск. Изменение: версия расширения обновлена до 2.54.11. Файл: `manifest.json`.

### 2025-12-21 16:59 — v2.54.10

- Для чего: ускорить и стабилизировать диагностику отправки Claude по этапам. Изменение: добавлена детальная телеметрия стадий (композер/ввод/отправка/подтверждение/typing/stop/ошибки) через LLM_DIAGNOSTIC_EVENT. Файл: `content-scripts/content-claude.js`.
- Для чего: убрать молчаливые провалы подтверждения отправки и дать причину в логах. Изменение: логирование причин неподтверждённой отправки и параметров композера/кнопок. Файл: `content-scripts/content-claude.js`.
- Для чего: зафиксировать выпуск. Изменение: увеличена версия расширения до 2.54.10. Файл: `manifest.json`.

### Release Notes — 2.48–2.53 (после 2.47)

- Dispatch без дублей: `PROMPT_SUBMITTED` больше не триггерит повторную отправку `GET_ANSWER`, а `messageSent` ставится сразу после успешной доставки команды (меньше “спама” по вкладкам и ошибок вида “Another request is already being processed”).
- Очередь dispatch: ожидание подтверждения отправки вынесено за пределы mutex, чтобы зависшая/медленная вкладка не блокировала остальные модели.
- UX без focus‑steal: флаг `allow_focus_steal_enabled` (по умолчанию выключен) + отдельное automation‑окно для LLM‑вкладок при отключённом focus‑steal.
- Извлечение ответов: обновлены платформенные селекторы + UnifiedAnswerPipeline, добавлены DOM‑fallback’и (берём последний ответ), hardMax streaming timeout снижен до 180s.
- Claude: извлечение ответа стало стабильнее (ожидание элементов через SelectorFinder, защита от “ответов‑лейблов” вроде `Sonnet 4.5`).
- Results UI/IPC: в results уходит `normalizedAnswer`, добавлен ACK на входящие сообщения (фон не теряет `resultsTabId`), убраны CSP/JS ошибки в `result_new.html`/`results.js`.
- Совместимость доменов: расширены `host_permissions`/`matches` для Gemini (`bard.google.com`), Perplexity (`www.perplexity.ai`) и Grok (`grok.x.ai`, `x.ai`).
- Диагностика: явные ошибки при проблемах `chrome.tabs.create` и более аккуратная обработка ошибок запуска в results.

### 2025-12-18 00:30

- Results CSP: удалён inline singleton‑guard из `result_new.html` (CSP блокировал inline scripts и засорял консоль).
- Results ↔ background IPC: results‑страница теперь отправляет ACK на входящие сообщения, чтобы фон не получал `The message port closed before a response was received.` и не сбрасывал `resultsTabId`. Файлы: `results.js`, `background.js`.
- Results UI: убран вызов несуществующей `updateProSectionVisibility()` (падал на double‑click по модели). Файл: `results.js`.

### 2025-12-18 00:14

- Dispatch: ожидание `PROMPT_SUBMITTED` вынесено за пределы mutex (очередь держится только на “активация вкладки → доставка `GET_ANSWER`”), чтобы зависшая/залоченная вкладка не стопорила отправку в другие модели. Файл: `background.js`. Док: `docs/tabs-and-selectors.md`.
- Popup back-compat: добавлен обработчик `{action:'sendPrompt'}` (старый UI) с маппингом LLM ids и запуском процесса через results tab. Файл: `background.js`.

### 2025-12-18 00:00

- Results UI: кнопка запуска (`#start-button`) теперь обрабатывает `chrome.runtime.lastError`, корректно возвращает `Get it` из disabled при ранних выходах и показывает уведомление при неудачном старте. Файл: `results.js`.
- Playwright perf harness: переход на `locator()` + селекторы с `:visible` и per‑URL overrides (в т.ч. исключение reCAPTCHA textarea) — меньше зависаний на скрытых элементах и ошибок re-render. Файл: `tests/perf-multi-tab.js`. Док: `docs/perf-tests.md`.

### 2025-12-17 22:03

- Dispatch stability/perf: возврат сериализации dispatch (одна отправка за раз) и ожидания `PROMPT_SUBMITTED` без гонки, чтобы не запускать тяжёлые контент‑пайплайны параллельно и не терять подтверждения. Файл: `background.js`.
- Automation window: при `allow_focus_steal_enabled=false` LLM вкладки открываются в отдельном окне (не фокусируется), и фон может активировать вкладки внутри него без переключения пользователя; human presence разрешён в фоне для этого окна. Файл: `background.js`. Док: `docs/tabs-and-selectors.md`.

### 2025-12-17 14:51

- Anti focus-steal: добавлен флаг `allow_focus_steal_enabled` (по умолчанию false) — фон больше не активирует вкладки/окна во время dispatch/human presence и не фокусирует results автоматически, что убирает “возврат” пользователя на вкладки LLM/Results при переключениях. Файл: `background.js`. Док: `docs/tabs-and-selectors.md`.

### 2025-12-16 12:40

- Answer pipeline selectors обновлены: добавлены точные контейнеры/lastMessage/generating/completion индикаторы для Perplexity, Qwen, Grok; ChatGPT selectors дополнены актуальными `conversation-turn`; generic-заглушки заменены на платформенные профили. Файл: `content-scripts/answer-pipeline-selectors.js`.
- Pipeline fallbacks: если UnifiedAnswerPipeline не вернул ответ, контент‑скрипты GPT/Gemini/Perplexity вытаскивают последний ассистентский ответ из DOM и отправляют его, чтобы журнал не пустовал. Файлы: `content-scripts/content-chatgpt.js`, `content-scripts/content-gemini.js`, `content-scripts/content-perplexity.js`.
- Streaming таймаут: hardMax для adaptive timeout уменьшен до 180 000 мс, чтобы не ждать 5 минут при зависшем watcher. Файл: `content-scripts/pipeline-config.js`.
- DOM fallback helpers: определены `grabLatestAssistantMarkup` в GPT/Gemini/Perplexity (с платформенными селекторами и fallback списком), чтобы фолбэк не падал на отсутствующей функции и всегда мог извлечь текст из DOM. Время: 2025-12-16 13:20. Файлы: `content-scripts/content-chatgpt.js`, `content-scripts/content-gemini.js`, `content-scripts/content-perplexity.js`.
- Perplexity селекторы уточнены: добавлены `answer-card`, `chat-message` с `.prose`, layout-wrapper, stop/send data-testid; фолбэк ищет ответ в этих узлах. Время: 2025-12-16 13:50. Файлы: `content-scripts/answer-pipeline-selectors.js`, `content-scripts/content-perplexity.js`.

### 2025-12-12 10:15

- Prompt broadcast: `LLM_URL_PATTERNS` теперь строится из `LLM_TARGETS.queryPatterns` (с fallback), добавлен `chatgpt.com`, чтобы промпты доставлялись во все актуальные вкладки. Файл: `background.js`.
- Startup latency: убрана фиксированная пауза `delay/SEND_PROMPT_DELAY_MS` перед отправкой `GET_ANSWER`; вместо неё фон ждёт готовности контент‑скрипта через `HEALTH_CHECK_PING` и шлёт промпт сразу. Исправлен mismatch `HEALTH_PING` → `HEALTH_CHECK_PING`, из‑за которого раньше происходили лишние реинъекции/перезагрузки. Файл: `background.js`.
- Speed mode: `ContentUtils.sleep` теперь масштабирует задержки в режиме `settings.speedMode`, а платформенные скрипты (Claude/DeepSeek/Qwen/Grok/LeChat) используют этот sleep, что ускоряет стабилизацию UI без потери совместимости. Файлы: `content-scripts/content-utils.js`, `content-scripts/content-*.js`.
- Perf harness: `tests/perf-multi-tab.js` расширен CLI‑флагами (`--headless`, `--keepOpen`, `--urls`, `--prompt`) и включает `chatgpt.com` в дефолтный набор. Файл: `tests/perf-multi-tab.js`.

### 2025-12-12 11:05

- Focus thrash fix: `UnifiedAnswerPipeline.activateTab` теперь отключаемый (`preparation.allowTabActivation=false`), чтобы пайплайн не “воровал” фокус в фоне. Файлы: `content-scripts/pipeline-config.js`, `content-scripts/unified-answer-pipeline.js`.
- Prompt dispatch coordinator: фон отправляет промпты в LLM вкладки через сериализованный диспетчер, с ожиданием `PROMPT_SUBMITTED` ≤7с и возвратом фокуса на results, чтобы цикл не “залипал” на одной вкладке. Файл: `background.js`.
- Prompt submitted signal: контент‑скрипты шлют `PROMPT_SUBMITTED` сразу после клика Send/Enter, чтобы фон мог корректно зафиксировать отправку и продолжить очередь. Файлы: `content-scripts/content-*.js`.
- Dispatch timeouts: для Grok/Qwen/DeepSeek увеличен таймаут подтверждения `PROMPT_SUBMITTED` до 15с (для медленного UI), без изменения общего лимита для остальных. Файл: `background.js`.

### 2025-12-12 12:05

- Dispatch reliability: `dispatchInFlight` сбрасывается в `finally`, чтобы очередь не зависала при исключениях; добавлен supervisor‑цикл повторной отправки промпта (backoff + лимит попыток). Файл: `background.js`.
- Dispatch timeouts: overrides `PROMPT_SUBMITTED` для Grok/Qwen/DeepSeek снижены до 9с (дефолт остаётся 7с). Файл: `background.js`.
- DeepSeek injection: убраны Grok‑селекторы, добавлен `SelectorFinder` для composer/send и фильтрация `g-recaptcha-response`. Файл: `content-scripts/content-deepseek.js`.
- Qwen injection: ввод промпта “instant” (без долгого human‑typing), sendButton резолвится через `SelectorFinder`. Файл: `content-scripts/content-qwen.js`.
- Grok send: мягкое подтверждение отправки (больше не падаем на медленный старт ответа), `PROMPT_SUBMITTED` включает `meta.confirmed`. Файл: `content-scripts/content-grok.js`.
- Claude/Perplexity: main‑world bridge теперь грузится через `script.src` (`content-scripts/content-bridge.js`), чтобы не ловить CSP “unsafe-inline”; Perplexity больше не делает двойную вставку (main-world + humanoid typing). Файлы: `content-scripts/content-claude.js`, `content-scripts/content-perplexity.js`.
- Claude: `ContentCleaner.clean` теперь устойчив к non-string ответам (object/structured payload) — исправлен `out.replace is not a function`. Файл: `content-scripts/content-claude.js`.
- Claude: убран агрессивный Enter‑fallback после клика Send (он мог отправлять дважды); теперь Enter используется только если отправка не подтверждена. Файл: `content-scripts/content-claude.js`.
- GPT: отправка теперь подтверждается (stop button / новый user message / очистка composer), при необходимости используется Enter‑fallback; убраны опасные “любой enabled button рядом” селекторы. Файл: `content-scripts/content-chatgpt.js`.
- GPT: ускорена вставка (native setValue + события) и добавлено ожидание “send enabled” (poll ≤2.5s); увеличен timeout ожидания `PROMPT_SUBMITTED` до 12s, чтобы вкладка не теряла фокус до реального клика Send. Файлы: `content-scripts/content-chatgpt.js`, `background.js`.
- Claude: ввод в ProseMirror теперь через `execCommand('insertText')` (без `textContent += ...`), чтобы не получать удвоение текста. Файл: `content-scripts/content-claude.js`.

### 2025-12-11 14:30

- UnifiedAnswerPipeline: исправлен синтаксис `TabProtector` (без optional chaining после `new`), чтобы скрипты не падали парсингом на всех платформах. Файл: `content-scripts/unified-answer-pipeline.js`.
- Fetch monitor CSP-safe: вынес хук `fetch` в отдельный `fetch-monitor-bridge.js` и подключаю через src (без inline), чтобы не блокировало CSP. Файлы: `content-scripts/fetch-monitor.js`, `content-scripts/fetch-monitor-bridge.js`, `manifest.json`.
- Lazy toolkit: добавлены `scroll-toolkit.js` и `humanoid.js` в `web_accessible_resources`, чтобы ленивая подгрузка не ломалась ERR_FAILED. Файл: `manifest.json`.

### 2025-12-11 13:20

- Results tab singleton: action click now reuses/фокусирует уже открытую `result_new.html` (поиск по URL + актуализация `resultsTabId`), чтобы не плодить копии DevTools. Файл: `background.js`.
- Tab lifecycle: onRemoved больше не зовёт стоп всего пайплайна при закрытии одной LLM-вкладки; чистятся pending health-check PING-и, stopAll триггерится только для results/evaluator или когда LLM вкладок не осталось. Файл: `background.js`.
- Health-check cleanup: убран мёртвый таймер healthCheck, heartbeat останавливается при отсутствии LLM вкладок, pending pings чистятся при suspend SW. Файл: `background.js`.
- Надёжность отправки: `sendMessageSafely` переподключается к актуальному tabId из `TabMapManager` перед повторной отправкой, чтобы не шлать команды в устаревшие вкладки. Файл: `background.js`.
- Streaming watchdog: очистка guard-interval при любых исходах race в `runStreamingPhase`, без утечек setInterval. Файл: `content-scripts/unified-answer-pipeline.js`.
- Kill-switch scroll: вместо monkey-patch прототипов — AbortController-блокировка wheel/scroll/touch/key с откатом overflow, чтобы не ломать SPA после HARD_STOP. Файл: `content-scripts/pipeline-modules.js`.
- Main-world bridge: `content-bridge.js` добавлен в `web_accessible_resources`, чтобы инъекция из bootstrap не блокировалась. Файл: `manifest.json`.
- SmartScroll bootstrap: исправлены синтаксис/координаторы `withSmartScroll` в платформенных скриптах (Claude/DeepSeek/Qwen/Grok/LeChat), чтобы не падали Optional chaining/parse ошибки и SmartScroll работал через ContentUtils. Файлы: `content-scripts/content-*.js`.
- Pragmatist runner: fallback селекторы ответа теперь платформенные (ChatGPT/Claude/Gemini/Perplexity/Grok/DeepSeek/Qwen/LeChat) вместо чатгпт-списка по умолчанию. Файл: `content-scripts/pragmatist-runner.js`.
- Answer pipeline selectors: добавлен `answer-pipeline-selectors.js` (detectPlatform + PLATFORM_SELECTORS) и подключён перед watcher/pipeline, чтобы UnifiedAnswerPipeline работал без Warning. Файлы: `content-scripts/answer-pipeline-selectors.js`, `manifest.json`.
- Emergency fallbacks composer уточнены (фильтруем по placeholder/aria-label/message) вместо голых `textarea`/`contenteditable`, чтобы не цепляться к полям поиска/фидбека. Файл: `selectors/config-bundle.js`.
- Selector cache: versioned ключи с очисткой стейла в `findAndCacheElement`, чтобы не держать устаревшие селекторы после смены UI. Файл: `content-scripts/content-utils.js`.

### 2025-12-11 13:00

- Tab lifecycle: при закрытии любых вкладок, включая results, больше не инициируется автоматическое закрытие LLM-вкладок (onRemoved теперь всегда cleanup без closeTabs), чтобы не терять сессии сразу после открытия. Файл: `background.js`.
- Selector configs (#28): собран единый бандл `selectors/config-bundle.js` из всех платформенных конфигов и подключён одним файлом в manifest (персональные `selectors/*.config.js` больше не инжектятся в content scripts). Добавлен вспомогательный `config-bundle.json` как источник данных. Файлы: `selectors/config-bundle.js`, `manifest.json`, `selectors/config-bundle.json`.
- Results modularization (#26): вынесены общие хелперы копирования/HTML в `results-shared.js`, DevTools/Diagnostics перенесены в отдельный `results-devtools.js`; `result_new.html` теперь грузит оба модуля перед основной логикой. Файлы: `results.js`, `results-shared.js`, `results-devtools.js`, `result_new.html`.
- Тесты: `npm test -- --runInBand` — OK.

### 2025-12-11 00:12

- Manifest: подключены pipeline файлы (`pipeline-config.js`, `pipeline-modules.js`, `unified-answer-watcher.js`, `unified-answer-pipeline.js`) во все блоки content scripts, чтобы UnifiedAnswerPipeline реально загружался (убрали мёртвый код/пустые ссылки). Файл: `manifest.json`.
- TODO (из списка избыточностей): вынести общие утилиты `sleep`/`findAndCacheElement`/`isElementInteractable`/`withSmartScroll` в единый модуль и подключить; оптимизировать остальные пункты (#20–#23).

### 2025-12-11 00:25

- Общие утилиты: добавлен модуль `content-scripts/content-utils.js` (sleep, findAndCacheElement, isElementInteractable, withSmartScroll) и подключён во все content scripts через manifest. Платформенные скрипты переподключены к общим утилитам (wrapper поверх существующих реализаций). Файлы: `content-scripts/content-utils.js`, `manifest.json`, `content-scripts/content-*.js`.
- Тесты: `npm test -- --runInBand` — OK.

### 2025-12-11 00:47

- Fetch monitor: общий `content-scripts/fetch-monitor.js` теперь подключён во все content scripts через manifest, чтобы не держать отдельные копии хендлеров rate-limit. Файл: `manifest.json`.

### 2025-12-11 08:23

- Manifest deduplication: общий блок content scripts для всех платформ (bootstrap, utils, fetch-monitor, pipeline, selector stack, scroll-toolkit, humanoid); платформенные блоки теперь содержат только свой конфиг и контент-скрипт. Файл: `manifest.json`.

### 2025-12-11 08:31

- Health-check не закрывает вкладки: таймаут PONG больше не вызывает stopAll с `closeTabs: true`, чтобы вкладки не закрывались при поздней загрузке контент-скриптов. Файл: `background.js`.

### 2025-12-11 08:47

- Lazy scroll/humanoid: `scroll-toolkit.js` и `humanoid.js` убраны из manifest; добавлен ленивый загрузчик в `content-scripts/content-utils.js` (ensureScrollToolkit/ensureHumanoid + loadScriptOnce). `withSmartScroll` теперь загружает toolkit перед запуском. Файлы: `manifest.json`, `content-scripts/content-utils.js`.
- Тесты: `npm test -- --runInBand` — OK.

### 2025-12-11 08:50

- Shared MutationObserver: в `content-utils` добавлен реестр observeMutations; `UnifiedAnswerCompletionWatcher` теперь использует общий observer, уменьшая число MutationObserver на вкладке. Файлы: `content-scripts/content-utils.js`, `content-scripts/unified-answer-watcher.js`.

### 2025-12-11 09:05

- MutationObserver consolidation (частично): ожидание ответов в DeepSeek/Qwen/Grok/LeChat/Claude, Perplexity stabilization и stream-watcher используют общий observeMutations из `content-utils`. Уменьшено число отдельных MutationObserver на вкладках. Файлы: `content-scripts/content-utils.js`, `content-scripts/content-*.js`, `content-scripts/pipeline-modules.js`, `content-scripts/unified-answer-pipeline.js`, `content-scripts/pragmatist-core.js`.

### 2025-12-11 09:20

- MutationObserver consolidation (полностью): убраны локальные `new MutationObserver` из контент-скриптов, остаётся единый реестр в `content-utils` (единственное место создания). Файлы обновлены: `content-scripts/content-*.js`, `content-scripts/pipeline-modules.js`, `content-scripts/unified-answer-pipeline.js`, `content-scripts/pragmatist-core.js`.
- Config dedupe: все платформенные selector-config файлы теперь подключаются один раз в общем блоке manifest (без дублирования по платформам). Файл: `manifest.json`.
- Тесты: `npm test -- --runInBand` — OK.

### 2025-12-10 23:55

- Completion единым детектором: убран внутренний completion-таймер StateManager, удалены legacy `waitForResponse` в контент-скриптах (ChatGPT/Gemini/Perplexity), поток завершается только через UnifiedAnswerCompletionWatcher → `LLM_RESPONSE` push. Таймауты теперь трактуются как ошибка (нет “успеха” с обрезанным текстом). Файлы: `content-scripts/pragmatist-core.js`, `content-scripts/content-*.js`.
- Ужесточён watcher: приоритет Regenerate/Stop над fuzzy-критериями; завершение блокируется при видимом Stop; явный успех при Regenerate/completion indicator. Порог `minMetCriteria` повышен до 4, контейнер ответа ищется адресно (без наблюдения всего body), detectRegenerate добавлен. Файл: `content-scripts/unified-answer-watcher.js`.
- Таймауты для reasoning: увеличены idle-пороги (mutationIdle 15s, contentStable 8s), checkInterval 1s, адаптивные таймауты/softExtension/hardMax подняты до 240s для длинных размышлений. Файл: `content-scripts/pipeline-config.js`.

### 2025-12-10 23:50

- Phase 5 (#1 уточнение): onRemoved теперь помечает незавершённую генерацию как ошибку, если вкладка закрылась до ответа, и сбрасывает tabId/messageSent для модели. Помогает не терять статус при раннем закрытии. Файл: `background.js`.

### 2025-12-10 23:33

- Phase 5 (#14): консолидация структур вкладок — убраны прямые обращения к `llmTabMap`, все операции проходят через `TabMapManager` (health-check, heartbeat, human loop, stopAll/closeAll, selector health-check, manual ping/resend). Снимок global state теперь строится из менеджера, единый источник истины для записи в storage. Файл: `background.js`.

### 2025-12-10 22:52

- Phase 5 (#12): StateManager перешёл на единое `chrome.storage.session` (фолбэк на `chrome.storage.local` только для тестов/старых окружений), убран отдельный таймер localStorage; сохранение/restore состояния теперь не размазывается по двум стораджам. Файл: `content-scripts/pragmatist-core.js`.
- Phase 5 (#13): Инлайновый scroll-toolkit в `scrollTabToBottom` удалён; background использует общий ScrollToolkit, а при его отсутствии — простой `scrollTo` по документу. Основная логика скролла остаётся в `scroll-toolkit.js`. Файл: `background.js`.

### 2025-12-10 15:25

- Phase 3 (#2): добавлен `TabMapManager` с примитивом mutex для сериализации операций над картой вкладок (установка/удаление/очистка + сохранение в storage без гонок). Мутации карты теперь через менеджер, а загрузка/сохранение не разрывают ссылку на объект. Файл: `background.js`.
- Phase 3 (#16): единый stop теперь использует `TabMapManager` (очистка карт/таймеров без reassignment), cleanup onRemoved/stopAll/clear sessions проходит через менеджер и рассылает STOP_AND_CLEANUP. Файл: `background.js`.
- Phase 3 (#17): реализован `GLOBAL_STATE_BROADCAST` (снапшот llms/tabs/results, ts) для всех LLM вкладок и results; триггерится при обновлении статуса/создании или удалении вкладок, а также при полном stop. Файл: `background.js`.

### 2025-12-10 16:05

- Phase 4 (#3): единый keepalive — health-check теперь встроен в heartbeat интервал (один таймер вместо нескольких), без отдельных циклов. Файл: `background.js`.
- Phase 4 (#4): rate-limit очередь — введено состояние rateLimit с отложенным перезапуском моделей; ошибки rate_limit фиксируют дедлайн, после которого запуск перепробуется автоматически. Файл: `background.js`.
- Phase 4 (#7): web circuit breaker — существующий брейкер теперь защищает и tab-поток: открытые цепи блокируют запуск, восстанавливаются с HALF_OPEN после кулдауна. Файл: `background.js`.
- Phase 4 (#10): promise chain для tabs — старт каждой модели сериализован per-LLM (llmStartChains), чтобы исключить гонки при создании/переподключении вкладок. Файл: `background.js`.

### 2025-12-10 16:30

- Phase 5 (#15, cleanup intervals): rate-limit таймеры и цепочки запусков очищаются в stopAllProcesses; health-check и heartbeat объединены в один интервал (меньше параллельных таймеров). Файл: `background.js`.

### 2025-12-10 14:45

- Phase 2 (#1/#6/#8): добавлен централизованный `stopAllProcesses(reason, { closeTabs })`, очищающий все таймеры/пинги/активные слушатели, сбрасывающий `jobState`/`llmTabMap` и мягко закрывающий LLM/evaluator вкладки по запросу. Вызовы: закрытие results tab, отсутствие LLM вкладок, UNRESPONSIVE health-check, кнопка Stop All.
- Полный cleanup onRemoved: `chrome.tabs.onRemoved` теперь всегда триггерит stopAllProcesses (с закрытием вкладок при закрытии results), снимает ping state и чистит карты активности; гарантированно обрабатывается опустевший список LLM вкладок.
- UNRESPONSIVE → Stop: health-check тайм-аут переводит модель в UNRESPONSIVE и сразу вызывает stopAllProcesses с закрытием вкладок для безопасного восстановления.
- Human loop graceful shutdown: команда STOP_ALL использует stopAllProcesses для остановки human-loop/heartbeat/health-check без принудительного закрытия UI.
- Флаг автофокуса: добавлен storage-флаг `autofocus_llm_tabs_enabled` (по умолчанию false). При true новые LLM вкладки создаются с фокусом; текущий дефолт оставляет их в фоне.

### 2025-12-09

- Keepalive cleanup: убран `pingWindowByTabId` и отдельные окна AUTO/MANUAL, анти-sleep пинги всегда активны для живых вкладок (меньше дублей keepalive). Файл: `background.js`.
- Команды: `SUBMIT_PROMPT` пишет pending в `chrome.storage.session` с ключом `pending_command_<id>` (плюс alias `pending_command`); `COMMAND_ACK` удаляет оба ключа; `GET_COMMAND_STATUS` читает session+local и возвращает самый свежий pending/ack. Файлы: `background.js`, `content-scripts/pragmatist-core.js`.
- States: `GET_ALL_STATES` принимает `runId/sessionId` и фильтрует выдачу, чтобы UI не подмешивал старые прогоны. Файл: `background.js`.
- Kill-switch защита: реагируем только на payload `{ source: 'background' }`, игнорируем произвольные записи в `chrome.storage.local`. Файлы: `content-scripts/content-bootstrap.js`, `content-scripts/pragmatist-runner.js`.
- Anti-hijack вкладок: массовые `chrome.tabs.query` по LLM-паттернам теперь с `audible:false`, чтобы не подхватывать медиавкладки (лента X и др.). Файл: `background.js`.
- Main-world bridge: единый инъектор встраивается на всех платформах из `content-bootstrap.js` и слушает `EXT_ATTACH/EXT_SET_TEXT` (и alias `EXT_MAIN_*`), выполняя drop/click+input/paste в main world с native setter для текста. Файл: `content-scripts/content-bootstrap.js`.
- Вложения: введён суммарный лимит ~25MB (5×5MB) при сборке payload, ранний отказ при превышении. Файл: `results.js`.
- Main-world ожидание без setTimeout: мост ждёт появления инпута/цели через MutationObserver+requestAnimationFrame, без задержек в content-script. Файл: `content-scripts/content-bootstrap.js`.
- Стратегии по платформам: в `selectors-override.json` зафиксированы стратегия вложений (drop/click/unsupported) и приоритеты селекторов для Perplexity, Gemini, Le Chat, Claude, ChatGPT, Grok, Qwen, DeepSeek (учёт shadow DOM/drop-зон). Файл: `selectors-override.json`.
- Большие вложения: задокументировано, что для файлов >25MB требуется переход на Blob URL/потоковую передачу (код не менялся, лимит enforced в UI). Файл: `docs/change-log-codex.md`.
- Pending/ACK per platform: pending команды сохраняются per-platform (`pending_command_<platform>`), ACK удаляет только свой ключ; совместимый alias `pending_command` сохранён. Файл: `background.js`.
- Heartbeat/Health-check: пинги и health-check пропускают вкладки с HARD_STOP. Файл: `background.js`.
- Вложения capability: предупреждение в UI для LLM без поддержки вложений (например, Claude), без блокировки отправки. Файл: `results.js`.

### 2025-12-06

- Attachments via native file input: UI читает файлы как data URL и прокидывает в background; ChatGPT контент-скрипт восстанавливает File через DataTransfer и триггерит input/change на реальном `<input type="file">` перед вводом текста. Файлы ограничены (≤5 шт, ≤5MB), в storage сохраняются только метаданные. Файлы: `results.js`, `content-scripts/content-chatgpt.js`.
- Attachments drop-first: контент-скрипт ChatGPT теперь сначала эмулирует drag&drop файлов на composer (DragEvent + DataTransfer), затем fallback к кнопке/инпуту со скрытым attach. Файл: `content-scripts/content-chatgpt.js`.
- Attachments drop/input для других платформ: добавлен drop-first + attach-button/input fallback в Claude, Gemini, Perplexity, Grok, Qwen, DeepSeek, Le Chat (до 5 файлов); payload data URL reused. Файлы: `content-scripts/content-claude.js`, `content-scripts/content-gemini.js`, `content-scripts/content-perplexity.js`, `content-scripts/content-grok.js`, `content-scripts/content-qwen.js`, `content-scripts/content-deepseek.js`, `content-scripts/content-lechat.js`.
- Typing reliability: Claude/Gemini/Perplexity/Le Chat используют native value setter для textarea/input (обход React) в fallback-typing; drop/paste targets расширены до main/form/body/html, добавлен paste-fallback для вложений. Файлы: `content-scripts/content-claude.js`, `content-scripts/content-gemini.js`, `content-scripts/content-perplexity.js`, `content-scripts/content-lechat.js`.
- Attachment delivery (clipboard-first): в tech-stack overview описан брокер вложений (file-picker/drag&drop/паста Ctrl/Cmd+V), блок `attachments` в SelectorConfig и AttachmentInjector с подтверждением upload/fallback в text-only. Файл: `docs/tech-stack-overview.md`.
- Perf harness: включён persistent контекст по умолчанию (`/tmp/pw-home`) и headed-режим для прогрева логинов; per-URL селекторы для Qwen/Mistral уточнены; таймаут ожидания send сокращён до 5s, send имеет фолбэк Enter при отсутствии/блокировке кнопки; goto ждёт `domcontentloaded` (быстрее старты). Файл: `tests/perf-multi-tab.js`.
- Perf harness (добавление): селектор Mistral composer исключает скрытые textarea/contenteditable (aria-hidden/tabindex -1), чтобы не цепляться за скрытый placeholder. Файл: `tests/perf-multi-tab.js`.
- Perf harness (платформы): список URL расширен до всех основных платформ (chat.openai, claude, gemini, grok, perplexity, deepseek, qwen). Файл: `tests/perf-multi-tab.js`.

### 2025-12-05

- Speed mode (DevTools toggle): сохраняется в `settings.speedMode`, транслируется в контент через `__PRAGMATIST_SPEED_MODE`, гасит ContinuousHumanActivity и initialScrollKick/micro-jitter для спокойного UI.
- Smoke check button (DevTools → Diagnostics): вызывает SelectorFinder.healthCheck в активной вкладке, пишет итог в diag-events; платформа фильтруется селектором в Commands/Diag.
- Scroll guard: ScrollToolkit ограничивает пассивные скроллы (≤2/5с), блокирует скролл при `__LLMScrollHardStop`, логирует скачки с origin/stack; micro_jitter отключается в speed mode.
- Быстрый старт runner: кеширует последний контейнер (selector+XPath) per platform в localStorage, пробует первым; watcher не запускается до нахождения контейнера (таймаут ~2.5s).
- Storage шум: StateManager пишет в chrome.storage.local только финальное/idle состояние; в генерации — только LS (меньше QPS/1KB лимит). Рефреш тестов — всё зелёное.

### 2025-12-04

- Embedded Pragmatist budgets/contracts: вынесены в `shared/budgets.js` и подключаются через bootstrap; добавлен сторож очистки storage (ACK TTL 5 мин, pending_command 60с, state 24ч) + alarm `pragmatist_storage_cleanup`. Файлы: `shared/budgets.js`, `content-scripts/content-bootstrap.js`, `background.js`.
- Kill-switch & hard-stop propagation: background human-visit теперь уважает `__LLMScrollHardStop`; UnifiedAnswerWatcher завершается при HARD_STOP. Файлы: `background.js`, `content-scripts/unified-answer-watcher.js`.
- Pragmatist runner: универсальный адаптер/StateManager/CommandExecutor для всех платформ (host-based) без правки платформенных скриптов; сохраняет метаданные в LS+storage и слушает STOP_ALL. Файл: `content-scripts/pragmatist-runner.js`; манифест обновлён для всех платформ.
- Dev copy-pack: синхронизированы свежие версии (budgets, runner, core, pipeline, scroll-toolkit, humanoid, background, watcher) в `Copy selector files/` для ревью.
- DevTools вкладки: автоподгрузка состояний/диагностики при открытии вкладок States/Diagnostics; улучшенные сообщения об ошибках загрузки. Файл: `results.js`.
- Kill-switch/STOP_ALL защита в runner: принудительная остановка watcher/command-executor при `kill_switch`/`STOP_ALL`/HARD_STOP; повторная очистка storage запускается и на старте расширения. Файлы: `content-scripts/pragmatist-runner.js`, `content-scripts/pragmatist-core.js`, `background.js`.
- Runtime STOP_ALL: runner теперь слушает `chrome.runtime.onMessage` (STOP_ALL/STOP_AND_CLEANUP/FORCE_HARD_STOP_RESTORE) и мгновенно гасит активности, выставляя `__LLMScrollHardStop`. Файл: `content-scripts/pragmatist-runner.js`.
- Диагностика batched: background принимает `DIAG_EVENT` и хранит последние 200 событий в `__diagnostics_events__`; вывод времени в Diagnostics табе. Файлы: `background.js`, `results.js`.
- Diag hooks из core/runner: StreamWatcher/CommandExecutor и runner отправляют `DIAG_EVENT` при пропусках из-за HARD_STOP/STOP_ALL (тип `stream_watcher_stop`, `cmd_skip`, `runner_stop`). Файлы: `content-scripts/pragmatist-core.js`, `content-scripts/pragmatist-runner.js`.
- State size guard: StateManager обрезает preview до 512 символов и не пишет в chrome.storage, если запись превышает ~1KB бюджета. Файл: `content-scripts/pragmatist-core.js`.
- Selector-aware runner: подтягивает селекторы/индикаторы генерации из `SelectorConfig` (detectUIVersion + getSelectorsFor) для платформ chatgpt/claude/gemini/perplexity/grok/deepseek/qwen/lechat. Файл: `content-scripts/pragmatist-runner.js`.
- DevTools UX: States/Diagnostics вкладки обновляются при переключении табов; авто-старт загрузки остаётся. Файл: `results.js`.
- Diagnostics удобство: добавлена кнопка Copy для выгрузки diag событий (список в storage) в буфер обмена. Файлы: `result_new.html`, `results.js`.
- Diagnostics export: добавлена кнопка Download, diag-лента оформлена как scrollbox. Файлы: `result_new.html`, `results.js`.
- DevTools табы: убрана отдельная вкладка States, её refresh вынесен в Dev Tools (label “State:s” + Refresh сверху); вкладка API Keys переименована в API. Файлы: `result_new.html`, `results.js`.
- Исправление: кнопка States/Refresh и список состояний перенесены в Dev Diag (вместо Dev Tools). Файлы: `result_new.html`, `results.js`.
- Pragmatist Core: StreamWatcher теперь безопасно подключается (fallback к body, первичный прогон `_process`) и учитывает `Node`/MutationObserver из jsdom; StateManager completion таймер завершает при HARD_STOP. Файлы: `content-scripts/pragmatist-core.js`.
- Тесты: интеграционные сценарии runner/stream-watcher стабилизированы (подстановка location/Node, явный `_check` команд, ожидание мутаций); все Jest тесты зелёные. Файлы: `tests/integration-end-to-end.test.js`, `tests/integration-stream-watcher.test.js`, `tests/setupEnv.js`.
- UI: State:s + Refresh теперь инлайн в Dev Diag. Файл: `result_new.html`.
- Commands UI: Send/Stop All в одну линию с равной шириной, Collect Responses — отдельной полосой на всю ширину. Файл: `result_new.html`.
- Diagnostics UX: добавлен live-фильтр по тексту событий (вместе с Refresh/Copy/Download/Clear). Файлы: `result_new.html`, `results.js`.
- Command status: добавлен блок статуса (pending + recent ACKs) и refresh; backend отдаёт GET_COMMAND_STATUS (pending + последние 20 ack). Файлы: `result_new.html`, `results.js`, `background.js`.
- Scroll предохранители: лимит микроскроллов в пассивных режимах (≤2 за 5с по умолчанию), запрет скролла при `__LLMScrollHardStop`, предупреждения по превышению delta/частоты с выводом stack (через log/hook). Файл: `scroll-toolkit.js`.
- Storage noise reduction: StateManager во время генерации пишет только в localStorage, а в chrome.storage сохраняет финальное/idle состояние (меньше QPS). Файл: `content-scripts/pragmatist-core.js`.
- Pragmatist integration (platforms): runner экспортирует __PragmatistAdapter (adapter/state/command/sessionId) в window для платформенных скриптов; StateManager пишет state_<platform>_<sessionId> помимо state_<sessionId>. Файлы: `content-scripts/pragmatist-runner.js`, `content-scripts/pragmatist-core.js`.
- Storage cleanup: DIAG_EVENT отправляется при удалении ключей (count/ttl/maxKeys). Файл: `background.js`.
- Pipeline: UnifiedAnswerPipeline теперь использует sessionId из __PragmatistAdapter (если есть), отправляет STORE_TAB_STATE с platform/sessionId. Файл: `content-scripts/unified-answer-pipeline.js`.
- CommandExecutor: ACK теперь содержит platform; фильтрация команд по списку платформ усилена. Файл: `content-scripts/pragmatist-core.js`.
- DevTools Commands: добавлен выбор платформы (All/<platform>) для отправки/stop; backend STOP_ALL теперь несёт platforms. Файлы: `result_new.html`, `results.js`, `background.js`.
- Broadcast STOP_ALL фильтруется по платформе и в runtime-listener/хранилище listener, чтобы не гасить чужие вкладки. Файлы: `content-scripts/pragmatist-runner.js`, `content-scripts/pragmatist-core.js`.
- States/Commands в DevTools: фильтрация по платформе (select), GET_COMMAND_STATUS и GET_ALL_STATES учитывают платформу на бэкенде. Файлы: `results.js`, `result_new.html`, `background.js`.
- ChatGPT script начал использовать Pragmatist adapter (sessionId/platform) для дальнейшей привязки пайплайна. Файл: `content-scripts/content-chatgpt.js`.
- Платформенные скрипты (Claude, Gemini, Perplexity, Grok, DeepSeek, Qwen, LeChat) подключены к __PragmatistAdapter (sessionId/platform) для дальнейшего wiring пайплайна. Файлы: `content-scripts/content-*.js`.
- ChatGPT pipeline теперь получает sessionId/platform из __PragmatistAdapter (overrides в UnifiedAnswerPipeline). Файл: `content-scripts/content-chatgpt.js`.
- Все платформенные пайплайны (Claude/Gemini/Perplexity/Grok/DeepSeek/Qwen/LeChat) получают overrides sessionId/platform из __PragmatistAdapter при создании UnifiedAnswerPipeline. Файлы: `content-scripts/content-*.js`.
- Tests: расширены unit-тесты StateManager/CommandExecutor (дебаунс/TTL/платформ-фильтр); добавлен placeholder для burst/budget simulation. Файлы: `tests/state-manager.test.js`, `tests/command-executor.test.js`, `tests/storage-budgets.test.js`.
- Integration test: добавлен тест связки StreamWatcher + StateManager с реальными мутациями в DOM (jsdom). Файл: `tests/integration-stream-watcher.test.js`.
- Integration test: добавлен тест CommandExecutor+StateManager (pending command, platform filter, ACK). Файл: `tests/integration-command-flow.test.js`.
- Unit test: CommandExecutor теперь проверяет запись ACK с platform (submit success). Файл: `tests/command-executor.test.js`.
- Storage budgets: тесты с описанием кейсов (maxKeys eviction/valueSize/QPS) оформлены как TODO-placeholder. Файл: `tests/storage-budgets.test.js`.
- End-to-end scaffold placeholder (jsdom) для будущего полного потока. Файл: `tests/integration-end-to-end.test.js`.
- Runner sessionId теперь стабилизируется per-платформа (persist в localStorage `__prag_session_<platform>`). Файл: `content-scripts/pragmatist-runner.js`.
- Storage cleanup: учитывает лимит maxKeys (50) и удаляет старейшие state_* сверх бюджета. Файл: `background.js`.
- Тесты инвариантов: добавлены базовые Jest-тесты для StateManager и CommandExecutor (skip при HARD_STOP). Файлы: `tests/state-manager.test.js`, `tests/command-executor.test.js` (запуск требует установки jest, текущий запуск упал из-за отсутствия команды).

### 2025-12-03

- HumanSessionController: ввели абсолютный потолок hard-stop (10 мин) при продлении активности, пассивный heartbeat теперь учитывает `__LLMScrollHardStop` и скрытость вкладки; исключён бесконечный дрейф при росте DOM. Файл: `content-scripts/pipeline-modules.js`.
- Watcher wiring: `humanSession` прокинут в `UnifiedAnswerCompletionWatcher`, чтобы мутации/рост ответа продлевали сессию и не включался пассивный heartbeat посреди стрима. Файл: `content-scripts/unified-answer-pipeline.js`.
- Remote selector overrides: добавлен opt-in флаг `enable_remote_selectors_override` (по умолчанию off) и опциональная проверка SHA-256 (`REMOTE_SELECTORS_EXPECTED_SHA256`); ручной refresh отклоняется при выключенном флаге. Файл: `background.js`.
- Anti-sleep hard-stop: контентные ANTI_SLEEP_PING теперь игнорируются при `__LLMScrollHardStop`; ScrollCoordinator запрещает скролл при `humanSessionController` HARD_STOP; background анти-сон пинги не отправляются в вкладки с hard-stop (получаемом из контента). Файлы: `content-scripts/content-*.js`, `scroll-toolkit.js`, `background.js`, `content-scripts/pipeline-modules.js`.
- Hard-stop de-stickiness: сброс флага `__LLMScrollHardStop` и уведомления `SCROLL_HARD_STOP` отправляются при любом состоянии, отличном от HARD_STOP, чтобы background сразу убирал вкладку из `hardStopTabs` и не блокировал анти-сон там, где сессия завершена. Файлы: `content-scripts/pipeline-modules.js`, `background.js`.
- GPT mitigation: точечный override для ChatGPT — отключён maintenanceScroll и continuousActivity, оставлен initialScrollKick для надёжного старта. Файл: `content-scripts/pipeline-config.js`; документация: `docs/help-request-scroll-jitter.md`.
- MV3 State Persistence & Gatekeeper: hard-stop состояния переносятся в `chrome.storage.session` (вместо in-memory Set), анти-сон опирается на persisted state; добавлен `FORCE_HARD_STOP_RESTORE` на обновление вкладки. В контенте — ScrollGatekeeper (AbortController + capture wheel/scroll) подключён через `__ScrollGatekeeper`, вызывается при HARD_STOP из `HumanSessionController`. Файлы: `background.js`, `scroll-toolkit.js`, `content-scripts/pipeline-modules.js`.
- Pipeline local state (embedded): `unified-answer-pipeline` теперь пишет компактное состояние сессии в `localStorage llm_ext_<traceId>` (start/error/complete, длительность, длина ответа). Не использует chrome.storage, безопасно к квотам. Файл: `content-scripts/unified-answer-pipeline.js`.
- Tab state per вкладка: контент отправляет статус фаз в `chrome.storage.local state_<tabId>` (start/error/complete) для редкого сбора в SW; фоновый обработчик `STORE_TAB_STATE/AGGREGATE_TAB_STATES` добавлен. Файл: `background.js`, `content-scripts/unified-answer-pipeline.js`.
- TabProtector: добавлен беззвучный AudioContext keepalive только на время стрима, чтобы вкладка не выгружалась в фоне. Файлы: `content-scripts/pipeline-modules.js`, `content-scripts/unified-answer-pipeline.js`.
- Kill-switch broadcast: kill_switch в storage переключает HARD_STOP в контенте и блокирует скролл/активность (слушатель в `content-bootstrap.js` + forceHardStop). Файлы: `content-scripts/content-bootstrap.js`, `content-scripts/pipeline-modules.js`.
- DevTools вкладки: добавлены States (state_*), Commands (submit/stop/collect), Diagnostics (monkey-patch, diag events) без удаления существующих вкладок. Файлы: `result_new.html`, `results.js`.

### 2025-12-02

- UI: уменьшены вертикальные отступы между строками категорий в Tuning Console и блоком LLM Stream (убраны лишние margin/padding, снижены row-gap/grid-auto-rows), вернув плотный стык как в макете; треугольник кнопки Send центрирован и приведён к равностороннему виду. Файл: `styles.css`.
- DevTools / Commands: убраны инлайновые стили в карточке Submit Prompt, карточки выровнены по верхнему краю и приведены к единому отступу в теле; добавлена вспомогательная настройка для грид/кнопок (`result_new.html`, `styles.css`).
- DevTools / Commands: выровнены отступы внутри Submit Prompt, select и textarea теперь на полной ширине карточки с единым шагом между элементами (`styles.css`).
- Prompt clear: кнопка очистки теперь удаляет и текст, и выбранные модификаторы, и прикреплённые файлы (очищаются массивы вложений и панель обновляется) (`results.js`).

- LeChat: composer/send resolution теперь через SelectorFinder (учитывает удалённые overrides) + расширенные fallback-селекторы (aria-label message, data-testid composer/send, svg-icon send) в конфиге и контент-скрипте; исправляет недоставку промптов в версии 2.46.
- LeChat: усилен ввод в contenteditable (ProseMirror) — insertText + InputEvent beforeinput/input/change, чтобы текст принимался новым редактором Mistral.

### 2025-11-30

1) Удаление Humanoid overlay (всплывающего бара)
   - Файлы: `humanoid.js`, `manifest.json`.
   - Что сделано: полностью удалена инициализация/рендер панели `humanoid-control-bar`; исключён `humanoid.css` из подключений контент-скриптов.
   - Зачем: убрать визуальный шум и исключить лишние DOM-вставки/слушатели.

2) Единый плавный скролл
   - Файлы: `manifest.json`, `humanoid.js`.
   - Что сделано: `scroll-toolkit.js` подключён во все контент-скрипты; `Humanoid.humanScroll` использует ScrollToolkit приоритетно, с smooth fallback.
   - Эффект: прокрутка и settle становятся плавными и без дёрганий на всех платформах.

3) MouseSimulator / ReadingSimulator (имитация колёсика и чтения)
   - Файл: `humanoid.js`.
   - Что сделано: добавлены MouseSimulator (jitter + WheelEvent, разбивка на шаги) и ReadingSimulator (случайные скроллы/паузы/движения мыши). Экспортированы как `LLMExtension.mouseSimulator` / `LLMExtension.readingSimulator`. `Humanoid.humanScroll` сначала вызывает MouseSimulator, затем ScrollToolkit/native.
   - Эффект: более “живой” скролл (колёсико) и возможность триггерить генерацию/anti-sleep через человекоподобное поведение.

4) Усиление детекта окончания ответа
   - Файлы: `content-scripts/platform-selectors.js`, `content-scripts/pipeline-config.js`, `content-scripts/pipeline-modules.js`, `content-scripts/unified-answer-watcher.js`.
   - Что сделано:
     - Добавлены per-платформенные `generatingIndicators` и `completionIndicators` (явные сигналы “генерируется/готово”).
     - Критерий `completionSignal` в UniversalCompletionCriteria; учёт включённости критериев и динамический расчёт доли выполненных критериев (без жёсткого деления на 5).
     - Watcher теперь отмечает generating/completion индикаторы и использует их в критериях.
     - Конфиг completionCriteria получил флаг `completionSignalEnabled`.
   - Эффект: более раннее и надёжное завершение при наличии явных DOM-индикаторов, меньше зависаний на таймаутах.

5) Initial Scroll Kick перед стримингом
   - Файл: `content-scripts/unified-answer-pipeline.js`; настройки в `pipeline-config.js` (`streaming.initialScrollKick`).
   - Что сделано: перед фазой streaming выполняется доскролл вниз (ScrollToolkit → Humanoid.humanScroll → native), с телеметрией `scroll_kick`.
   - Эффект: предотвращает ситуации, когда платформа не начинает поток без прокрутки до низа.

7) Continuous Activity с MouseSimulator
   - Файл: `content-scripts/pipeline-modules.js` (ContinuousHumanActivity).
   - Что сделано: микроскроллы теперь в приоритете используют `LLMExtension.mouseSimulator.scrollWithMouse` (jitter + wheel), затем Humanoid.humanScroll, затем smooth scroll.
   - Эффект: во время ожидания поддерживается «живое» колесико, помогая платформам продолжать стриминг/не засыпать.

6) Документация
   - Файл: `docs/change-log-codex.md` (этот файл) — создан и будет пополняться при дальнейших изменениях.

8) Cursor Ghost (визуализация действий курсора, опционально)
   - Файл: `humanoid.js`.
   - Что сделано: добавлен `CursorGhost` (оранжевый круг, translate+transition) и экспортирован как `LLMExtension.cursorGhost`. MouseSimulator теперь двигает ghost при каждом mousemove (scroll/moveTo). Визуализация включается флагом `localStorage.__debug_cursor = 'true'`, по умолчанию скрыта.
   - Эффект: можно видеть траекторию “живых” скроллов/движений, не влияя на клики (pointer-events: none).

9) 3-минутный лимит human-like активности
   - Файлы: `content-scripts/pipeline-modules.js`, `docs/humanoid-session-policy.md`.
   - Что сделано: в ContinuousHumanActivity добавлен таймер `sessionTimeoutMs` (по умолчанию 3 мин). При старте активности запускается таймер, по истечении — `stop('session-timeout')` гасит микро-скроллы/heartbeats; новый запрос запускает новую сессию. Политика описана отдельно.
   - Эффект: human-like активность не гоняет вкладку бесконечно; после 3 минут остаётся функционал (копирование/отправка), а человекоподобные циклы перезапускаются только с новым запросом.

10) HumanSessionController (активность с лимитом и пассивным пульсом)
    - Файлы: `content-scripts/pipeline-modules.js`, `content-scripts/unified-answer-pipeline.js`.
    - Что сделано: добавлен HumanSessionController с рандомным лимитом (~180s ±20%), авто-переключением в EXPIRED при hidden, пассивным “scroll jitter” heartbeat после таймаута. Пайплайн запускает контроллер в начале streaming и останавливает при завершении/ошибке.
    - Эффект: шумная human-активность ограничена по времени; для длинных ответов остаётся лёгкий keepalive, чтобы не рвать стрим, без мешающей активности.

11) Hard-stop и продление при активности
    - Файлы: `content-scripts/pipeline-modules.js`, `content-scripts/unified-answer-pipeline.js`.
    - Что сделано: в HumanSessionController введён hard-stop дедлайн (8–10 мин с рандомом) с продлением при активности (+2 мин по reportActivity). Watcher репортит мутации/контентные изменения в сессию. В пайплайне hard-stop флаг прерывает ожидание (Promise.race) и маркирует streamingTimedOut.
    - Эффект: для reasoning-моделей остаётся безопасное окно, но бесконечные зависания не удерживают активность; при реальном стриме дедлайн отодвигается.

12) Bootstrap/namespace для контента
    - Файлы: `content-scripts/content-bootstrap.js`, `manifest.json`.
    - Что сделано: добавлен ранний bootstrap, создающий `window.LLMExtension`/`SelectorConfig` и stamp build info; подключён первым в списках content scripts во всех платформах.
    - Эффект: единое пространство имён готово для дальнейших модулей/override, без изменения текущего поведения.

13) SelectorFinderLite (фасад селекторов с override)
    - Файлы: `content-scripts/selectors-finder-lite.js`, `manifest.json`.
    - Что сделано: добавлен лёгкий фасад `SelectorFinderLite.getSelectors(platform)` с поддержкой `SelectorConfig.overrides`; подключён в контент до остальных модулей. Пока не меняет поведение — только даёт точку для override.
    - Эффект: можно безопасно накатывать селекторные override без ломки текущей логики; подготовка к многослойной системе селекторов.

14) SelectorMetrics (наблюдение за селекторами)
    - Файлы: `content-scripts/selectors-metrics.js`, `manifest.json`.
    - Что сделано: добавлен лёгкий сборщик метрик `SelectorMetrics.record/getAll` (успех/ошибка по типам/платформе), подключён ранним скриптом. Пока только лог/телеметрия, без изменения поведения.
    - Эффект: можно наблюдать деградации селекторов, подготовка к health-check/circuit breaker.

15) SelectorCircuit (мягкий circuit breaker для селекторов)
   - Файлы: `content-scripts/selectors-circuit.js`, `manifest.json`, `content-scripts/unified-answer-watcher.js`.
   - Что сделано: добавлен session-scoped circuit breaker (флаг в SelectorConfig, threshold по умолчанию 3). Watcher фильтрует селекторы через circuit, репортит успехи/фейлы только при реальных результатах/ошибках (не меняет поведение при валидных селекторах).
   - Эффект: снижает спам ошибками при плохих селекторах, готовит почву для устойчивости к поломкам DOM; включается/настраивается через SelectorConfig.

16) Storage budgets helper + cleanup
   - Файлы: `shared/storage-budgets.js`, `background.js`.
   - Что сделано: вынесена чистая функция `computeStorageCleanup` (TTL ack/command/state + maxKeys + диагностические события) и подключена в background через `importScripts`. Cleanup теперь опирается на helper и репортит DIAG_EVENT только при фактических удалениях.
   - Эффект: единая точка логики для тестов и рабочего кода, проще контролировать лимиты и причины удаления.

17) Тесты на бюджеты/интеграцию
   - Файлы: `tests/storage-budgets.test.js`, `tests/integration-end-to-end.test.js`.
   - Что сделано: добавлены реальные проверки computeStorageCleanup (TTL/eviction/maxKeys/diag trim) и StateManager guard/debounce. End-to-end тест прогоняет pragmatist-core + runner на jsdom (sessionId, state запись, командный поток с фильтрацией платформ, STOP_ALL broadcast).
   - Эффект: покрыты основные инварианты хранения и платформенной фильтрации команд; убраны пустышки тестов.

18) DevTools диагностика / батчи событий
   - Файлы: `background.js`, `results.js`, `result_new.html`.
   - Что сделано: DIAG_EVENT теперь записывает platform/traceId/sessionId/source, добавлены команды GET_DIAG_EVENTS/CLEAR_DIAG_EVENTS с фильтром по платформе и лимитом. В DevTools вкладке Diagnostics реализованы refresh/copy/download через background, фильтр по тексту, очистка, отображение platform/traceId/sessionId.
   - Эффект: видно, что и где генерирует события, можно быстро фильтровать по платформе/трейсу и выгружать логи без прямого доступа к storage.

19) Усиление стабильности после ревью
   - Файлы: `background.js`, `content-scripts/pragmatist-core.js`, `results.js`.
   - Что сделано: добавлен size guard для DIAG_EVENT (50KB + 200 записей), GET_DIAG_EVENTS ограничивает выдачу до 200 событий. CommandExecutor удаляет pending_command после успешного ACK текущей команды. StateManager завершает completion-таймер при hard_stop. Diagnostics UI рендерит максимум 200 событий.
   - Эффект: снижен риск переполнения diag-хранилища и дублирования команд, убраны лишние таймеры при hard-stop, UI не зависает на больших логах.

20) Scroll diagnostics & тестирование дерганий
   - Файлы: `scroll-toolkit.js`, `tests/scroll-metrics.test.js`.
   - Что сделано: добавлен hook `__setScrollEventHook` (события `micro_jitter` с delta/ts) и вспомогательный `_testMicroJitter` для диагностики дерганий; новый unit-тест фиксирует два события и два вызова scrollBy.
   - Эффект: появились лёгкие метрики для контроля микроскроллов/джиттера и база для будущих тестов по стабильности прокрутки.

21) Тесты открытия/навигации вкладок (NavigationDetector)
   - Файлы: `tests/tab-open-metrics.test.js`.
   - Что сделано: проверяется, что NavigationDetector вызывает onNavigate при изменении пути/параметров поиска (poll ~1000 мс), с управляемыми таймерами.
   - Эффект: зафиксирован корректный отклик на смену адреса; база для дальнейших метрик скорости открытия вкладок.

## Техническое задание: HumanSessionController (активность “как человек” с лимитом)

- Цель: Управлять human-like активностью (микроскроллы, MouseSimulator/ReadingSimulator, anti-sleep дрейф, визиты) в рамках одной сессии запроса: активный режим ~3 мин с рандомизацией, затем отключение “шумной” активности и переход в пассивный heartbeat, не мешая техническому функционалу (watcher, maintenance scroll, копирование/отправка).
- Область: Контент-скрипты (Humanoid/MouseSimulator/ReadingSimulator/ContinuousHumanActivity) + пайплайн запросов. Технические части (watcher, scroll settlement, maintenance scroll, финализация/копирование) не ограничиваются.

Функциональные требования:
1) Контроллер сессии
   - Состояния: IDLE, ACTIVE, EXPIRED/BACKGROUND_ACTIVE.
   - Методы: startSession(), expireSession() (авто по таймеру или visibilitychange), stopSession().
   - Старт: начало запроса/streaming; новый запрос в этой вкладке перезапускает сессию (stop → start).
   - Таймер: базовый лимит 180s с рандомизацией ±20% (настраиваемый диапазон). Возможность устанавливать seed/traceId для логов.
   - Лог/telemetry: логировать старт/истечение/стоп с traceId/вкладкой (если канал доступен).

2) Управление поведенческими модулями
   - ACTIVE: включить MouseSimulator/anti-sleep drift/ReadingSimulator прелоад (если используется) и ContinuousHumanActivity (микроскроллы).
   - EXPIRED/BACKGROUND: выключить шумные действия (микроскроллы, MouseSimulator автодвижения, ReadingSimulator автопросмотры, anti-sleep drift).
   - stopSession: полная остановка поведенческих модулей.

3) Пассивный heartbeat после таймаута
   - Лёгкий keepalive (scroll jitter): scrollBy(1), через ~50 мс scrollBy(-1); период 30–60 c (рандом), без визуализации.
   - Отключается при stopSession() или при старте новой сессии.

4) Обработка visibility
   - При document.hidden → сразу переключиться в EXPIRED/BACKGROUND_ACTIVE (шумные действия off, оставить только пассивный пульс), таймер сессии не сбрасывать.

5) Очередность остановки
   - При stopSession()/expire сначала очищать таймеры/интервалы, затем сбрасывать флаги/состояние, чтобы избегать гонок.

Нефункциональные:
- Лёгкость: минимальные таймеры/интервалы, без тяжёлых наблюдателей.
- UX-safe: pointer-events:none для визуализаций (CursorGhost), по умолчанию визуализация отключена.
- Конфликты: убедиться, что нет параллельных анти-sleep/визуализаций из background; если есть — отключить или синхронизировать.
- Конфигурируемость: параметры (baseTimeout, jitter%, passiveHeartbeatPeriod) в конфиге модуля/пайплайна.

## 2025-xx-xx — Фаза 1 (план: #5, #9, #11, #18)
- **#11 Удалить pingWindow код**: убран `ANTI_SLEEP_ALARM` в background (не создаётся и не обрабатывается), чтобы фоновый пинг не трогал вкладки после тайм‑аутов.
- **#18 Remote selectors alarm**: для `REMOTE_SELECTORS_ALARM` добавлена проверка `remoteSelectorsAllowed` перед вызовом `fetchRemoteSelectors` (guard на случай отключения).
- **#9 Pragmatist проверка auto**: `unified-answer-pipeline` валидирует наличие селекторов платформы; при отсутствии (нет записи в `PLATFORM_SELECTORS`) логируется `selectors_missing`, сохраняется `selectors_not_supported`, пайплайн завершается через `handleError` без фаз.
- **#5 Singleton result_new.html**: файл уже содержит `window.__RESULT_SINGLETON__` guard, подтверждено актуальное состояние (дубли не инициализируются).
- Копии файлов не менялись; изменения применены в основной кодовой базе.

## Таймлайн текущего процесса

| Step | Time (T+)  | Событие/действие                                                     | Описание                                                                                             |
|------|------------|---------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| 1    | 0 ms       | User clicks Send / старт пайплайна                                  | Запуск UnifiedAnswerPipeline с актуальными конфигами/селектором платформы                           |
| 2    | 0–50 ms    | Activate tab (если не активна)                                      | Ожидание visibilitychange (до 5s); если уже активна — мгновенно                                      |
| 3    | 50–500 ms  | Wait for stream start                                                | Поиск streamStart селекторов (или дефолтных); timeout ~45s                                           |
| 4    | 100–600 ms | Detect container                                                     | ScrollToolkit findScrollable → fallback answerContainer/document                                    |
| 5    | 150–700 ms | Initial scroll kick (down)                                          | ScrollToolkit → Humanoid.humanScroll → native smooth; телеметрия `scroll_kick`                      |
| 6    | 200 ms →   | Start HumanSession (ACTIVE)                                         | Таймер ~180s ±20% + hard-stop 8–10 мин; ContinuousHumanActivity микроскроллы включаются отдельно    |
| 7    | 200 ms →   | Streaming phase: parallel tasks                                     | 7a: Scroll settlement (retry/no-growth); 7b: Answer watcher (criteria + generating/completion)       |
| 8    | 200 ms →   | ContinuousHumanActivity (если включено)                             | Микро-скроллы (MouseSimulator → Humanoid → smooth) до истечения сессии/stop                         |
| 9    | …          | Criteria check / timeouts                                            | При достаточных критериях — успех; при soft/hard/hard-stop — ошибка/stop                            |
| 10   | …          | Transition to passive heartbeat (если сессия истекла)               | Scroll jitter (±1px) раз в 30–60s, watcher продолжает работать                                      |
| 11   | …          | Finalization phase                                                   | MaintenanceScroll (если включён), финальные стабильность-чек по hash, extract answer                |
| 12   | …          | SanityCheck                                                          | Предупреждения: hard timeout, активные индикаторы, рост контента, короткий ответ                    |
| 13   | …          | Return/telemetry                                                     | `success/answer/metadata`, telemetry (phases, completionReason), lifecycle stop                      |
| 14   | …          | Stop HumanSession                                                    | При завершении/ошибке — stopSession, выключение микроскроллов/heartbeat                             |
| 15   | …          | Готов к новому запросу в этой вкладке                                | Новый запрос → новый старт сессии (step 1–14)                                                        |

Примечания:
- Если `document.hidden` во время ACTIVE — немедленно EXPIRED, остаётся пассивный heartbeat.
- Hard-stop (8–10 мин с рандомом) срабатывает, если нет активности; при мутациях/росте текста дедлайн отодвигается (+2 мин).

## 2025-xx-xx — Kill-switch скролла и анти‑sleep в фоне
- **Content (HumanSessionController)**: жёсткий kill-switch скролла при HARD_STOP — monkey patch `scrollTo/scrollBy/scrollIntoView`, `overflow:hidden` для body; снимается при новом запуске/stopSession.
- **Background Anti-Sleep**: пинги ANTI_SLEEP_PING игнорируют вкладки в HARD_STOP/COMPLETED и автоматически закрывают ping-window; STOP_AND_CLEANUP закрывает ping-window. Дополнительно: если вкладка не активна 3+ минут, анти‑sleep выключается (закрывает ping-window, вычищает activity map), чтобы не было внешних скроллов после тайм-аута.
- **Anti-Sleep 3m hard cutoff**: логируется начало ping-window, и если с момента старта прошло >3 минут (даже при активности), окно принудительно закрывается и анти‑sleep прекращается; при истечении ping-window удаляются и метки старта.
- **Копия для экспорта**: те же фиксы перенесены в `Copy selector files/background.js`.

## 2025-xx-xx — Перф-харнесс Playwright
- Добавлен скрипт `tests/perf-multi-tab.js` для измерения времени открытия 8 вкладок, поиска поля ввода, ввода и отправки запроса (настройка URL/селекторов в файле).
- Документация по запуску: `docs/perf-tests.md` (настройка и вывод TSV).

## 2025-xx-xx — Копии файлов для работы с вкладками
- Обновлены все рабочие версии файлов в `Copied files` (background, content-скрипты, pipeline/pragmatist, selectors, overrides, scroll-toolkit/results) для актуального тестирования логики вкладок и селекторов без затрагивания основной ветки.
