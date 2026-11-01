import { areaLabel } from "../../shared/diagram";
import type { Attention, Hotspot } from "../../shared/knowledge";
import { timeAgo } from "../../shared/time";
import { plural } from "../plural";

// One tile: a number to see at a glance and one sentence saying what it counts. `muted` tiles teach
// what would show there; `warning` ones count something to look at.
export interface TileText {
  value: string;
  sentence: string;
  tone: "normal" | "warning" | "muted";
}

const number = (value: number) => value.toLocaleString("en-US");

export function workTile(work: { done: number; failed: number; canceled: number }): TileText {
  if (work.done + work.failed + work.canceled === 0) return { value: "0", sentence: "Agents' finished work shows here", tone: "muted" };
  return { value: number(work.done), sentence: `tasks done${work.failed > 0 ? ` · ${work.failed} failed` : ""}`, tone: work.failed > 0 ? "warning" : "normal" };
}

// Counts cut at git's output limit are floors, so they say "+".
export function changesTile(changes: { available: boolean; problem: string | null; commits: number; commitsTruncated: boolean; filesChanged: number; filesTruncated: boolean }): TileText {
  if (!changes.available) return { value: "–", sentence: changes.problem ?? "Change history needs git", tone: "muted" };
  return { value: `${number(changes.commits)}${changes.commitsTruncated ? "+" : ""}`, sentence: `commits · ${number(changes.filesChanged)}${changes.filesTruncated ? "+" : ""} files`, tone: "normal" };
}

export function riskTile(risk: { untested: number; hotspots: number; analysed: boolean }): TileText {
  if (!risk.analysed) return { value: "–", sentence: "Risk needs Python, TypeScript, JavaScript, or Go code", tone: "muted" };
  if (risk.hotspots === 0) return { value: "0", sentence: "code files changed lately", tone: "muted" };
  return { value: number(risk.untested), sentence: "hot files without tests", tone: risk.untested > 0 ? "warning" : "normal" };
}

export function agentsTile(now: { available: boolean; problem: string | null; running: number; needsYou: number; finished: number }): TileText {
  if (!now.available) return { value: "–", sentence: now.problem ?? "Could not read Paseo's agents", tone: "muted" };
  if (now.needsYou > 0) return { value: number(now.needsYou), sentence: `need you · ${now.running} running`, tone: "warning" };
  return { value: number(now.running), sentence: now.finished > 0 ? `running · ${now.finished} finished` : "agents running", tone: now.running > 0 ? "normal" : "muted" };
}

const ATTENTION_ROWS = 3;

// At most three rows: agents waiting for M first, then recent failures of agents not already listed.
export function attentionRows(waiting: readonly Attention[], failures: readonly Attention[]): Attention[] {
  const listed = new Set(waiting.map((item) => item.agentId));
  return [...waiting, ...failures.filter((item) => !listed.has(item.agentId))].slice(0, ATTENTION_ROWS);
}

export function attentionRow(item: Attention, now = Date.now()): { title: string; meta: string; danger: boolean } {
  if (item.kind === "failed-task") return { title: item.title, meta: `task failed · ${timeAgo(item.endedAt, now)}`, danger: true };
  const why = item.reason === "permission" ? "asks for permission" : "stopped with an error";
  return { title: item.title, meta: item.since ? `${why} · ${timeAgo(item.since, now)}` : why, danger: item.reason === "error" };
}

// A hot file's line under its path. Tests are said only when they mean something (the area has some).
export function hotspotMeta(hotspot: Hotspot): string {
  return [
    ...(hotspot.area !== null ? [areaLabel(hotspot.area)] : []),
    plural(hotspot.changes, "change"),
    ...(hotspot.usedBy > 0 ? [`used by ${hotspot.usedBy}`] : []),
    ...(hotspot.tests === null ? [] : [hotspot.tests === 0 ? "no tests" : plural(hotspot.tests, "test")]),
  ].join(" · ");
}

// Column heights for counts, scaled to the tallest; any count above zero stays visible.
export function barHeights(counts: readonly number[], height: number): number[] {
  const top = Math.max(0, ...counts);
  if (top === 0) return counts.map(() => 0);
  return counts.map((count) => (count === 0 ? 0 : Math.max(2, Math.round((count / top) * height))));
}
