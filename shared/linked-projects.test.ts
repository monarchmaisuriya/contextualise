import { expect, test } from "vitest";
import { mentionPath } from "./linked-projects";

test("writes a path the way Paseo's @ does: in double quotes, with inner double quotes escaped", () => {
  expect(mentionPath("/w/api/src/queue.ts")).toBe('"/w/api/src/queue.ts"');
  expect(mentionPath('/w/odd "name".md')).toBe('"/w/odd \\"name\\".md"');
});
