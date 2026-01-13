# Telemetry - tab/session diagnostics

## Update v2.54.24 - 2025-12-22 23:14 UTC
Purpose: unify pipeline telemetry routing and reduce volume with 5% session sampling.
- `PIPELINE_EVENT` is now a first-class IPC channel routed into diagnostics storage.
- Background applies per-session telemetry sampling (`TELEMETRY_SAMPLE_RATE=0.05`), with errors bypassing sampling.
- `STOP_DISAPPEARED` is emitted when the stop button vanishes during streaming.
- Verbose criteria logs: `LLMExtension.flags.verboseAnswerWatcher = true` or `localStorage.__verbose_answer_watcher = 'true'`.

## Update v2.54.8 - 2025-12-21 06:59 UTC
Purpose: surface telemetry meta in diagnostics UI and add content-pipeline events for full traceability.
- Diagnostics UI now renders `meta` JSON for each entry so timing/snapshot data is visible.
- UnifiedAnswerPipeline emits `PIPELINE_*` events (start/prep/stream/finalize/complete/error).
- Dispatch adds `PROMPT_SUBMITTED_TIMEOUT` to capture no-confirmation cases.
- Background emits `RUN_END` per model on first response to capture final status.
- Per-model overrides provide `llmName` to pipeline so events attach to correct model logs.

## Update v2.54.7 - 2025-12-21 06:40 UTC
Purpose: define the telemetry schema needed to analyze tab lifecycle and dispatch flow.

## Base schema (v2.54.7)
Purpose: standard fields for correlating events across tabs, queue, and responses.
- `ts` - event timestamp (ms).
- `extVersion` - extension version.
- `sessionId` - run/session id (jobState.session.startTime).
- `requestId` - LLM request id.
- `llmName` - model name.
- `tabId` - tab id.
- `event` - telemetry event name.
- `details`/`level` - human-readable details and severity.
- `meta` - extra fields (snapshot, timing, reason, dispatchId).

## Event catalog (v2.54.7)
Purpose: complete trace from tab open to prompt confirmation.
- `RUN_START` - session start per model.
- `RUN_END` - first response received per model (success/error).
- `TAB_CREATED` - new tab created.
- `TAB_REUSE_CANDIDATE` / `TAB_REUSE_REJECTED` - reuse attempt and rejection.
- `ATTACH_CANDIDATE` / `TAB_ATTACHED` / `ATTACH_REJECTED` - attach flow and rejection.
- `TAB_READY_CHECK` / `TAB_READY_WAIT_END` / `TAB_READY_FAIL` - tab readiness (load/reload).
- `TAB_DISCARDED_RELOAD` - discarded tab recovery.
- `DISPATCH_LOCK_ACQUIRE` / `DISPATCH_START` / `DISPATCH_SEND` - queue and send phase.
- `PROMPT_SUBMITTED_ACCEPTED` / `PROMPT_SUBMITTED_REJECTED` / `PROMPT_SUBMITTED_STALE` - submit confirmation handling.
- `PROMPT_SUBMITTED_TIMEOUT` - submit confirmation timeout (no signal received).
- `PIPELINE_START` / `PREPARATION_*` / `STREAMING_*` / `FINALIZATION_*` / `PIPELINE_COMPLETE` / `PIPELINE_ERROR` - content pipeline phases.
- `STOP_DISAPPEARED` - stop button vanished (completion heuristic).
- `SCRIPT_HEALTH_FAIL` - health check failure.
- `SCRIPT_REINJECT_START` / `SCRIPT_REINJECT_RESULT` - content script reinject.
- `TAB_CLOSED` - tab closed (removeInfo).

## Snapshot schema (v2.54.7)
Purpose: quick tab context at event time.
- `url`, `status`, `discarded`, `active`, `lastAccessed`, `windowId`, `pinned`, `audible`, `title`.
