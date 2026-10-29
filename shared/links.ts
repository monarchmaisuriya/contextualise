const LINK_KEEP_CHARS = 40;

// A page id at the end of a slug ("Backend-review-0123456789abcdef…", as Notion writes them).
const TRAILING_ID = /-[0-9a-f]{16,}$/i;

// A link as a short, readable piece of a title: no scheme, "www.", or "app.", no page id after a
// slug's words, and when still long, the host and the last two path parts ("github.com/…/pull/12").
export function shortenLink(url: string): string {
  const match = /^https?:\/\/(?:www\.|app\.)?([^/?#\s]+)([^?#\s]*)/i.exec(url);
  if (!match) return url;
  const [, host, path] = match;
  const parts = path.split("/").filter(Boolean).map((part) => part.replace(TRAILING_ID, ""));
  const plain = [host, ...parts].join("/");
  return plain.length <= LINK_KEEP_CHARS || parts.length <= 2 ? plain : `${host}/…/${parts.slice(-2).join("/")}`;
}
