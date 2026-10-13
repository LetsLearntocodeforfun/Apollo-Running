import { describe, expect, it } from 'vitest';
import { TabCoordinator, type TabCoordinatorEnv } from '../utils/tabCoordinator';

/** In-memory Web Locks: exclusive, FIFO queue, ifAvailable support. */
function fakeLocks() {
  let held = false;
  const queue: Array<() => void> = [];
  return {
    request(_name: string, options: { ifAvailable?: boolean }, cb: (lock: unknown) => unknown) {
      const run = () => {
        held = true;
        return Promise.resolve(cb({})).finally(() => {
          held = false;
          queue.shift()?.();
        });
      };
      if (!held) return run();
      if (options.ifAvailable) return Promise.resolve(cb(null));
      return new Promise((resolve) => queue.push(() => { void run().then(resolve); }));
    },
  };
}

/** In-memory BroadcastChannel bus shared by every coordinator in a test. */
function fakeBus() {
  const channels = new Set<{ onmessage: ((e: MessageEvent) => void) | null; closed: boolean }>();
  return (_name: string) => {
    const ch = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      closed: false,
      postMessage(data: unknown) {
        for (const other of channels) {
          if (other !== ch && !other.closed) queueMicrotask(() => other.onmessage?.({ data } as MessageEvent));
        }
      },
      close() { ch.closed = true; channels.delete(ch); },
    };
    channels.add(ch);
    return ch as unknown as BroadcastChannel;
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('TabCoordinator (PX-35)', () => {
  it('first tab is primary; a second tab is secondary and the first hears about it', async () => {
    const env: TabCoordinatorEnv = { locks: fakeLocks(), createChannel: fakeBus() };
    const first = new TabCoordinator(env);
    const second = new TabCoordinator(env);

    expect((await first.start()).role).toBe('primary');
    expect((await second.start()).role).toBe('secondary');
    await flush();
    expect(first.getState()).toEqual({ role: 'primary', otherTabOpened: true });

    first.stop();
    second.stop();
  });

  it('the second tab is promoted (and asked to reload) when the first closes', async () => {
    const env: TabCoordinatorEnv = { locks: fakeLocks(), createChannel: fakeBus() };
    const first = new TabCoordinator(env);
    const second = new TabCoordinator(env);
    await first.start();
    await second.start();
    const seen: string[] = [];
    second.subscribe((s) => seen.push(s.role));

    first.stop();
    await flush();
    await flush();
    expect(second.getState().role).toBe('promoted');
    expect(seen).toContain('promoted');
    second.stop();
  });

  it('falls back to a BroadcastChannel ping without Web Locks', async () => {
    const env: TabCoordinatorEnv = { locks: null, createChannel: fakeBus() };
    const first = new TabCoordinator(env);
    expect((await first.start()).role).toBe('primary');
    const second = new TabCoordinator(env);
    expect((await second.start()).role).toBe('secondary');
    await flush();
    expect(first.getState().otherTabOpened).toBe(true);
    first.stop();
    second.stop();
  });

  it('stays a silent single tab when neither API exists', async () => {
    const solo = new TabCoordinator({ locks: null, createChannel: null });
    expect(await solo.start()).toEqual({ role: 'primary', otherTabOpened: false });
    solo.stop();
  });
});
