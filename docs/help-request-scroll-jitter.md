# Help Request: Scroll Jitter / Human-like Activity Does Not Stop

## Summary
Even after disabling/softening ContinuousHumanActivity, the page still scrolls/jitters visibly during long runs (reported even after 60 minutes). Need another pair of eyes to identify hidden sources of scroll/anti-sleep activity and propose a clean fix.

## What we changed already
- Disabled ContinuousHumanActivity by default; if enabled, it is very mild (interval 12s, range 8–24px, pause 800ms, MouseSim off).
- Softened MaintenanceScroll (check every 10s, growth threshold 300px, step 30px, idle 8s, maxDuration 15s).
- HumanSessionController: ACTIVE ~3m ± jitter, passive heartbeat (scroll jitter) after 3m, hard-stop at 8–10m (absolute cap 10m) with clean stop (HARD_STOP).

Config snapshot (content-scripts/pipeline-config.js):
```js
// глобальные настройки
continuousActivity: {
  enabled: false,
  interval: 12000,
  scrollRange: [8, 24],
  pauseBetweenMoves: 800,
  useMouseSimulator: false
},
maintenanceScroll: {
  enabled: true,
  checkInterval: 10000,
  growthThreshold: 300,
  scrollStep: 30,
  idleThreshold: 8000,
  maxDuration: 15000
}
// override для GPT (chatgpt): maintenanceScroll = off, continuousActivity = off, initialScrollKick = on
platformOverrides: {
  chatgpt: {
    maintenanceScroll: { enabled: false },
    continuousActivity: { enabled: false },
    initialScrollKick: { enabled: true, delay: 0 }
  }
}
```

Session controller (content-scripts/pipeline-modules.js):
```js
// Hard stop absolute max 10 min, with +2 min extend on activity, but capped
this.hardStopMin = 480000; // 8 min
this.hardStopMax = 600000; // 10 min
this.hardStopAbsoluteMaxMs = 600000;
this.activityExtendMs = 120000;
// In _hardStop(): clears all timers (active/passive/hardStop), state = 'HARD_STOP'
```

Watcher hooks (content-scripts/unified-answer-watcher.js):
- reportActivity on mutations/content changes → extends hard-stop, but capped at 10m.
- Uses SelectorCircuit (threshold 3) and Metrics (no behavior change).

## Symptoms we still see
- В активной фазе заметные дёргания/пролистывания страницы (визуально “рыскает”).
- Дёргания продолжаются и после 60 минут ожидания — выглядит так, будто что-то продолжает скроллить, несмотря на hard-stop и disabled ContinuousHumanActivity.

## Suspected hidden sources
- MaintenanceScroll всё ещё активен (порог 300px) и может триггериться при росте контента.
- ScrollToolkit/initialScrollKick or scroll settlement retries may still scroll during long streams.
- ReadingSimulator / MouseSimulator прямые вызовы (не через ContinuousHumanActivity) могут работать из других точек.
- Passive heartbeat (scroll jitter) мог остаться активным, если hard-stop не наступает (из-за постоянных мутаций?).
- Возможные сторонние anti-sleep/scroll в фоне (старые инжекты?).

## What to check
1) Confirm timers/state transitions: after 10m, is HumanSessionController.state == HARD_STOP? Are passive/active timers cleared?
2) MaintenanceScroll: is it running repeatedly on long answers (growthHeight > 300px)? Does it stop after maxDuration?
3) Any direct calls to MouseSimulator/ReadingSimulator outside ContinuousHumanActivity?
4) Initial scroll kick/settlement: do they retry during streaming, causing periodic scrolls?
5) Is there any leftover anti-sleep from background (we disabled pointer, but maybe scrolls)?

## How to reproduce
- Start a long-streaming request; observe the page for >10 minutes.
- Note any scroll/jitter after 3 minutes (ACTIVE off) and after 10 minutes (hard-stop expected).
- Check console for session state logs (streaming_start/done, hard_stop) and whether MaintenanceScroll logs show repeated runs.

## What help we need
- Identify actual source of scrolling beyond the 10-minute hard-stop.
- Propose a safe way to enforce “no scroll after HARD_STOP” while keeping necessary maintenance for DOM growth (maybe disable maintenance after hard-stop, or guard maintenance by session state).
- Suggest tracing points or instrumentation to pinpoint the actor (e.g., logging every scroll origin: maintenance/settlement/heartbeat/others).
