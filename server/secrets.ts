// Attachments carry conversations and terminal output to a possibly different provider, so
// anything secret-shaped is replaced before it leaves the plugin. Started from Memorise's patterns
// (memorise/server/secrets.ts; plugins cannot import each other) and since widened here.
// Every repeat is bounded, so a long line with no secret is scanned in linear time.
const SECRET_NAME = "(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|account[_-]?key|auth)";
const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["private key", /-----BEGIN [A-Z ]{0,40}PRIVATE KEY[A-Z ]{0,20}-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY[A-Z ]{0,20}-----|$)/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["API key (sk-)", /\bsk-[A-Za-z0-9_-]{20,}/],
  // Service tokens recognised by their prefix: Stripe, npm, GitLab, Hugging Face, SendGrid, and
  // keys of the xkeysib- form.
  ["API token", /\b(?:[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{30,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|xkeysib-[A-Za-z0-9-]{40,})/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}|hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["password in a link", /(?<=:\/\/[^\s/:@]{1,200}:)[^\s/@]{1,200}(?=@)/],
  ["authorization header", /\b(?:Bearer|Basic)\s{1,5}[A-Za-z0-9._~+/=-]{16,}/],
  // A secret-looking name followed by a value: DB_PASSWORD=…, "password": "…", aws_secret_access_key = ….
  // The name may sit inside a longer name, so it is matched without a word boundary in front. A value
  // already replaced by an earlier pattern keeps that pattern's label.
  ["password or key assignment", new RegExp(`${SECRET_NAME}[A-Za-z0-9_.-]{0,40}["']?\\s{0,5}[:=]\\s{0,5}(?!\\[removed: )(?:"[^"\\n]{4,300}"|'[^'\\n]{4,300}'|[^\\s'",;]{6,300})`, "i")],
];

// Replaces every secret-shaped span with [removed: <pattern name>].
export function redactSecrets(text: string): string {
  let redacted = text;
  for (const [name, pattern] of SECRET_PATTERNS) redacted = redacted.replace(new RegExp(pattern.source, `${pattern.flags}g`), `[removed: ${name}]`);
  return redacted;
}
