// A small LRU keyed by string, bounded by an approximate byte budget, that also
// de-duplicates concurrent loads of the same key (two tiles wanting one chunk make one
// request, not two).

export class LruCache {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.map = new Map();
    this.pending = new Map();
  }

  async get(key, load) {
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit);
      return hit.value;
    }
    if (this.pending.has(key)) return this.pending.get(key);
    const p = (async () => {
      const value = await load();
      const size = value?.byteLength ?? 64;
      this.map.set(key, { value, size });
      this.bytes += size;
      while (this.bytes > this.maxBytes && this.map.size > 1) {
        const [k, v] = this.map.entries().next().value;
        this.map.delete(k);
        this.bytes -= v.size;
      }
      return value;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }
}
