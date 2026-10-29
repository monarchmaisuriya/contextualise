import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// Settings text is read by people, not developers: no internal names, addresses, or file formats.
const JARGON = [/knowledge_\w+/, /127\.0\.0\.1/, /\bMCP\b/, /\bRPC\b/, /\bturns?\b/i, /\bworkers?\b/i, /\bindex(ed|es)?\b/i, /\bsymbols?\b/i, /\bADRs?\b/, /\bglobs?\b/i, /\bfetch(es|ed)?\b/i, /\bpill\b/i];

test("settings labels and hints use plain words", () => {
  const source = readFileSync(join(__dirname, "settings-screen.tsx"), "utf8");
  const texts = [...source.matchAll(/\b(?:label|hint|title)(?:=|: )(?:"([^"]*)"|`([^`]*)`)/g)].map((match) => match[1] ?? match[2]);
  expect(texts.length).toBeGreaterThan(40);
  for (const text of texts) for (const pattern of JARGON) expect(text, `"${text}" contains ${pattern}`).not.toMatch(pattern);
});
