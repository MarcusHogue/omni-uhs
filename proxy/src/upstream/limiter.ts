/**
 * Per-host concurrency limiting and in-process request coalescing.
 *
 * Both exist for politeness rather than performance: uhs-hints.com has been
 * dormant for a decade and MediaWiki asks for serial requests. Two browser tabs
 * asking for the same file must produce one upstream fetch, not two.
 */

export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

export class HostLimiter {
  private readonly perHost = new Map<string, Semaphore>();

  constructor(private readonly limit: number) {}

  run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    let semaphore = this.perHost.get(host);
    if (!semaphore) {
      semaphore = new Semaphore(this.limit);
      this.perHost.set(host, semaphore);
    }
    return semaphore.run(fn);
  }
}

/**
 * Single-flight: concurrent callers asking for the same key share one promise.
 *
 * The entry is removed as soon as the work settles, so this is a coalescing
 * window rather than a cache — the cache itself lives on disk.
 */
export class SingleFlight {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  /** Number of operations currently in flight. Used by tests. */
  get size(): number {
    return this.inFlight.size;
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = fn().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }
}
