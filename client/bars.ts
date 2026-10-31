// A bar shows a value against its neighbours; when every value in a group is the same, each bar is
// full and says nothing the number beside it does not, so none is drawn.
export function barsCarryInformation(values: readonly number[]): boolean {
  return values.length > 1 && values.some((value) => value !== values[0]);
}
