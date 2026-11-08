// A time as milliseconds, from an ISO time or epoch milliseconds; null when there is none or it cannot
// be read. Every comparison of activity times goes through here, so one rule reads them all.
export function timeOf(time: string | number | null | undefined): number | null {
  const value = typeof time === "number" ? time : time ? Date.parse(time) : Number.NaN;
  return Number.isNaN(value) ? null : value;
}

// The newest time per key, of the items that have one.
export function newestPerKey<T>(items: readonly T[], keyOf: (item: T) => string | null | undefined, at: (item: T) => string | number | null | undefined): Map<string, number> {
  const newest = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    const time = timeOf(at(item));
    if (key && time !== null && time > (newest.get(key) ?? Number.NEGATIVE_INFINITY)) newest.set(key, time);
  }
  return newest;
}

// Newest first by `timeOf` (an ISO time or epoch milliseconds). Items without a readable time go last.
// The sort is stable, so ties and items without a time keep the order they came in.
export function newestFirst<T>(items: readonly T[], at: (item: T) => string | number | null | undefined): T[] {
  const read = (item: T) => timeOf(at(item)) ?? Number.NEGATIVE_INFINITY;
  return items
    .map((item, index) => ({ item, index, at: read(item) }))
    .sort((a, b) => (a.at === b.at ? a.index - b.index : b.at - a.at))
    .map(({ item }) => item);
}
