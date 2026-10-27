import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// Paseo provides useAgent and useWorkspace only in workspace and agent panels and in popover content;
// in a plugin screen they throw "Plugin state hooks must run inside a workspace panel". The plugin's
// components are shared between the Tags screen and the Tags pill, so none of them use these hooks:
// the server's tags.list and agents.describe carry the names instead.
test("no client code uses Paseo's panel-only state hooks", () => {
  const root = join(__dirname, "..");
  const files = [join(root, "index.client.tsx"), ...readdirSync(__dirname).filter((name) => /\.tsx?$/.test(name) && !name.includes(".test.")).map((name) => join(__dirname, name))];
  for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(/\buse(Agent|Workspace)\s*\(|import[^;]*\buse(Agent|Workspace)\b/);
});
