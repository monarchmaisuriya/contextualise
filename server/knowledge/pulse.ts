import type { Attention, BusyFile, Hotspot, PerDay } from "../../shared/knowledge";
import { type LiveAgent, needsYou } from "../agent-state";

const DAY_MS = 86_400_000;
// Attention covers what happened lately, whatever the window the screen shows.
export const ATTENTION_MS = 48 * 60 * 60 * 1000;
export const HOTSPOTS_SHOWN = 5;

// The day number of an instant in the viewer's time zone, `offsetMinutes` east of UTC.
function localDay(ms: number, offsetMinutes: number): number {
  return Math.floor((ms + offsetMinutes * 60_000) / DAY_MS);
}

// Counts per local day for the last `days` days, today last.
export function perDay(times: readonly number[], days: number, nowMs: number, offsetMinutes: number): PerDay {
  const first = localDay(nowMs, offsetMinutes) - days + 1;
  const counts = new Array<number>(days).fill(0);
  for (const time of times) {
    const index = localDay(time, offsetMinutes) - first;
    if (index >= 0 && index < days) counts[index] += 1;
  }
  return { firstDay: new Date(first * DAY_MS).toISOString().slice(0, 10), counts };
}

// Agents in this project waiting for M: permission requests first, then errors.
export function waitingAgents(agents: readonly LiveAgent[]): Extract<Attention, { kind: "agent" }>[] {
  const waiting = (reason: "permission" | "error") =>
    agents
      .filter((agent) => needsYou(agent) === reason)
      .map((agent) => ({ kind: "agent" as const, agentId: agent.id, title: agent.title ?? "Untitled agent", reason, since: agent.attentionTimestamp ?? agent.updatedAt ?? null }));
  return [...waiting("permission"), ...waiting("error")];
}

// Tasks that failed in the last 48 hours, newest first, one per agent, unless the same agent completed
// a task after. The screen leaves out agents already listed as waiting (one row per agent).
export function recentFailures(tasks: readonly { id: string; agentId: string; title: string; outcome: string; endedAt: string }[], nowMs: number): Extract<Attention, { kind: "failed-task" }>[] {
  const seen = new Set<string>();
  return tasks
    .filter((task) => task.outcome === "failed" && nowMs - Date.parse(task.endedAt) <= ATTENTION_MS)
    .filter((task) => !tasks.some((later) => later.agentId === task.agentId && later.outcome === "completed" && later.endedAt > task.endedAt))
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
    .filter((task) => !seen.has(task.agentId) && Boolean(seen.add(task.agentId)))
    .map((task) => ({ kind: "failed-task" as const, taskId: task.id, agentId: task.agentId, title: task.title, endedAt: task.endedAt }));
}

export interface HotspotInputs {
  files: readonly BusyFile[];
  days: 7 | 30 | 90;
  isCode(path: string): boolean;
  usedBy(path: string): number;
  tests(path: string): number;
  areaOf(path: string): string | null;
  // Whether an area has any linked test file; without one, "no tests" would say nothing.
  areaHasTests(area: string | null): boolean;
}

// Code files changed in the window, ranked by changes times how many files use them: what a change
// reaches most. The rank is a choice (no line counts are kept to weigh size), and is called "risky to
// change", not "bad". Tests are looked up for the files shown only; `untested` counts those without a
// linked test where their area has tests, so the tile and the list agree.
export function hotspots(inputs: HotspotInputs): { hotspots: Hotspot[]; untested: number } {
  const changes = (file: BusyFile) => (inputs.days === 7 ? file.recent.week : inputs.days === 30 ? file.recent.month : file.changes);
  const shown = inputs.files
    .filter((file) => changes(file) > 0 && inputs.isCode(file.path))
    .map((file) => {
      const usedBy = inputs.usedBy(file.path);
      return { path: file.path, changes: changes(file), usedBy, score: changes(file) * (1 + usedBy) };
    })
    .sort((a, b) => b.score - a.score || b.changes - a.changes || a.path.localeCompare(b.path))
    .slice(0, HOTSPOTS_SHOWN)
    .map(({ path, changes: count, usedBy }) => {
      const area = inputs.areaOf(path);
      return { path, area, changes: count, usedBy, tests: inputs.areaHasTests(area) ? inputs.tests(path) : null };
    });
  return { hotspots: shown, untested: shown.filter((hotspot) => hotspot.tests === 0).length };
}
