/**
 * TtlCache — tiny in-process TTL cache for hot middleware lookups.
 *
 * Only cache POSITIVE results with this (a granted membership, a resolved
 * org). Denials must stay uncached so newly-granted access takes effect
 * immediately; revoked access lingers at most `ttlMs`.
 */

export class TtlCache<V> {
  private map = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly max = 5000,
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.map.size >= this.max && !this.map.has(key)) {
      // Evict the oldest insertion — crude LRU, plenty for middleware caches.
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}
