import { describe, expect, it } from 'vitest';
import { RelayObserverMonitor } from '../../src/bridge/service/entry.js';

type Command = 'start-observer' | 'stop-observer';

const completed = (command: Command) => ({
  completed: true,
  status: command === 'start-observer' ? 'running' : 'stopped',
  observer: { running: command === 'start-observer', availability: command === 'start-observer' ? 'degraded' : 'unknown' },
});

describe('S02 real observer start/stop control', () => {
  it('forwards start/stop to the relay and reports the worker state it returns', async () => {
    const commands: Command[] = [];
    const events: unknown[] = [];
    let running = true;
    const monitor = new RelayObserverMonitor(
      event => events.push(event),
      async command => { commands.push(command); return completed(command); },
      () => running,
    );
    monitor.handle({ type: 'hello', process: 'relay', sessionEpoch: 'relay_1' });

    await monitor.startLive();
    expect(commands).toEqual(['start-observer']);
    expect(monitor.state()).toMatchObject({ running: true });

    await monitor.stopLive();
    expect(commands).toEqual(['start-observer', 'stop-observer']);
    expect(monitor.state()).toMatchObject({ running: false });
    running = false;
  });

  it('does not claim success when the relay fails to change the worker', async () => {
    const monitor = new RelayObserverMonitor(
      () => {},
      async () => ({ completed: false }),
      () => true,
    );
    await expect(monitor.startLive()).rejects.toThrow('observer-start-not-completed');
    expect(monitor.state()).toMatchObject({ running: false, stopped: true });

    const rejecting = new RelayObserverMonitor(
      () => {},
      async () => { throw new Error('worker-spawn-failed'); },
      () => true,
    );
    await expect(rejecting.startLive()).rejects.toThrow('worker-spawn-failed');
    expect(rejecting.state()).toMatchObject({ running: false, stopped: true });
  });

  it('ignores late events after stop and events from an old relay generation', async () => {
    const events: unknown[] = [];
    const monitor = new RelayObserverMonitor(
      event => events.push(event),
      async command => completed(command),
      () => true,
    );
    monitor.handle({ type: 'hello', process: 'relay', sessionEpoch: 'relay_1' });
    await monitor.startLive();
    monitor.handle({ type: 'event', sessionEpoch: 'relay_1', event: 'observer', payload: { kind: 'observation' } });
    expect(events).toHaveLength(1);

    // Relay restart: the old generation's late event is ignored until the new hello.
    monitor.handle({ type: 'hello', process: 'relay', sessionEpoch: 'relay_2' });
    monitor.handle({ type: 'event', sessionEpoch: 'relay_1', event: 'observer', payload: { kind: 'observation' } });
    expect(events).toHaveLength(1);
    monitor.handle({ type: 'event', sessionEpoch: 'relay_2', event: 'observer', payload: { kind: 'observation' } });
    expect(events).toHaveLength(2);

    await monitor.stopLive();
    monitor.handle({ type: 'event', sessionEpoch: 'relay_2', event: 'observer', payload: { kind: 'observation' } });
    expect(events).toHaveLength(2);
  });

  it('leaves boot-time startup to the relay config and still reports stopped accurately', async () => {
    const commands: Command[] = [];
    let running = false;
    const monitor = new RelayObserverMonitor(
      () => {},
      async command => { commands.push(command); return completed(command); },
      () => running,
    );
    await monitor.start();
    expect(commands).toEqual([]);
    running = true;
    await monitor.start();
    expect(commands).toEqual(['start-observer']);
    running = false;
    await monitor.stop();
    expect(monitor.state()).toMatchObject({ running: false, stopped: true, availability: 'unknown' });
  });
});
