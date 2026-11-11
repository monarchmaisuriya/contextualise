import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

// What background model runs share: one queue, so two runs never go at once; a daily cap per kind of
// run, counted in its own file; and timers that wait until a chat has been quiet.

// Runs one piece of work at a time, in the order asked. A failed piece does not stop the next.
export class RunQueue {
  private queue: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

const stateSchema = z.object({
  version: z.literal(1),
  day: z.object({ date: z.string(), runs: z.number().int() }),
});
type DailyState = z.infer<typeof stateSchema>;

// Today's runs of one kind, against a cap read when each run is taken. The file only counts today's
// runs, so one that cannot be read starts a fresh count (logged) instead of stopping every run until
// someone deletes it.
export class DailyRuns {
  constructor(
    private readonly file: () => Promise<string>,
    private readonly max: () => Promise<number>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async read(): Promise<DailyState> {
    const path = await this.file();
    const text = await readFile(path, "utf8").catch(() => null);
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      console.error(`[contextualise] ${path} is not valid JSON, so today's run count starts again: ${String(error)}`);
    }
    const parsed = data === null ? null : stateSchema.safeParse(data);
    return parsed?.success ? parsed.data : { version: 1, day: { date: "", runs: 0 } };
  }

  // Whether today's cap allows another run, without taking it.
  async available(): Promise<boolean> {
    const state = await this.read();
    const runs = state.day.date === this.now().toISOString().slice(0, 10) ? state.day.runs : 0;
    return runs < (await this.max());
  }

  // One run, if today's cap allows it.
  async take(): Promise<boolean> {
    const state = await this.read();
    const today = this.now().toISOString().slice(0, 10);
    const runs = state.day.date === today ? state.day.runs : 0;
    if (runs >= (await this.max())) return false;
    const path = await this.file();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(`${path}.tmp`, JSON.stringify({ ...state, day: { date: today, runs: runs + 1 } }), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    return true;
  }
}

// One timer per key: setting it again restarts the wait.
export class QuietTimers {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  set(key: string, ms: number, fire: () => void): void {
    clearTimeout(this.timers.get(key));
    const timer = setTimeout(() => {
      this.timers.delete(key);
      fire();
    }, ms);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  clear(key: string): void {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
