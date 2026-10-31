import { matchesGlob } from "node:path/posix";

// A path glob (src/api/**/*.ts, {a,b}, [ab]) matched by Node's own matcher, the one Memorise uses for
// its path globs, so both plugins read a glob the same way. Globs come from agents (knowledge_search
// paths), from Memorise's exports, and from settings; Node's matcher does not backtrack on them and
// reads a malformed glob as text instead of throwing.
export function globMatches(glob: string, path: string): boolean {
  return matchesGlob(path, glob);
}

export function anyGlob(globs: readonly string[], path: string): boolean {
  return globs.some((glob) => globMatches(glob, path));
}
