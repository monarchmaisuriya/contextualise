import { areaLabel } from "../../shared/diagram";
import type { Attention, Hotspot } from "../../shared/knowledge";
import { timeAgo } from "../../shared/time";
import { plural } from "../plural";

const number = (value: number) => value.toLocaleString("en-US");

export interface PeriodFacts {
  days: number;
  // Each is absent until its answer arrives; the sentence says what is known so far.
  agents?: { available: boolean; problem: string | null; running: number; needsYou: number };
  work?: { done: number; failed: number; canceled: number };
  changes?: { available: boolean; problem: string | null; commits: number; commitsTruncated: boolean; filesChanged: number; filesTruncated: boolean; untested: number; hotspots: number; analysed: boolean };
}

// The period in a few plain sentences, in place of a row of number tiles: what changed, what agents
// finished, who is running now, and what is risky. Counts cut at git's output limit say "+".
export function periodSummary(facts: PeriodFacts): string {
  const period = facts.days === 1 ? "Today" : `Last ${facts.days} days`;
  const changed: string[] = [];
  if (facts.changes?.available) {
    const { commits, filesChanged } = facts.changes;
    changed.push(commits === 0 ? "no commits" : `${number(commits)}${facts.changes.commitsTruncated ? "+" : ""} ${commits === 1 ? "commit" : "commits"} touching ${number(filesChanged)}${facts.changes.filesTruncated ? "+" : ""} ${filesChanged === 1 ? "file" : "files"}`);
  }
  if (facts.work) {
    const { done, failed, canceled } = facts.work;
    const ended = [[done, "finished"], [failed, "failed"], [canceled, "canceled"]].filter(([count]) => (count as number) > 0) as [number, string][];
    changed.push(ended.length === 0 ? "no agent work" : ended.map(([count, how], index) => (index === 0 ? `${plural(count, "agent task")} ${how}` : `${number(count)} ${how}`)).join(", "));
  }
  const sentences = changed.length > 0 ? [`${period}: ${changed.join("; ")}.`] : [];
  if (facts.changes && !facts.changes.available) sentences.push(asSentence(facts.changes.problem ?? "Change history needs git"));
  if (facts.agents?.available) {
    const { running, needsYou } = facts.agents;
    const waiting = needsYou > 0 ? `, ${number(needsYou)} ${needsYou === 1 ? "needs" : "need"} you` : "";
    sentences.push(`${running === 0 ? "No agents running now" : `${plural(running, "agent")} running now`}${waiting}.`);
  } else if (facts.agents) sentences.push(asSentence(facts.agents.problem ?? "Could not read Paseo's agents"));
  if (facts.changes?.available && facts.changes.analysed && facts.changes.untested > 0) {
    const { untested } = facts.changes;
    sentences.push(`${plural(untested, "often-changed file")} ${untested === 1 ? "has" : "have"} no tests.`);
  }
  return sentences.join(" ");
}

// A message as a sentence: a full stop only when it has no closing mark of its own.
function asSentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
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
