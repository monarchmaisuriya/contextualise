// Attachments carry conversations and terminal output to a possibly different provider, so
// anything secret-shaped is replaced before it leaves the plugin. Same patterns as Memorise
// (memorise/server/secrets.ts); plugins cannot import each other.
const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["API key (sk-)", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["password or key assignment", /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*['"]?[^\s'"]{6,}/i],
];

// Replaces every secret-shaped span with [removed: <pattern name>].
export function redactSecrets(text: string): string {
  let redacted = text;
  for (const [name, pattern] of SECRET_PATTERNS) redacted = redacted.replace(new RegExp(pattern.source, `${pattern.flags}g`), `[removed: ${name}]`);
  return redacted;
}
