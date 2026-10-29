// A path glob (src/api/**/*.ts, one {a,b} group at most) as a regular expression, the same rules as
// Memorise's path globs.
export function globMatches(glob: string, path: string): boolean {
  let pattern = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      pattern += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else if (char === "{") pattern += "(?:";
    else if (char === "}") pattern += ")";
    else if (char === "," && glob.lastIndexOf("{", i) > glob.lastIndexOf("}", i)) pattern += "|";
    else pattern += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`).test(path);
}


export function anyGlob(globs: readonly string[], path: string): boolean {
  return globs.some((glob) => globMatches(glob, path));
}
