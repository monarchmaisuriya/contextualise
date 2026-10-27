// Tagging from the composer (/tag, /untag) tells an open Tags screen to reload.
const listeners = new Set<() => void>();

export function onTagsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function tagsChanged(): void {
  for (const listener of listeners) listener();
}
