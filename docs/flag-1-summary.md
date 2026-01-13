# Flag 1 — Полный контекст (рабочее состояние, сделанные изменения, планы)

## 0. Быстрый ориентир (что уже есть / что ещё нет)
- **Есть (контент):** Unified Answer Pipeline/Watcher/Modules, ScrollToolkit, HumanSessionController (3 мин актив + пассивный пульс + hard-stop 8–10 мин с продлением), MouseSimulator + ReadingSimulator, CursorGhost (по флагу), SelectorFinderLite (override точка), SelectorMetrics (наблюдение), мягкий SelectorCircuit, initial scroll kick, генерация/completion индикаторы в селекторах.
- **Нет / частично (ключевые блоки):** Многоуровневый SelectorFinder (L1–L5), Circuit breaker с персистом/health-check, Platform Adapters/Factory, Remote overrides fetch, Validators/continue-handler, Structured extraction (code blocks, markdown), Selector System (стратегии L1–L5, cache-manager), Background lifecycle/jobState/anti-sleep/human-loop, донорский Results UI, Debug panel/logger.

## 1. Текущее состояние (что внедрено)
1. **Скролл и пайплайн**
   - ScrollToolkit подключён во всех контент-скриптах; Scroll kick при старте стриминга; Scroll settlement + MaintenanceScroll; smooth fallback.
   - Unified Answer Pipeline (preparation → streaming → finalization) с адаптивными soft/hard таймаутами, параллельным ожиданием scroll+answer, финальной стабилизацией.
   - Watcher: критерии mutationIdle/scrollStable/typingGone/sentinel/contentStable + generating/completion индикаторы; адаптивные таймауты; динамический счёт критериев; reportActivity в humanSession.

2. **Human-like активность**
   - HumanSessionController: ACTIVE ~180s ±20%, EXPIRED с пассивным scroll-jitter heartbeat (30–60с), hard-stop 8–10 мин (рандом) с продлением (+2 мин) при активности; переключение в EXPIRED при `document.hidden`; stopSession на выходе пайплайна/ошибке; onHardStop помечает streamingTimedOut.
   - ContinuousHumanActivity: микроскроллы через MouseSimulator → Humanoid → smooth, 3‑мин таймер (под контролем сессии).
   - MouseSimulator/ReadingSimulator: wheel+jitter, случайные движения; CursorGhost (по флагу `__debug_cursor`).

3. **Селекторы**
   - SelectorFinderLite: фасад с поддержкой `SelectorConfig.overrides` (без изменения поведения).
   - SelectorMetrics: `record/getAll` — успехи/фейлы по типам/платформам, лог в telemetry (если есть).
   - SelectorCircuit (мягкий): sessionStorage, threshold=3 (по умолчанию), фильтрация/репорт в watcher; включается через `SelectorConfig.circuitBreaker`.
   - Platform selectors: добавлены `generatingIndicators`/`completionIndicators` (базовые), но без актуализации по реальному DOM.

4. **Документация**
   - `docs/change-log-codex.md`: ведётся changelog по всем изменениям.
   - `docs/humanoid-session-policy.md`: политика 3‑мин сессий.
   - `docs/flag-1-summary.md` (этот файл): полный контекст.

## 2. Что ещё НЕ сделано (важное для селекторов/стабильности)
1. **Selector System (Iteration 3 roadmap):**
   - Многоуровневые стратегии L1–L5, cache-manager, heuristics, deep/shadow поиск, finder.js.
   - Circuit breaker с персистом и health-check; selector override health-check/telemetry.
   - Remote overrides fetch/refresh (по URL) — пока нет.

2. **Platform Adapters (Iteration 2):**
   - BasePlatformAdapter, PlatformFactory, адаптеры для 8 платформ; fire-and-forget send/check; cleanup; унификация findComposer/typeInput/waitForAnswer.

3. **Extraction/Continue/Validators (Iteration 4):**
   - validators.js (мультиязычные ошибки, retry); continue-handler (длинные ответы, merge без дублей, лимит MAX_CONTINUES); structured extractor/cleaner (code blocks с языком, markdown ссылки/списки, фильтр “Thinking...”, кнопок).

4. **Background orchestration:**
   - Lifecycle manager (Humanoid traces keep-alive/watchdog), incremental jobState/requestId snapshots, selector telemetry/version snapshots, remote selectors refresh, anti-sleep scheduler, human-presence loop, state hydration/circuit persistence.

5. **UI/Debug:**
   - Донорский Results UI (9-state UX, user log/exports, selector telemetry кнопки).
   - Debug panel/logger (уровни логов, экспорт истории).

6. **Selector актуализация:**
   - Реальный сбор generating/completion/answerContainer/streamStart по DOM платформ (GPT/Claude/Gemini/Perplexity/DeepSeek/LeChat/Qwen/Grok) — не сделано.

## 3. Таймлайн процессов (актуальный)
| Step | Time (T+)  | Событие/действие                                                     | Описание |
|------|------------|---------------------------------------------------------------------|----------|
| 1    | 0 ms       | User clicks Send / старт пайплайна                                  | Запуск UnifiedAnswerPipeline |
| 2    | 0–50 ms    | Activate tab                                                        | visibilitychange до 5s |
| 3    | 50–500 ms  | Wait for stream start                                               | streamStart selectors, timeout ~45s |
| 4    | 100–600 ms | Detect container                                                    | ScrollToolkit findScrollable → fallback |
| 5    | 150–700 ms | Initial scroll kick (down)                                          | ScrollToolkit → Humanoid → native; `scroll_kick` |
| 6    | 200 ms →   | Start HumanSession (ACTIVE)                                         | ~180s ±20%, hard-stop 8–10 мин с продлением; micro-scrolls отдельно |
| 7    | 200 ms →   | Streaming phase: scroll settlement + answer watcher                 | Retry/no-growth; критерии + generating/completion |
| 8    | 200 ms →   | ContinuousHumanActivity (если включено)                             | Микроскроллы (MouseSim→Humanoid→smooth) |
| 9    | …          | Criteria check / timeouts                                           | success / soft/hard/hard-stop |
| 10   | …          | Passive heartbeat (если сессия истекла)                             | Scroll jitter ±1px, 30–60s |
| 11   | …          | Finalization                                                        | MaintenanceScroll, стабилизация по hash, extract answer |
| 12   | …          | SanityCheck                                                         | Warn: hard timeout, active indicators, growth, short |
| 13   | …          | Return/telemetry                                                    | success/answer/metadata, phases, completionReason |
| 14   | …          | Stop HumanSession                                                   | stopSession, выключение микроскроллов/heartbeat |
| 15   | …          | Новый запрос                                                        | Новый цикл 1–14 |
Примечания: hidden → сразу EXPIRED (пассивный пульс). Hard-stop 8–10 мин сдвигается при активности (+2 мин на мутации/рост текста).

## 4. Планы (оставшиеся шаги по селекторам и стабильности)
1. Finder L1–L3: cache → config → heuristic, подключить в watcher/pipeline с fallback на старые селекторы.
2. Адаптеры/Factory: базовый adapter и 2–3 платформы по флагу; старое поведение как fallback.
3. Remote overrides (по флагу): fetch/refresh overrides.
4. Validators/continue-handler: ошибки/429, длинные ответы/merge, structured extraction/cleaner.
5. Health-check/telemetry: использовать SelectorMetrics + circuit для отчёта, без изменения поведения.
6. Расширения Humanoid/Debug/UI и background оркестрации — позже, по флагам.

## 5. Важные флаги/включение
- CursorGhost: `localStorage.__debug_cursor = 'true'`.
- SelectorCircuit: `SelectorConfig.circuitBreaker = { enabled: true, threshold: 3 }`.
- Overrides: `SelectorConfig.overrides = { platform: { selectorType: [...] } }` — через FinderLite.
- HumanSession: настройки через `streaming.humanSession` (baseTimeoutMs, jitterPct, hardStopMin/Max, passiveMin/Max, activityExtendMs).
