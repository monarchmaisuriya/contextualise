// Any tag change in this client tells open tag lists and the composer pills to reload.
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
