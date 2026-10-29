import type { Area, ProjectFacts } from "./knowledge";

export const OVERVIEW_AREAS = 12;
export const OVERVIEW_LINKS = 25;
const NEIGHBOURS = 8;

// How an area is named to people: its folder, or what the two special areas stand for.
export function areaLabel(path: string): string {
  return path === "" ? "Top level" : path === "(other)" ? "Other" : path;
}

// Text inside a Mermaid label: characters Mermaid reads as syntax are dropped, so a folder name can
// never close the label or start a new statement.
function label(text: string): string {
  return text.replace(/["`<>{}[\]()|#;&\\]/g, " ").replace(/\s+/g, " ").trim();
}

function node(id: string, area: Area): string {
  const size = area.files + area.tests;
  return `  ${id}["${label(areaLabel(area.path))}<br/>${size} ${size === 1 ? "file" : "files"}"]`;
}

// The biggest and most connected areas and the strongest links between them, as a Mermaid flowchart
// read top to bottom: areas that import sit above the areas they import. Stronger links are drawn
// thicker; areas with no drawn link are left out (their cards list them). Null when nothing connects.
export function overviewDiagram(facts: Pick<ProjectFacts, "areas" | "links">, maxAreas = OVERVIEW_AREAS, maxLinks = OVERVIEW_LINKS): string | null {
  const weight = new Map<string, number>();
  for (const link of facts.links) {
    weight.set(link.from, (weight.get(link.from) ?? 0) + link.count);
    weight.set(link.to, (weight.get(link.to) ?? 0) + link.count);
  }
  const chosen = facts.areas.filter((area) => weight.has(area.path)).sort((a, b) => b.files + b.tests + (weight.get(b.path) ?? 0) - (a.files + a.tests + (weight.get(a.path) ?? 0)) || a.path.localeCompare(b.path)).slice(0, maxAreas);
  const candidates = new Set(chosen.map((area) => area.path));
  const links = facts.links.filter((link) => candidates.has(link.from) && candidates.has(link.to)).slice(0, maxLinks);
  const drawn = chosen.filter((area) => links.some((link) => link.from === area.path || link.to === area.path));
  const ids = new Map(drawn.map((area, index) => [area.path, `a${index}`]));
  if (links.length === 0) return null;
  const strong = links[Math.floor(links.length / 4)]?.count ?? Infinity;
  return ["flowchart TB", ...drawn.map((area) => node(ids.get(area.path) as string, area)), ...links.map((link) => `  ${ids.get(link.from)} ${link.count >= strong ? "==>" : "-->"} ${ids.get(link.to)}`)].join("\n");
}

// One area with the areas that use it on the left and the areas it uses on the right, each link
// labelled with how many files make it.
export function neighbourDiagram(facts: Pick<ProjectFacts, "areas" | "links">, path: string): string | null {
  const area = facts.areas.find((candidate) => candidate.path === path);
  if (!area) return null;
  const usedBy = facts.links.filter((link) => link.to === path).slice(0, NEIGHBOURS);
  const dependsOn = facts.links.filter((link) => link.from === path).slice(0, NEIGHBOURS);
  if (usedBy.length === 0 && dependsOn.length === 0) return null;
  const byPath = new Map(facts.areas.map((candidate) => [candidate.path, candidate]));
  const lines = ["flowchart LR", node("focus", area), "  style focus stroke-width:3px"];
  // An area that both uses this one and is used by it gets one box, with an arrow each way.
  const ids = new Map<string, string>();
  const idOf = (other: Area) => {
    if (!ids.has(other.path)) {
      ids.set(other.path, `n${ids.size}`);
      lines.push(node(ids.get(other.path) as string, other));
    }
    return ids.get(other.path) as string;
  };
  for (const link of usedBy) {
    const other = byPath.get(link.from);
    if (other) lines.push(`  ${idOf(other)} -->|${link.count}| focus`);
  }
  for (const link of dependsOn) {
    const other = byPath.get(link.to);
    if (other) lines.push(`  focus -->|${link.count}| ${idOf(other)}`);
  }
  return lines.join("\n");
}

// A diagram as Markdown, for Paseo's Markdown renderer, which draws mermaid blocks.
export function mermaidBlock(diagram: string): string {
  return `\`\`\`mermaid\n${diagram}\n\`\`\`\n`;
}
