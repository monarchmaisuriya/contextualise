import { basename, extname } from "node:path";
import type { SymbolLanguage } from "../../shared/contracts";
import type { KnowledgeKind } from "../../shared/knowledge";
import { anyGlob } from "./globs";

const MARKDOWN = new Set([".md", ".mdx", ".markdown"]);
export const CODE_EXTENSIONS: Readonly<Record<string, "javascript" | "typescript" | "tsx" | "python" | "go">> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".go": "go",
};
// Tracked but not the project's own words or code.
export const SKIPPED_FOLDERS = new Set(["node_modules", "vendor", "third_party", "dist", "build", "out", ".git"]);
const ADR_FOLDERS = new Set(["adr", "adrs", "decisions", "architecture-decisions"]);
const CONVENTION_FILES = new Set(["contributing.md", "claude.md", "agents.md", ".cursorrules", "conventions.md", "style.md", "styleguide.md", "style-guide.md"]);

const LANGUAGE_OF: Readonly<Record<(typeof CODE_EXTENSIONS)[string], SymbolLanguage>> = { javascript: "javascript", typescript: "typescript", tsx: "typescript", python: "python", go: "go" };

export interface ClassifyOptions {
  // Globs that are never indexed, and globs indexed as docs whatever their extension.
  exclude?: readonly string[];
  extraDocs?: readonly string[];
  languages?: ReadonlySet<SymbolLanguage>;
}

// What a project file is to project knowledge, or null when it is not indexed. Paths are relative to
// the project root, with forward slashes, as git lists them.
export function classify(path: string, options: ClassifyOptions = {}): KnowledgeKind | null {
  if (options.exclude && anyGlob(options.exclude, path)) return null;
  const kind = builtInKind(path);
  if (kind === "code" && options.languages && !options.languages.has(LANGUAGE_OF[CODE_EXTENSIONS[extname(path).toLowerCase()]])) return null;
  return kind ?? (options.extraDocs && anyGlob(options.extraDocs, path) ? "doc" : null);
}

function builtInKind(path: string): KnowledgeKind | null {
  const segments = path.toLowerCase().split("/");
  const name = segments[segments.length - 1];
  const folders = segments.slice(0, -1);
  if (folders.some((folder) => SKIPPED_FOLDERS.has(folder))) return null;
  const extension = extname(name);
  if (CODE_EXTENSIONS[extension] && !name.endsWith(".d.ts") && !name.endsWith(".min.js")) return "code";
  if (CONVENTION_FILES.has(name) || folders.some((folder) => folder === "conventions")) return MARKDOWN.has(extension) || name === ".cursorrules" ? "convention" : null;
  if (!MARKDOWN.has(extension)) return null;
  if (folders.some((folder) => ADR_FOLDERS.has(folder)) || /^adr[-_]?\d+/.test(name)) return "adr";
  if (name.startsWith("architecture") || name.startsWith("design") || folders.some((folder) => folder === "architecture" || folder === "design")) return "architecture";
  return "doc";
}

export interface TextChunk {
  title: string;
  body: string;
  line: number;
}

const CHUNK_MAX_CHARS = 4_000;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

// A heading as people read it: link text without the address, no emphasis or code marks.
export function plainHeading(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`|~~)/g, "")
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}
const FENCE = /^\s*(```|~~~)/;

// One chunk per heading section, so a search hit points at the part of a document that matters. The
// title carries the parent headings ("Design > Storage"). Text before the first heading is titled by
// the file name. Long sections are split so no chunk exceeds CHUNK_MAX_CHARS.
export function chunkMarkdown(path: string, text: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  const trail: string[] = [];
  let title = basename(path);
  let line = 1;
  let lines: string[] = [];
  let inFence = false;
  const flush = () => {
    const body = lines.join("\n").trim();
    for (let start = 0; start < body.length; start += CHUNK_MAX_CHARS) chunks.push({ title, body: body.slice(start, start + CHUNK_MAX_CHARS), line });
    lines = [];
  };
  text.split("\n").forEach((raw, index) => {
    if (FENCE.test(raw)) inFence = !inFence;
    const heading = inFence ? null : HEADING.exec(raw);
    if (!heading) {
      lines.push(raw);
      return;
    }
    flush();
    const depth = heading[1].length;
    trail.splice(depth - 1, trail.length, plainHeading(heading[2]));
    title = trail.filter(Boolean).join(" > ");
    line = index + 1;
  });
  flush();
  return chunks;
}

export interface AdrInfo {
  status: string | null;
  supersededBy: string | null;
}

// An ADR's status from front matter ("status: accepted"), a "Status: Accepted" line, or the first
// line under a "Status" heading; and what replaced it, from "Superseded by <link or name>".
export function adrInfo(text: string): AdrInfo {
  const lines = text.split("\n");
  let status: string | null = null;
  for (let i = 0; i < lines.length && status === null; i += 1) {
    const inline = /^\s*(?:[-*]\s*)?\**status\**\s*:\s*\**\s*(.+?)\s*$/i.exec(lines[i]);
    if (inline) status = inline[1];
    else if (/^#{1,6}\s+status\s*$/i.test(lines[i])) status = lines.slice(i + 1).find((next) => next.trim() !== "")?.trim() ?? null;
  }
  // Status words are single words (proposed, accepted, deprecated, superseded, rejected); the rest
  // of the line is detail such as a date or "by ADR-4".
  const word = status?.replace(/[*`]/g, "").trim().split(/[\s.(,;:]/)[0].toLowerCase();
  const superseded = /superseded by:?\s*(?:\[([^\]]+)\]\(([^)]+)\)|([^\s,;]+))/i.exec(text.replace(/[*`]/g, ""));
  const supersededBy = superseded ? (superseded[2] ?? superseded[3]?.replace(/\.$/, "") ?? superseded[1]) : null;
  return { status: word || null, supersededBy };
}
