import { KIND_LABELS, type KnowledgeEntry, type ProjectFacts } from "../../shared/knowledge";
import { plural } from "../plural";

const GLANCE_LANGUAGES = 2;
const FENCE_LANGUAGE: Record<string, string> = { py: "python", ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript", go: "go" };

export function languageShares(languages: Record<string, number>): { language: string; count: number; percent: number }[] {
  const total = Object.values(languages).reduce((sum, count) => sum + count, 0);
  return Object.entries(languages)
    .sort((a, b) => b[1] - a[1])
    .map(([language, count]) => ({ language, count, percent: Math.round((count / total) * 100) }));
}

// The project in one line under its name, in place of a card of numbers.
export function glanceLine(facts: Pick<ProjectFacts, "codeFiles" | "testFiles" | "languages"> & { areas: readonly unknown[] }): string {
  const shares = languageShares(facts.languages);
  const languages = shares.slice(0, GLANCE_LANGUAGES).map((share) => `${share.language} ${share.percent}%`);
  if (shares.length > GLANCE_LANGUAGES) languages.push(`+${shares.length - GLANCE_LANGUAGES} more`);
  return [plural(facts.codeFiles, "code file"), ...(facts.testFiles > 0 ? [plural(facts.testFiles, "test file")] : []), plural(facts.areas.length, "area"), ...(languages.length > 0 ? [languages.join(", ")] : [])].join(" · ");
}

// What an entry is and where it is, for its row and its reader.
export function entryMeta(entry: Pick<KnowledgeEntry, "kind" | "path" | "line" | "needsCheck" | "relatedMemories">): string {
  const where = entry.kind === "task" ? (entry.path ? `changed ${entry.path}` : null) : `${entry.path}${entry.line > 0 ? `:${entry.line}` : ""}`;
  return [
    KIND_LABELS[entry.kind],
    ...(where ? [where] : []),
    ...(entry.needsCheck ? ["needs check"] : []),
    ...(entry.relatedMemories.length > 0 ? [`Memorise: ${entry.relatedMemories.map((memory) => memory.subject).join(", ")}`] : []),
  ].join(" · ");
}

// An entry as people read it: the project's documents as Markdown, code as a highlighted block, and
// text an agent wrote (descriptions, task records) as plain text, since it may echo injected links.
export function readerBody(entry: Pick<KnowledgeEntry, "kind" | "path" | "body">): { text: string; plain: boolean } {
  if (entry.kind === "brief" || entry.kind === "task") return { text: entry.body, plain: true };
  if (entry.kind !== "code") return { text: entry.body, plain: false };
  return { text: `\`\`\`${FENCE_LANGUAGE[entry.path.split(".").pop() ?? ""] ?? ""}\n${entry.body}\n\`\`\``, plain: false };
}
