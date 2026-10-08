// A picker tool is built afresh for each pick. Repeated calls can draw more
// candidates from the same source, but should not rerun its library-wide query.
// Cache the source pool, not collect()'s capped result: collect() must run again
// against the pick's updated seen set to surface additional eligible tracks.
export function cacheSourcePool<T extends object>(read: (key: string) => T): (key: string) => T {
  const pools = new Map<string, T>();
  return (key) => {
    const cached = pools.get(key);
    if (cached !== undefined) return cached;
    const rows = read(key);
    pools.set(key, rows);
    return rows;
  };
}
