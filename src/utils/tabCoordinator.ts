/**
 * v1.0.7 (PX-35): basic multi-tab coordination for the web version.
 *
 * Every tab loads the whole store into memory and writes it back, so two open
 * tabs silently overwrite each other's changes (last write wins). The desktop
 * app avoids this with Electron's single-instance lock; in the browser the
 * first tab holds a Web Lock and any later tab is told that Apollo is already
 * open elsewhere. The first tab also hears about the newcomer over a
 * BroadcastChannel, so both sides see the warning.
 *
 * Browsers without Web Locks fall back to a BroadcastChannel ping; without
 * either API the coordinator stays silent (single-tab behaviour, as before).
 */

export type TabRole =
  /** Only Apollo tab (or the first one). */
  | 'primary'
  /** Another tab already had Apollo open when this one started. */
  | 'secondary'
  /** This tab started second but the other tab has since closed: reload to get its latest data. */
  | 'promoted';

export interface TabState {
  role: TabRole;
  /** Primary tab only: another tab opened after this one. */
  otherTabOpened: boolean;
}

type Listener = (state: TabState) => void;

const LOCK_NAME = 'apollo-primary-tab';
const CHANNEL_NAME = 'apollo-tabs';
/** How long the BroadcastChannel fallback waits for an existing tab to answer. */
const PING_TIMEOUT_MS = 300;

type Message = { type: 'hello' } | { type: 'here' };

interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<unknown> | unknown,
  ): Promise<unknown>;
}

export interface TabCoordinatorEnv {
  locks?: LockManagerLike | null;
  createChannel?: ((name: string) => BroadcastChannel) | null;
}

function defaultEnv(): TabCoordinatorEnv {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManagerLike }) : undefined;
  return {
    locks: nav?.locks ?? null,
    createChannel: typeof BroadcastChannel === 'function' ? (name) => new BroadcastChannel(name) : null,
  };
}

export class TabCoordinator {
  private state: TabState = { role: 'primary', otherTabOpened: false };
  private readonly listeners = new Set<Listener>();
  private channel: BroadcastChannel | null = null;
  private releaseLock: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly env: TabCoordinatorEnv = defaultEnv()) {}

  getState(): TabState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start coordinating. Resolves once this tab knows its initial role. */
  async start(): Promise<TabState> {
    this.channel = this.env.createChannel ? this.env.createChannel(CHANNEL_NAME) : null;
    if (this.channel) this.channel.onmessage = (event: MessageEvent<Message>) => this.onMessage(event.data);

    if (this.env.locks) {
      await this.startWithLocks(this.env.locks);
    } else if (this.channel) {
      await this.startWithPing();
    }
    // Tell an existing primary tab that we're here (it shows its own notice).
    if (this.state.role === 'secondary') this.post({ type: 'hello' });
    return this.state;
  }

  stop(): void {
    this.stopped = true;
    this.releaseLock?.();
    this.releaseLock = null;
    this.channel?.close();
    this.channel = null;
    this.listeners.clear();
  }

  private async startWithLocks(locks: LockManagerLike): Promise<void> {
    const gotLock = await new Promise<boolean>((resolve) => {
      locks
        .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return undefined;
          }
          resolve(true);
          return this.holdLock();
        })
        .catch(() => resolve(true)); // locks unusable: behave like a single tab
    });
    if (gotLock) return;

    this.setState({ role: 'secondary', otherTabOpened: false });
    // Queue for the lock: when the first tab closes, this one takes over.
    locks
      .request(LOCK_NAME, {}, () => {
        if (this.stopped) return undefined;
        this.setState({ role: 'promoted', otherTabOpened: false });
        return this.holdLock();
      })
      .catch(() => {
        /* ignore — the warning simply stays up */
      });
  }

  /** A promise that keeps the lock until the tab closes or stop() runs. */
  private holdLock(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.releaseLock = resolve;
    });
  }

  private startWithPing(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, PING_TIMEOUT_MS);
      this.pendingPing = () => {
        clearTimeout(timer);
        this.setState({ role: 'secondary', otherTabOpened: false });
        resolve();
      };
      this.post({ type: 'hello' });
    });
  }

  private pendingPing: (() => void) | null = null;

  private onMessage(message: Message | undefined): void {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'hello') {
      if (this.state.role === 'secondary') return;
      // Someone opened Apollo after us.
      this.post({ type: 'here' });
      if (!this.state.otherTabOpened) this.setState({ ...this.state, otherTabOpened: true });
    } else if (message.type === 'here' && this.pendingPing) {
      const done = this.pendingPing;
      this.pendingPing = null;
      done();
    }
  }

  private post(message: Message): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      /* channel closed */
    }
  }

  private setState(next: TabState): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}
