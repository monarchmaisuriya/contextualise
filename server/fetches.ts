import { FETCH_RESULT_KIND, type FetchPreference, type FetchProvider, type FetchResult, type ItemRef, type Route, type SnapshotSettings, VENDOR_LABELS } from "../shared/contracts";
import type { PaseoApi } from "./paseo-types";
import type { NotePatch, Outcome, StoredNote, TagStore } from "./tag-store";
import { buildFetchPrompt, chooseRoute, isAllowedWorkerTool, parseFetchReply, type ToolRequest } from "./vendor-fetch";
import { isWorkerCwd, runFetchWorker } from "./workers";

// A worker can ask for a tool before agents.create has returned its id to us; wait this long for it.
const REGISTRATION_WAIT_MS = 5_000;

export type RunWorker = typeof runFetchWorker;
export type ReportResult = typeof postFetchResult;
export type Decision = "allow" | "deny";

// One row per fetched item in the agent that asked for it; the id is the item's, so the next result
// for the same item replaces the row. Paseo appends only to a loaded agent, so one entry is read first.
export async function postFetchResult(paseo: PaseoApi, agentId: string, result: FetchResult): Promise<void> {
  const timeline = paseo.agents.ref(agentId).timeline;
  await timeline.refetch({ direction: "tail", limit: 1, projection: "projected" });
  await timeline.append({ type: "plugin", id: `fetch-${result.noteId}`, kind: FETCH_RESULT_KIND, version: 1, data: result });
}

export interface FetcherDeps {
  store: TagStore;
  resolveRoot: () => Promise<string>;
  settings: () => Promise<SnapshotSettings>;
  configuredServers: () => Promise<ReadonlyMap<FetchProvider, ReadonlySet<string>>>;
  runWorker?: RunWorker;
  report?: ReportResult;
}

// Fetches items into tags through worker agents, a configurable number at once. A fetch is recorded
// as a note at once ("fetching") and finished in the background ("ready", or "failed" with the reason).
export class Fetcher {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly workers = new Map<string, Route>();
  private readonly runWorker: RunWorker;
  private readonly report: ReportResult;

  constructor(private readonly deps: FetcherDeps) {
    this.runWorker = deps.runWorker ?? runFetchWorker;
    this.report = deps.report ?? postFetchResult;
  }

  // The agent and connector an item would be fetched with. Throws, with what to do, when none fits.
  async route(item: ItemRef, preference?: FetchPreference): Promise<Route> {
    const settings = await this.deps.settings();
    return chooseRoute(item.vendor, preference ?? settings.fetchProvider, settings.customRoutes, await this.deps.configuredServers());
  }

  // Adds the item to the tag, or fetches it again when the tag already has it. `notifyAgentId` is the
  // agent that asked; it is kept on the item, so every later manual refresh reports to it too.
  async start(paseo: PaseoApi, tag: string, item: ItemRef, preference?: FetchPreference, notifyAgentId?: string): Promise<Outcome & { noteId: string; provider: FetchProvider; server: string }> {
    const route = await this.route(item, preference);
    const added = await this.deps.store.addNote(tag, item);
    await this.deps.store.updateNote(tag, added.noteId, { status: "fetching", error: null, provider: route.provider, ...(notifyAgentId ? { notifyAgentId } : {}) });
    const note = await this.note(tag, added.noteId);
    this.launch(paseo, tag, added.noteId, item, route, note.notifyAgentId);
    return { ...added, provider: route.provider, server: route.server };
  }

  // Fetches a stored item again. Automatic refreshes report to no agent.
  async refresh(paseo: PaseoApi, tag: string, noteId: string, { auto = false }: { auto?: boolean } = {}): Promise<Outcome & { noteId: string; provider: FetchProvider; server: string }> {
    const note = await this.note(tag, noteId);
    const item = { vendor: note.vendor, ref: note.ref };
    const route = await this.route(item);
    const outcome = await this.deps.store.updateNote(tag, noteId, { status: "fetching", error: null, provider: route.provider });
    this.launch(paseo, tag, noteId, item, route, auto ? null : note.notifyAgentId);
    return { ...outcome, noteId, provider: route.provider, server: route.server };
  }

  // Fetches ready items older than the setting's hours again, through the same queue and limit.
  // Returns how many were started; 0 while automatic refresh is off.
  async refreshStale(paseo: PaseoApi): Promise<number> {
    const settings = await this.deps.settings();
    if (!settings.autoRefreshItems) return 0;
    const cutoff = Date.now() - settings.autoRefreshHours * 3_600_000;
    const stale = Object.values(await this.deps.store.read()).flatMap((tag) =>
      tag.notes.filter((note) => note.status === "ready" && note.fetchedAt !== null && Date.parse(note.fetchedAt) < cutoff).map((note) => ({ tag: tag.name, note })),
    );
    let started = 0;
    for (const { tag, note } of stale) {
      try {
        await this.refresh(paseo, tag, note.id, { auto: true });
        started += 1;
      } catch (error) {
        console.error(`[contextualise] could not refresh ${note.vendor} ${note.ref} automatically: ${String((error as Error).message ?? error)}`);
      }
    }
    return started;
  }

  private async note(tag: string, noteId: string): Promise<StoredNote> {
    const note = Object.values(await this.deps.store.read())
      .flatMap((stored) => stored.notes)
      .find((candidate) => candidate.id === noteId);
    if (!note) throw new Error(`No fetched item ${noteId} in "${tag}"`);
    return note;
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

  private launch(paseo: PaseoApi, tag: string, noteId: string, item: ItemRef, route: Route, notifyAgentId: string | null): void {
    void this.fetch(paseo, tag, noteId, item, route, notifyAgentId).catch((error: unknown) => console.error(`[contextualise] could not record the result of fetching ${item.vendor} ${item.ref}: ${String(error)}`));
  }

  private async fetch(paseo: PaseoApi, tag: string, noteId: string, item: ItemRef, route: Route, notifyAgentId: string | null): Promise<void> {
    const settings = await this.deps.settings();
    await this.slot(settings.maxConcurrentFetches);
    let workerId: string | null = null;
    let patch: NotePatch;
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
      patch = result.found
        ? { status: "ready", title: result.title.trim() || item.ref, url: result.url, text: result.text, error: null, fetchedAt: new Date().toISOString() }
        : { status: "failed", error: result.text.trim().slice(0, 300) || `the ${VENDOR_LABELS[item.vendor]} item could not be read` };
    } catch (error) {
      const message = String((error as Error).message ?? error);
      console.error(`[contextualise] fetching ${item.vendor} ${item.ref} with ${route.provider} failed: ${message}`);
      patch = { status: "failed", error: message.slice(0, 300) };
    } finally {
      if (workerId) this.workers.delete(workerId);
      this.release();
    }
    await this.deps.store.updateNote(tag, noteId, patch, settings.noteMaxChars);
    if (notifyAgentId && settings.notifyFetchResults) await this.tell(paseo, notifyAgentId, tag, noteId);
  }

  // Reports what was saved, so the row matches the item. A row that cannot be added is only logged.
  private async tell(paseo: PaseoApi, agentId: string, tag: string, noteId: string): Promise<void> {
    try {
      const note = await this.note(tag, noteId);
      if (note.status === "fetching") return;
      await this.report(paseo, agentId, { tag, noteId, vendor: note.vendor, ref: note.ref, title: note.title, status: note.status, error: note.error, chars: note.text.length });
    } catch (error) {
      console.error(`[contextualise] could not show the result of ${noteId} in agent ${agentId}: ${String((error as Error).message ?? error)}`);
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
