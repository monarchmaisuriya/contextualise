import { type FetchPreference, type FetchProvider, type ItemRef, type Route, type SnapshotSettings, VENDOR_LABELS } from "../shared/contracts";
import type { PaseoApi } from "./paseo-types";
import type { Outcome, TagStore } from "./tag-store";
import { buildFetchPrompt, chooseRoute, isAllowedWorkerTool, parseFetchReply, type ToolRequest } from "./vendor-fetch";
import { isWorkerCwd, runFetchWorker } from "./workers";

// A worker can ask for a tool before agents.create has returned its id to us; wait this long for it.
const REGISTRATION_WAIT_MS = 5_000;

export type RunWorker = typeof runFetchWorker;
export type Decision = "allow" | "deny";

export interface FetcherDeps {
  store: TagStore;
  resolveRoot: () => Promise<string>;
  settings: () => Promise<SnapshotSettings>;
  configuredServers: () => Promise<ReadonlyMap<FetchProvider, ReadonlySet<string>>>;
  runWorker?: RunWorker;
}

// Fetches items into tags through worker agents, a configurable number at once. A fetch is recorded
// as a note at once ("fetching") and finished in the background ("ready", or "failed" with the reason).
export class Fetcher {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly workers = new Map<string, Route>();
  private readonly runWorker: RunWorker;

  constructor(private readonly deps: FetcherDeps) {
    this.runWorker = deps.runWorker ?? runFetchWorker;
  }

  // The agent and connector an item would be fetched with. Throws, with what to do, when none fits.
  async route(item: ItemRef, preference?: FetchPreference): Promise<Route> {
    const settings = await this.deps.settings();
    return chooseRoute(item.vendor, preference ?? settings.fetchProvider, settings.customRoutes, await this.deps.configuredServers());
  }

  // Adds the item to the tag, or fetches it again when the tag already has it.
  async start(paseo: PaseoApi, tag: string, item: ItemRef, preference?: FetchPreference): Promise<Outcome & { noteId: string; provider: FetchProvider; server: string }> {
    const route = await this.route(item, preference);
    const added = await this.deps.store.addNote(tag, item);
    await this.deps.store.updateNote(tag, added.noteId, { status: "fetching", error: null, provider: route.provider });
    this.launch(paseo, tag, added.noteId, item, route);
    return { ...added, provider: route.provider, server: route.server };
  }

  async refresh(paseo: PaseoApi, tag: string, noteId: string): Promise<Outcome & { noteId: string; provider: FetchProvider; server: string }> {
    const note = Object.values(await this.deps.store.read())
      .flatMap((stored) => stored.notes)
      .find((candidate) => candidate.id === noteId);
    if (!note) throw new Error(`No fetched item ${noteId} in "${tag}"`);
    const item = { vendor: note.vendor, ref: note.ref };
    const route = await this.route(item);
    const outcome = await this.deps.store.updateNote(tag, noteId, { status: "fetching", error: null, provider: route.provider });
    this.launch(paseo, tag, noteId, item, route);
    return { ...outcome, noteId, provider: route.provider, server: route.server };
  }

  // What to answer a tool request: null when the agent is not a fetch worker, so other plugins and
  // the user answer it as usual.
  async decide(agentId: string, cwd: string, request: ToolRequest): Promise<Decision | null> {
    if (!this.workers.has(agentId) && !isWorkerCwd(await this.deps.resolveRoot(), cwd)) return null;
    let route = this.workers.get(agentId);
    for (let waited = 0; !route && waited < REGISTRATION_WAIT_MS; waited += 100) {
      await new Promise((done) => setTimeout(done, 100));
      route = this.workers.get(agentId);
    }
    return route && isAllowedWorkerTool(route, request) ? "allow" : "deny";
  }

  private launch(paseo: PaseoApi, tag: string, noteId: string, item: ItemRef, route: Route): void {
    void this.fetch(paseo, tag, noteId, item, route).catch((error: unknown) => console.error(`[contextualise] could not record the result of fetching ${item.vendor} ${item.ref}: ${String(error)}`));
  }

  private async fetch(paseo: PaseoApi, tag: string, noteId: string, item: ItemRef, route: Route): Promise<void> {
    const settings = await this.deps.settings();
    await this.slot(settings.maxConcurrentFetches);
    let workerId: string | null = null;
    const save = (patch: Parameters<TagStore["updateNote"]>[2]) => this.deps.store.updateNote(tag, noteId, patch, settings.noteMaxChars);
    try {
      const reply = await this.runWorker(
        paseo,
        await this.deps.resolveRoot(),
        {
          route,
          title: `contextualise: fetch ${item.vendor} ${item.ref}`,
          prompt: buildFetchPrompt(item, route, { maxChars: settings.noteMaxChars, commentsPerItem: settings.commentsPerItem, extraInstructions: settings.extraInstructions }),
          model: route.provider === "claude" ? settings.claudeFetchModel : settings.codexFetchModel,
          timeoutMs: settings.fetchTimeoutSeconds * 1_000,
        },
        (agentId) => {
          workerId = agentId;
          this.workers.set(agentId, route);
        },
      );
      const result = parseFetchReply(reply);
      if (!result.found) {
        await save({ status: "failed", error: result.text.trim().slice(0, 300) || `the ${VENDOR_LABELS[item.vendor]} item could not be read` });
        return;
      }
      await save({ status: "ready", title: result.title.trim() || item.ref, url: result.url, text: result.text, error: null, fetchedAt: new Date().toISOString() });
    } catch (error) {
      const message = String((error as Error).message ?? error);
      console.error(`[contextualise] fetching ${item.vendor} ${item.ref} with ${route.provider} failed: ${message}`);
      await save({ status: "failed", error: message.slice(0, 300) });
    } finally {
      if (workerId) this.workers.delete(workerId);
      this.release();
    }
  }

  private async slot(limit: number): Promise<void> {
    if (this.running < limit) {
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
