const entities: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Plain text from an HTML body, for reading only: scripts and styles are
 * dropped, block ends become line breaks, tags are removed and common
 * entities decoded. It makes no attempt at layout.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?(<\/\1\s*>|$)/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, name: string) => {
      if (name[0] === "#") {
        const code =
          name[1] === "x" || name[1] === "X"
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return entities[name.toLowerCase()] ?? match;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
