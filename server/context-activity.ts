import { createHmac, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { contextEventSchema, type ContextActivitySnapshot, type ContextReceipt, type ContextTool } from "../shared/context";

export function textSize(text: string) {
  return { characters: text.length, bytes: Buffer.byteLength(text, "utf8"), tokens: Math.round(text.length / 4) };
}

export function receipt(text: string, source: ContextReceipt["source"], state: ContextReceipt["state"], included = 1, omitted = 0, freshness: ContextReceipt["freshness"] = "unknown"): ContextReceipt {
  return { ...textSize(text), source, state, included, omitted, freshness };
}

export class ContextActivity {
  private recording = false;
  private revision = 0;
  private generation = 0;
  private serial = 0;
  private startedAt: string | null = null;
  private evicted = 0;
  private readonly key = randomBytes(32);
  private readonly projects = new Map<string, number>();
  private readonly repeats = new Map<string, number>();
  private rows: { project?: number; expires: number; event: ContextActivitySnapshot["events"][number] }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly now: () => number = Date.now) {}

  control(action: "start" | "stop" | "clear"): ContextActivitySnapshot {
    if (action === "start" && !this.recording) {
      this.recording = true;
      this.startedAt = new Date(this.now()).toISOString();
      this.generation += 1;
    } else if (action !== "start") {
      this.recording = false;
      this.generation += 1;
      this.repeats.clear();
      if (action === "clear") {
        this.rows = [];
        this.projects.clear();
        this.evicted = 0;
        this.startedAt = null;
      }
    }
    this.revision += 1;
    return this.snapshot();
  }

  private prune(): void {
    const now = this.now();
    const kept = this.rows.filter((row) => row.expires > now);
    if (kept.length !== this.rows.length) this.revision += 1;
    this.rows = kept;
    for (const [key, expires] of this.repeats) if (expires <= now) this.repeats.delete(key);
    const used = new Set(this.rows.map((row) => row.project));
    for (const [key, handle] of this.projects) if (!used.has(handle)) this.projects.delete(key);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const next = Math.min(...this.rows.map((row) => row.expires), ...this.repeats.values());
    if (Number.isFinite(next)) {
      this.timer = setTimeout(() => this.prune(), Math.max(1, next - now));
      this.timer.unref();
    }
  }

  record(value: ContextReceipt, repoKey?: string, detail: { tool?: ContextTool; outcome?: "ok" | "empty" | "error"; durationMs?: number; repeated?: boolean } = {}): void {
    if (!this.recording) return;
    this.prune();
    let project = repoKey === undefined ? undefined : this.projects.get(repoKey);
    if (repoKey !== undefined && project === undefined) {
      project = ++this.serial;
      this.projects.set(repoKey, project);
    }
    const event = contextEventSchema.parse({ ...value, ...detail, id: ++this.serial, at: new Date(this.now()).toISOString(), outcome: detail.outcome ?? "ok", durationMs: detail.durationMs ?? null, repeated: detail.repeated ?? false });
    this.rows.push({ project, expires: this.now() + 30 * 60_000, event });
    if (this.rows.length > 200) { this.rows.shift(); this.evicted += 1; }
    this.revision += 1;
    this.prune();
  }

  async observe<T>(source: "knowledge" | "history" | "updates", tool: ContextTool, scope: string, input: unknown, work: () => Promise<T>, result: (value: T) => { text: string; empty?: boolean; error?: boolean }, repoKey?: string): Promise<T> {
    if (!this.recording) return work();
    const generation = this.generation;
    const start = performance.now();
    const value = await work();
    if (!this.recording || generation !== this.generation) return value;
    // Observation is advisory and cannot turn a successful retrieval into a failure.
    try {
      const output = result(value);
      const digest = createHmac("sha256", this.key).update(JSON.stringify([scope, repoKey, tool, input, output.text])).digest("hex");
      this.prune();
      const repeated = this.repeats.has(digest);
      this.repeats.set(digest, this.now() + 30 * 60_000);
      if (this.repeats.size > 1_000) this.repeats.delete(this.repeats.keys().next().value!);
      this.record(receipt(output.text, source, "returned"), repoKey, { tool, outcome: output.error ? "error" : output.empty ? "empty" : "ok", durationMs: Math.max(0, performance.now() - start), repeated });
    } catch (error) {
      console.error("[contextualise] context observation failed:", error instanceof Error ? error.name : "unknown error");
    }
    return value;
  }

  snapshot(repoKey?: string): ContextActivitySnapshot {
    this.prune();
    const project = repoKey === undefined ? undefined : this.projects.get(repoKey);
    return { revision: this.revision, recording: this.recording, startedAt: this.startedAt, expiresAfterMinutes: 30, evicted: this.evicted, window: "retained", events: this.rows.filter((row) => repoKey === undefined || (project !== undefined && row.project === project)).map((row) => ({ ...row.event })).reverse() };
  }

  stop(): void {
    this.control("clear");
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
