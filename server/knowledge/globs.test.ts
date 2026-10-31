import { describe, expect, it } from "vitest";
import { anyGlob, globMatches } from "./globs";

describe("globMatches", () => {
  it("matches like Memorise's globs: folders, one level, braces, and character classes", () => {
    expect(globMatches("src/**/*.ts", "src/a/b/c.ts")).toBe(true);
    expect(globMatches("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(globMatches("src/{api,web}/**", "src/web/x/y.ts")).toBe(true);
    expect(globMatches("src/[ab].ts", "src/a.ts")).toBe(true);
    expect(globMatches("README.md", "README.md")).toBe(true);
    expect(anyGlob(["docs/**", "*.md"], "notes.md")).toBe(true);
  });

  it("treats a malformed glob as text instead of throwing", () => {
    expect(() => globMatches("src/{a", "src/a")).not.toThrow();
    expect(() => globMatches("src/a}", "src/b")).not.toThrow();
  });

  it("stays fast on globs built to backtrack", () => {
    const started = Date.now();
    globMatches(`${"**/".repeat(99)}x`, "a/b/c/d/e/f/g");
    globMatches("*a".repeat(14), "a".repeat(40));
    expect(Date.now() - started).toBeLessThan(500);
  });
});
