// Keeps a registration in place while a check says it is wanted. One check runs at a time; asking
// again during it runs one more check after it, so the answer applied last is never older than the
// last request, and many requests at once cost two checks. Nothing is added once stopped.
export function followAvailability(check: () => Promise<boolean>, register: () => () => void, onError: (error: unknown) => void): { refresh(): void; stop(): void } {
  let remove: (() => void) | null = null;
  let running = false;
  let again = false;
  let stopped = false;
  async function run() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        try {
          const wanted = await check();
          if (stopped) return;
          if (wanted && !remove) remove = register();
          if (!wanted && remove) {
            remove();
            remove = null;
          }
        } catch (error) {
          if (!stopped) onError(error);
        }
      } while (again && !stopped);
    } finally {
      running = false;
    }
  }
  return {
    refresh: () => void run(),
    stop: () => {
      stopped = true;
      remove?.();
      remove = null;
    },
  };
}
