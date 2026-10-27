import type { ItemRef, Vendor } from "../shared/contracts";
import type { PaseoApi } from "./paseo-types";
import type { Outcome, TagStore } from "./tag-store";
import { isAllowedWorkerTool, parseFetchReply } from "./vendor-fetch";
import { isWorkerCwd, runFetchWorker } from "./workers";

const MAX_RUNNING = 2;
// A worker can ask for a tool before agents.create has returned its id to us; wait this long for it.
const REGISTRATION_WAIT_MS = 5_000;

export type RunWorker = typeof runFetchWorker;
export type Decision = "allow" | "deny";

// Fetches items into tags through worker agents, at most MAX_RUNNING at once. A fetch is recorded as
// a note at once ("fetching") and finished in the background ("ready" or "failed" with the reason).
export class Fetcher {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly workers = new Map<string, Vendor>();

  constructor(
    private readonly store: TagStore,
    private readonly resolveRoot: () => Promise<string>,
    private readonly runWorker: RunWorker = runFetchWorker,
  ) {}

  // Adds the item to the tag, or fetches it again when the tag already has it.
  async start(paseo: PaseoApi, tag: string, item: ItemRef): Promise<Outcome & { noteId: string }> {
    const added = await this.store.addNote(tag, item);
    if (!added.changed) await this.store.updateNote(tag, added.noteId, { status: "fetching", error: null });
    this.launch(paseo, tag, added.noteId, item);
    return added;
  }

  async refresh(paseo: PaseoApi, tag: string, noteId: string): Promise<Outcome & { noteId: string }> {
    const note = Object.values(await this.store.read())
      .flatMap((stored) => stored.notes)
      .find((candidate) => candidate.id === noteId);
    if (!note) throw new Error(`No fetched item ${noteId} in "${tag}"`);
    const outcome = await this.store.updateNote(tag, noteId, { status: "fetching", error: null });
    this.launch(paseo, tag, noteId, { vendor: note.vendor, ref: note.ref });
    return { ...outcome, noteId };
  }

  // What to answer a tool request: null when the agent is not a fetch worker, so other plugins and
  // the user answer it as usual.
  async decide(agentId: string, cwd: string, toolName: string): Promise<Decision | null> {
    if (!this.workers.has(agentId) && !isWorkerCwd(await this.resolveRoot(), cwd)) return null;
    let vendor = this.workers.get(agentId);
    for (let waited = 0; !vendor && waited < REGISTRATION_WAIT_MS; waited += 100) {
      await new Promise((done) => setTimeout(done, 100));
      vendor = this.workers.get(agentId);
    }
    return vendor && isAllowedWorkerTool(vendor, toolName) ? "allow" : "deny";
  }

  private launch(paseo: PaseoApi, tag: string, noteId: string, item: ItemRef): void {
    void this.fetch(paseo, tag, noteId, item).catch((error: unknown) => console.error(`[contextualise] could not record the result of fetching ${item.vendor} ${item.ref}: ${String(error)}`));
  }

  private async fetch(paseo: PaseoApi, tag: string, noteId: string, item: ItemRef): Promise<void> {
    await this.slot();
    let workerId: string | null = null;
    try {
      const reply = await this.runWorker(paseo, await this.resolveRoot(), item, (agentId) => {
        workerId = agentId;
        this.workers.set(agentId, item.vendor);
      });
      const result = parseFetchReply(reply);
      if (!result.found) {
        await this.store.updateNote(tag, noteId, { status: "failed", error: result.text.trim().slice(0, 300) || "the item could not be read" });
        return;
      }
      await this.store.updateNote(tag, noteId, { status: "ready", title: result.title.trim() || item.ref, url: result.url, text: result.text, error: null, fetchedAt: new Date().toISOString() });
    } catch (error) {
      const message = String((error as Error).message ?? error);
      console.error(`[contextualise] fetching ${item.vendor} ${item.ref} failed: ${message}`);
      await this.store.updateNote(tag, noteId, { status: "failed", error: message.slice(0, 300) });
    } finally {
      if (workerId) this.workers.delete(workerId);
      this.release();
    }
  }

  private async slot(): Promise<void> {
    if (this.running < MAX_RUNNING) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resume) => this.waiting.push(resume));
  }

  // Hands the slot straight to the next waiting fetch, or frees it.
  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }
}
