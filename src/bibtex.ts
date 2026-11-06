// Reads BibTeX entries, minding nested braces. Only reads: entries are written
// by the bibliography plugin.

const HEAD = /@\s*(\w+)\s*[{(]\s*([^,\s]*)\s*,/;

/** The citation key of an entry, or null. */
export function citekey(entry: string | null): string | null {
  return entry?.match(/@\s*\w+\s*\{\s*([^,\s]+)\s*,/)?.[1] ?? null;
}

/** Fields of an entry, keys in lowercase, without outer braces or quotes. */
export function bibtexFields(entry: string): Record<string, string> {
  const head = entry.match(HEAD);
  if (!head) return {};
  const body = entry.slice((head.index ?? 0) + head[0].length);
  const fields: Record<string, string> = {};
  let i = 0;
  const skip = (chars: string) => {
    while (i < body.length && chars.includes(body[i])) i++;
  };
  while (i < body.length) {
    skip(" \t\r\n,");
    if (i >= body.length || "})".includes(body[i])) break;
    const equals = body.indexOf("=", i);
    if (equals < 0) break;
    const name = body.slice(i, equals).trim().toLowerCase();
    i = equals + 1;
    skip(" \t\r\n");
    const start = i;
    if (body[i] === "{") {
      for (let depth = 0; i < body.length; i++) {
        if (body[i] === "{") depth++;
        else if (body[i] === "}" && --depth === 0) break;
      }
      i++;
    } else if (body[i] === '"') {
      i = body.indexOf('"', i + 1) + 1 || body.length;
    } else {
      while (i < body.length && !",}\n".includes(body[i])) i++;
    }
    if (name) fields[name] = body.slice(start, i).trim().replace(/^[{"]+|[}"]+$/g, "");
  }
  return fields;
}
