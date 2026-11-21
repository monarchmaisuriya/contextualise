// Metadata stays outside the model-visible result and never stores source text.
const empty = new WeakSet<object>();
export function emptyResult<T extends object>(result: T, isEmpty: boolean): T {
  if (isEmpty) empty.add(result);
  return result;
}
export function isEmptyResult(result: object): boolean { return empty.has(result); }
