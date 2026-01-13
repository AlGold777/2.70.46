# Технологический стек (Embedded Pragmatist) — 2025-12-05

Нумерованный перечень реализованных технологий и модулей с краткими описаниями и базовыми ProcessFlow диаграммами.

1. Pragmatist Core (State/Watcher/Nav/Cmd/Broadcast)  
   - StateManager: in-memory текст, сохранение метаданных в LS+chrome.storage с дебаунсами, size-guard, completion idle.  
   - StreamWatcher: MutationObserver с hard-stop guard, безопасное подключение (fallback к body), дебаунс обработки, первичный прогон состояния.  
   - NavigationDetector: опрос URL (pathname/search) с onNavigate callback.  
   - CommandExecutor: приём команд по `chrome.runtime.onMessage` (push, без лагов), фильтр по платформе/TTL, очередь + ACK per session/platform; pending_command остаётся лишь как бэкап (одноразовый recovery).  
   - BroadcastListener: STOP_ALL/kill_switch с фильтром по платформам, TTL 5s.  
   ProcessFlow:  
   ```
   stream mutation -> StreamWatcher -> StateManager.onStreamUpdate
                 runtime message (EXECUTE_COMMAND) -> CommandExecutor queue -> adapter action -> ACK cmd_ack_<id>_<session>
                 storage (pending_command) -> single recovery on boot
                 chrome.storage change (global_command) -> BroadcastListener -> onStopAll -> __LLMScrollHardStop
   ```

2. Pragmatist Runner (host-based adapter)  
   - Авто-детект платформы (chatgpt/claude/gemini/perplexity/grok/deepseek/qwen/lechat) по hostname.  
   - Подтягивает селекторы/индикаторы из SelectorConfig (detectUIVersion + getSelectorsFor).  
   - Сохраняет state в `state_<platform>_<sessionId>` и `state_<sessionId>`, поддерживает STOP_ALL/kill-switch, submit/stop/collect commands.  
   - SessionId стабилен per host, хранится в localStorage.  
   ProcessFlow:  
   ```
   boot -> restore state -> connect watcher -> start nav/cmd/broadcast
        -> receive pending_command (platform match) -> submit/stop/collect -> ACK
        -> STOP_ALL (runtime/storage) -> stopAll -> __LLMScrollHardStop
   ```

3. Unified Answer Pipeline / Watcher / SanityCheck  
   - Watcher: многокритериальный конец ответа (mutation idle, content stable, generating off, scroll stable), soft/hard таймауты.  
   - Pipeline: preparation/streaming/finalization, параллель ожидания scroll vs answer, финальный sanity-check.  
   - SanityCheck: предупреждения по hard timeout, активным индикаторам, росту контента, короткому ответу.  
   ProcessFlow:  
   ```
   prepare -> scroll kick -> streaming (watcher + scroll settlement) -> criteria met?
     yes -> finalization -> sanityCheck -> report
     no  -> soft/hard timeout -> error/stop
   ```

4. ScrollToolkit v2 (человеческий скролл + анти-дёргания)  
   - Gatekeeper (hard-stop, abort), drift/settlement/maintenance, jitter keepalive.  
   - Hook `__setScrollEventHook` + события `micro_jitter` (delta, ts) для диагностики дерганий.  
   - Keepalive/maintenance учитывают document.hidden и policy.  
   ProcessFlow:  
   ```
   requestScroll(source) -> gatekeeper allows? -> perform (drift/kick/jitter)
   hard-stop -> abort controller + block wheel/scroll
   ```

5. Humanoid Session & Anti-sleep  
   - HumanSessionController: ACTIVE ~3m ±20%, passive heartbeat, HARD_STOP 8–10m, EXPIRED при document.hidden.  
   - Отключение шумных действий (микроскроллы/MouseSim/ReadingSim) по таймеру, сохранение maintenance scroll.  
   - STOP_ALL/kill-switch пробрасывается в humanoid циклы.  

6. Selector Stack  
   - SelectorFinderLite + SelectorCircuit (порог ошибок 3) + SelectorMetrics.  
   - SelectorConfig/override с авто-детектом UI версии, версиями селекторов по платформам, кэш/auto-discovery.  
   - Fetch monitor в main world: ошибки/Retry-After в content→background.  

7. Background Orchestration  
   - Storage cleanup TTL: ACK 5m, pending_command 60s, state 24h, diag события (limit 200, size 50KB).  
   - Commands: SUBMIT_PROMPT теперь шлётся tabs через `chrome.tabs.sendMessage` (EXECUTE_COMMAND) + пишется в storage как резерв; GET_DIAG_EVENTS/CLEAR_DIAG_EVENTS, STOP_ALL broadcast, keep-alive alarms.  
   - Selector telemetry/version/status обработчики.  

8. DevTools / Diagnostics UI  
   - Вкладки Dev/Diagnostics: вывод состояний, команд, diag событий с platform/traceId/sessionId, copy/download, фильтр.  
   - States refresh перенесён в Dev Diag; вкладка API Keys → API.  

9. Results / Status UI  
   - 9-state индикаторы (IDLE/INITIALIZING/READY/SENDING/RECEIVING/SUCCESS/RECOVERABLE_ERROR/CRITICAL_ERROR + алиасы).  
   - Devlogs export/copy, user-friendly статусы.  

10. Storage Budgets & Helpers  
    - Helper computeStorageCleanup (maxKeys/valueSize/TTL) для background + tests.  
    - Budgets вынесены в shared/budgets.js, bootstrap загрузка в content/background.  

11. Copy Pack для ревью/доставки  
    - Синхронизированные версии core/runner/watcher/scroll/humanoid/background/pipeline в `Copy selector files/` для внешнего анализа.  

12. Тестовая база (Jest, jsdom)  
    - Unit/интеграция: StateManager, CommandExecutor, command flow, StreamWatcher, end-to-end runner (state/commands/STOP_ALL), storage budgets, selector finder, scroll metrics (micro-jitter hook), NavigationDetector.  
    - Все 20 тестов зелёные; jsdom предупреждения про scrollBy информативные.  

13. Документация  
    - Change-log (docs/change-log-codex.md), архитектурные спецификации (embedded-pragmatist-v2-spec.md), текущие диаграммы/таймлайны процесса.  

14. Attachment Delivery (clipboard-first)  
    - AttachmentBroker в UI (results/popup) принимает файлы из file-picker/drag&drop и из буфера обмена (Ctrl/Cmd+V скопированный файл); хранит только метаданные (name/size/type/hash) и временный blob-хэндл, не пишет payload в storage.  
    - SelectorConfig расширен блоком `attachments` per платформа: capability (clipboard/input/drop), селекторы для target (paste/textarea, drop-zone, `<input type="file">`), size guard, multi-file флаг; предпочитает clipboard путь там, где платформа умеет вставлять файл через paste.  
    - Runner AttachmentInjector выполняется до ввода промпта: собирает DataTransfer с File(s), пытается `paste`/`drop` на composer при supportsClipboard=true, fallback — присваивает files в input + change; ждёт подтверждения DOM (chip/progress) c таймаутом/размерным guard, иначе деградирует в text-only submit с diag event.  
    - ACK/Diag: отчёт об успешном/пропущенном attach per платформа, размер, режим (paste/input/drop), время; background/DevTools фиксируют сбои и fallback.  

ProcessFlow (сводная, high-level):  
```\nUser request (+attachments) -> Runner boot -> State restore -> Attachment inject (clipboard/input/drop) -> Watcher connect + Scroll kick\n -> (Streaming) StreamWatcher + ScrollToolkit settlement\n -> Completion criteria? yes -> SanityCheck -> Telemetry/State save\n -> STOP_ALL/Hard-stop? yes -> Gatekeeper abort + kill-switch\n -> DevTools/Diagnostics: states, commands, diag events (batch)\n```***
