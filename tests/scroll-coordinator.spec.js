const ScrollCoordinator = require('../scroll-toolkit.js');

describe('ScrollCoordinator', () => {
  let lifecycle;
  let coordinator;
  let forceStopTrigger;
  let startDrift;
  let stopDrift;

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '<div id="root"></div>';
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: 2000
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800
    });
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      value: jest.fn()
    });
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      writable: true,
      value: 0
    });
    lifecycle = {
      start: jest.fn(() => 'trace-123'),
      heartbeat: jest.fn(),
      stop: jest.fn()
    };
    window.HumanoidEvents = lifecycle;
    startDrift = jest.fn();
    stopDrift = jest.fn();
    coordinator = new ScrollCoordinator({
      source: 'test-scroll',
      getLifecycleMode: () => 'interactive',
      registerForceStopHandler: (fn) => {
        forceStopTrigger = fn;
        return () => { forceStopTrigger = null; };
      },
      startDrift,
      stopDrift,
      logPrefix: '[scroll-test]'
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    forceStopTrigger = null;
  });

  it('emits lifecycle start/stop for successful operation', async () => {
    const resultPromise = coordinator.run(async () => {
      await Promise.resolve();
      return 'OK';
    }, { keepAliveInterval: 50, operationTimeout: 1000 });

    await expect(resultPromise).resolves.toBe('OK');
    expect(lifecycle.start).toHaveBeenCalledWith(
      'test-scroll',
      expect.objectContaining({ mode: 'interactive', keepAliveInterval: 50, timeout: 1000 })
    );
    expect(lifecycle.heartbeat).toHaveBeenCalledWith('trace-123', 0, expect.objectContaining({ phase: 'init' }));
    expect(lifecycle.stop).toHaveBeenCalledWith('trace-123', expect.objectContaining({ status: 'success' }));
    expect(stopDrift).toHaveBeenCalled();
  });

  it('propagates force-stop requests and stops lifecycle trace', async () => {
    const neverResolving = () => new Promise(() => {});
    const runPromise = coordinator.run(neverResolving, { keepAliveInterval: 100, operationTimeout: 2000 });

    expect(typeof forceStopTrigger).toBe('function');
    forceStopTrigger();
    jest.runOnlyPendingTimers();
    await expect(runPromise).rejects.toMatchObject({ code: 'background-force-stop' });
    expect(lifecycle.stop).toHaveBeenCalledWith('trace-123', expect.objectContaining({ status: 'forced', reason: 'force-stop' }));
  });
});
