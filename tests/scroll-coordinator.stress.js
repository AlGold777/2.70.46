#!/usr/bin/env node
/**
 * ScrollCoordinator stress runner.
 * Usage:
 *   node tests/scroll-coordinator.stress.js --minutes=0.5 --iterations=5
 * Defaults simulate ~1 minute workload. Increase minutes to run >30 min.
 */

require('jsdom-global')();

const ScrollCoordinator = require('../scroll-toolkit.js');

const args = process.argv.slice(2).reduce((acc, token) => {
  const [key, value] = token.replace(/^--/, '').split('=');
  acc[key] = value !== undefined ? value : true;
  return acc;
}, {});

const minutes = parseFloat(args.minutes || process.env.SCROLL_STRESS_MINUTES || '0.1');
const iterations = parseInt(args.iterations || process.env.SCROLL_STRESS_ITERATIONS || '5', 10);
const durationPerIteration = Math.max(1000, Math.floor((minutes * 60 * 1000) / Math.max(1, iterations)));

Object.defineProperty(document.documentElement, 'scrollHeight', {
  configurable: true,
  value: 4000
});
Object.defineProperty(window, 'innerHeight', {
  configurable: true,
  value: 900
});
Object.defineProperty(window, 'scrollY', {
  configurable: true,
  writable: true,
  value: 0
});
window.scrollTo = () => {};

const telemetry = {
  starts: 0,
  stops: 0,
  heartbeats: 0
};

window.HumanoidEvents = {
  start: () => {
    telemetry.starts += 1;
    return `stress-trace-${telemetry.starts}`;
  },
  heartbeat: () => {
    telemetry.heartbeats += 1;
  },
  stop: () => {
    telemetry.stops += 1;
  }
};

let forceStopCallback = null;
const coordinator = new ScrollCoordinator({
  source: 'stress-scroll',
  getLifecycleMode: () => 'stress',
  registerForceStopHandler: (fn) => {
    forceStopCallback = fn;
    return () => { forceStopCallback = null; };
  },
  startDrift: () => {},
  stopDrift: () => {},
  logPrefix: '[scroll-stress]'
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runIteration(index) {
  const startedAt = Date.now();
  await coordinator.run(async () => {
    const chunks = Math.max(1, Math.floor(durationPerIteration / 500));
    for (let i = 0; i < chunks; i += 1) {
      await sleep(500);
    }
  }, { keepAliveInterval: 500, operationTimeout: durationPerIteration + 5000 });
  console.log(`Iteration #${index + 1} completed in ${Date.now() - startedAt}ms`);
}

(async () => {
  console.log(`Starting ScrollCoordinator stress test: minutes=${minutes}, iterations=${iterations}, durationPerIteration=${durationPerIteration}ms`);
  for (let i = 0; i < iterations; i += 1) {
    await runIteration(i);
  }
  console.log('Stress test complete:', telemetry);
  if (forceStopCallback) {
    forceStopCallback();
  }
  process.exit(0);
})().catch((err) => {
  console.error('ScrollCoordinator stress test failed:', err);
  if (forceStopCallback) {
    try { forceStopCallback(); } catch (_) {}
  }
  process.exit(1);
});
