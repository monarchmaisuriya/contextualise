// A rough size for M before attaching: about 4 characters per token. It can be well off for code
// or non-English text, so it is always shown with "~".
export function tokenEstimate(chars: number): string {
  const tokens = Math.max(0, Math.round(chars / 4));
  if (tokens < 1_000) return `~${tokens} tokens`;
  if (tokens < 10_000) return `~${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k tokens`;
  return `~${Math.round(tokens / 1_000)}k tokens`;
}
