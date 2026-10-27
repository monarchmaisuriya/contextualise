import type { PaseoApi } from "./paseo-types";

const CHECK_EVERY_MS = 15 * 60_000;

// Refreshes stale fetched items every 15 minutes while the setting is on; while it is off, no timer
// exists. Paseo hands a plugin its API only inside handlers and events, and it is the same object for
// the plugin process's whole life, so the first one seen is kept for the timer.
export class AutoRefresh {
  private timer: ReturnType<typeof setInterval> | null = null;
  private paseo: PaseoApi | null = null;

  constructor(private readonly refreshStale: (paseo: PaseoApi) => Promise<number>) {}

  use(paseo: PaseoApi): void {
    this.paseo ??= paseo;
  }

  apply(on: boolean): void {
    if (on && !this.timer) this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    if (!on) this.stop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async check(): Promise<void> {
    if (!this.paseo) return;
    try {
      const started = await this.refreshStale(this.paseo);
      if (started > 0) console.log(`[contextualise] refreshing ${started} stale fetched item(s)`);
    } catch (error) {
      console.error(`[contextualise] automatic refresh failed: ${String((error as Error).message ?? error)}`);
    }
  }
}
