// Typed settings wait as drafts until saved. These rules keep what the screen shows and what Save
// writes the same thing.

// Typing the stored value back is no change, so it leaves no draft behind.
export function withDraft<Key extends string>(drafts: Partial<Record<Key, string>>, key: Key, text: string, stored: string): Partial<Record<Key, string>> {
  const next = { ...drafts };
  if (text === stored) delete next[key];
  else next[key] = text;
  return next;
}

// The one field whose card shows Save: the one typed in last while it still waits, else any other
// waiting field, so a pending change always has a visible Save.
export function saveRowKey<Key extends string>(lastEdited: Key | null, drafts: Partial<Record<Key, string>>): Key | null {
  if (lastEdited !== null && drafts[lastEdited] !== undefined) return lastEdited;
  return (Object.keys(drafts) as Key[])[0] ?? null;
}

// A section that can be closed stays open while any of its fields has unsaved text or a problem.
export function keepsOpen<Key extends string>(keys: readonly Key[], drafts: Partial<Record<Key, string>>, errors: Partial<Record<Key, string>>): boolean {
  return keys.some((key) => drafts[key] !== undefined || errors[key] !== undefined);
}
