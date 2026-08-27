// src/lib/legal/cache.ts
// In-memory short-lived cache for ARLIS search + act detail responses.
//
// Goals (per spec §11, §38):
//  - accelerate retrieval for identical queries
//  - bounded size, TTL-based expiry
//  - request coalescing: identical concurrent lookups share one in-flight promise

type Entry<T> = {
  value: T;
  expiresAt: number;
};

export class TtlCache<T> {
  private store = new Map<string, Entry<T>>();
  private inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 256,
  ) {}

  has(key: string): boolean {
    const e = this.store.get(key);
    if (!e) return false;
    if (e.expiresAt < Date.now()) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  get(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    // Evict oldest entries if over capacity (FIFO-ish by insertion order)
    if (this.store.size >= this.maxEntries) {
      const firstKey = this.store.keys().next().value;
      if (firstKey) this.store.delete(firstKey);
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.ttlMs),
    });
  }

  /**
   * Coalesce concurrent lookups: returns the same in-flight promise if a
   * lookup for this key is already running.
   */
  async coalesce<K extends string>(
    key: K,
    producer: () => Promise<T>,
  ): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = producer()
      .then((v) => {
        this.set(key, v);
        return v;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, p);
    return p;
  }

  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }
}

/** Shared cache for ARLIS search responses (5 min TTL). */
export const searchCache = new TtlCache<unknown>(5 * 60 * 1000, 256);
/** Shared cache for ARLIS act-detail HTML (30 min TTL). */
export const actDetailCache = new TtlCache<unknown>(30 * 60 * 1000, 128);
