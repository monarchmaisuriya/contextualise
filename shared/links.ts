const LINK_KEEP_CHARS = 40;

// A link as a short, readable piece of a title: no scheme or "www.", and when still long, the
// host and the last two path parts ("github.com/…/pull/12").
export function shortenLink(url: string): string {
  const match = /^https?:\/\/(?:www\.)?([^/?#\s]+)([^?#\s]*)/i.exec(url);
  if (!match) return url;
  const [, host, path] = match;
  const parts = path.split("/").filter(Boolean);
  const plain = [host, ...parts].join("/");
  return plain.length <= LINK_KEEP_CHARS || parts.length <= 2 ? plain : `${host}/…/${parts.slice(-2).join("/")}`;
}
