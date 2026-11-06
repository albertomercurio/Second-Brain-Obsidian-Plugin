// ---------------------------------------------------------------------------
// The vault in memory: notes, frontmatter and links, read from a list of files.
//
// Each host (Obsidian, Node) only has to list the files and give their text:
// everything else is the same code everywhere. Nothing is stored: every run
// reads the notes again. Links resolve as in Obsidian: by file name, ignoring
// case, with partial paths, `#heading` and `|text` left out of the destination.
// ---------------------------------------------------------------------------

import { compare, linkKey, nfc } from "./text";

export interface VaultFile {
  path: string;
  size: number;
  /** Last modification, in milliseconds. */
  mtime: number;
  /** Content of notes and Bases views. */
  text?: string;
}

export type ParseYaml = (text: string) => unknown;
export type Meta = Record<string, unknown>;

export interface Link {
  source: string;
  /** Destination without `#…` and `|…`. */
  target: string;
  kind: "wikilink" | "embed" | "markdown";
  /** Frontmatter property; null when the link is in the body. */
  field: string | null;
  line: number;
  resolved: string | null;
  /** Other matches when the name is ambiguous. */
  candidates: string[];
  /** Wikilink without quotes in the YAML. */
  malformed: boolean;
}

// Generated files, code and templates are not objects of the archive.
const SKIPPED_FOLDERS = ["system/generated/", "system/tests/", "system/templates/", "system/hooks/"];
const HIDDEN = new Set(["node_modules"]);

export function isVaultFile(path: string): boolean {
  const parts = path.split("/");
  return !parts.some((part) => part.startsWith(".") || HIDDEN.has(part)) && !SKIPPED_FOLDERS.some((folder) => path.startsWith(folder));
}

/** Files whose text the core reads. */
export const hasText = (path: string): boolean => /\.(md|base)$/i.test(path);

const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const MARKDOWN_LINK = /(!?)\[([^\]\n]*)\]\((<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\)/g;
const INLINE_CODE = /(`+)(?:(?!\1).)+?\1/g;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export class Note {
  links: Link[] = [];

  constructor(
    readonly path: string,
    readonly meta: Meta,
    readonly body: string,
    /** Line where the body starts (1-based). */
    readonly bodyLine: number,
    readonly rawFrontmatter: string | null,
    readonly frontmatterError: string | null,
    readonly mtime: number
  ) {}

  get name(): string {
    return this.path.slice(this.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  }

  get type(): string | null {
    const value = this.meta.Type;
    return typeof value === "string" && value ? value : null;
  }

  /** Obsidian recognises the property in any case. */
  get aliases(): string[] {
    const value = this.meta.Aliases ?? this.meta.aliases;
    if (typeof value === "string") return [value];
    return Array.isArray(value) ? value.filter((v) => v !== null && v !== "").map(String) : [];
  }
}

function splitFrontmatter(text: string): { raw: string | null; body: string; bodyLine: number } {
  const lines = text.split(/(?<=\n)/);
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end > 0) return { raw: lines.slice(1, end).join(""), body: lines.slice(end + 1).join(""), bodyLine: end + 2 };
  }
  return { raw: null, body: text, bodyLine: 1 };
}

function parseNote(file: VaultFile, parseYaml: ParseYaml): Note {
  const { raw, body, bodyLine } = splitFrontmatter(file.text ?? "");
  let meta: Meta = {};
  let error: string | null = null;
  if (raw?.trim()) {
    try {
      const loaded = parseYaml(raw);
      if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) meta = loaded as Meta;
      else if (loaded !== null && loaded !== undefined) error = "il frontmatter non è una mappa chiave: valore";
    } catch (err) {
      error = `YAML non valido: ${err instanceof Error ? err.message : err}`.replace(/\n/g, " ");
    }
  }
  return new Note(file.path, meta, body, bodyLine, raw, error, file.mtime);
}

/** "[[X]]" without quotes reads as a list inside a list in YAML: rebuilds the link. */
function unquotedLink(value: unknown): string | null {
  if (Array.isArray(value) && value.length === 1 && Array.isArray(value[0]) && value[0].length === 1) {
    const inner = value[0][0];
    if (["string", "number"].includes(typeof inner)) return `[[${inner}]]`;
  }
  return null;
}

/** Strings inside a frontmatter value, with whether they are unquoted links. */
function* metaStrings(value: unknown): Generator<[string, boolean]> {
  const broken = unquotedLink(value);
  if (broken) yield [broken, true];
  else if (typeof value === "string") yield [value, false];
  else if (Array.isArray(value)) for (const item of value) yield* metaStrings(item);
  else if (value && typeof value === "object") for (const item of Object.values(value)) yield* metaStrings(item);
}

function linkTarget(inner: string): string {
  return inner.replace(/\\\|/g, "|").split("|")[0].split("#")[0].trim();
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function extractLinks(note: Note): Link[] {
  const links: Link[] = [];
  const add = (target: string, kind: Link["kind"], field: string | null, line: number, malformed = false) =>
    links.push({ source: note.path, target, kind, field, line, resolved: null, candidates: [], malformed });

  const metaLine = (needle: string): number => {
    const index = (note.rawFrontmatter ?? "").split(/\r?\n/).findIndex((line) => line.includes(needle));
    return index < 0 ? 1 : index + 2;
  };
  for (const [key, value] of Object.entries(note.meta)) {
    for (const [text, malformed] of metaStrings(value)) {
      for (const m of text.matchAll(WIKILINK)) {
        const target = linkTarget(m[2]);
        add(target, m[1] ? "embed" : "wikilink", key, metaLine(target), malformed);
      }
    }
  }

  let fence: string | null = null;
  note.body.split(/\r?\n/).forEach((line, offset) => {
    const marker = line.trimStart().slice(0, 3);
    if (marker === "```" || marker === "~~~") {
      fence = fence === null ? marker : fence === marker ? null : fence;
      return;
    }
    if (fence) return;
    const clean = line.replace(INLINE_CODE, (code) => " ".repeat(code.length));
    const lineNumber = note.bodyLine + offset;
    for (const m of clean.matchAll(WIKILINK)) add(linkTarget(m[2]), m[1] ? "embed" : "wikilink", null, lineNumber);
    for (const m of clean.matchAll(MARKDOWN_LINK)) {
      const destination = m[3].replace(/^<|>$/g, "");
      if (URL_SCHEME.test(destination) || destination.startsWith("#")) continue;
      add(safeDecode(destination).split("#")[0], "markdown", null, lineNumber);
    }
  });
  return links;
}

/** Normalises "a/b/../c" without Node's path module, which mobile does not have. */
function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

export class Resolver {
  private byPath = new Map<string, string>();
  private byName = new Map<string, string[]>();

  constructor(paths: string[]) {
    for (const path of [...paths].sort(compare)) {
      this.byPath.set(linkKey(path), path);
      const base = path.slice(path.lastIndexOf("/") + 1);
      const names = base.toLowerCase().endsWith(".md") ? [base, base.slice(0, -3)] : [base];
      for (const name of names) {
        const key = linkKey(name);
        this.byName.set(key, [...(this.byName.get(key) ?? []), path]);
      }
    }
  }

  /** The file a link points to, and the alternatives when the name is ambiguous. */
  resolve(target: string, source: string): { path: string | null; candidates: string[] } {
    const clean = nfc(target).trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!clean) return { path: source, candidates: [] };
    const exact = (key: string) => this.byPath.get(key) ?? this.byPath.get(`${key}.md`);
    const key = linkKey(clean);
    const direct = exact(key);
    if (direct) return { path: direct, candidates: [] };
    const folder = source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : "";
    const relative = exact(linkKey(normalizePath(`${folder}/${clean}`)));
    if (relative) return { path: relative, candidates: [] };
    const matches = clean.includes("/")
      ? [...this.byPath].filter(([k]) => k.endsWith(`/${key}`) || k.endsWith(`/${key}.md`)).map(([, path]) => path)
      : [...(this.byName.get(key) ?? [])];
    if (!matches.length) return { path: null, candidates: [] };
    const depth = (path: string) => path.split("/").length;
    matches.sort((a, b) => depth(a) - depth(b) || compare(a, b));
    return { path: matches[0], candidates: matches.length > 1 ? matches : [] };
  }
}

export class Vault {
  readonly files: VaultFile[];
  readonly notes = new Map<string, Note>();
  readonly backlinks = new Map<string, Link[]>();
  readonly resolver: Resolver;

  constructor(files: VaultFile[], parseYaml: ParseYaml) {
    this.files = files.map((file) => ({ ...file, path: nfc(file.path) })).sort((a, b) => compare(a.path, b.path));
    for (const file of this.files) {
      if (file.path.toLowerCase().endsWith(".md")) this.notes.set(file.path, parseNote(file, parseYaml));
    }
    this.resolver = new Resolver(this.files.map((file) => file.path));
    for (const note of this.notes.values()) {
      note.links = extractLinks(note);
      for (const link of note.links) {
        const { path, candidates } = this.resolver.resolve(link.target, note.path);
        link.resolved = path;
        link.candidates = candidates;
        if (path && path !== note.path) this.backlinks.set(path, [...(this.backlinks.get(path) ?? []), link]);
      }
    }
  }

  typedNotes(type?: string): Note[] {
    return [...this.notes.values()].filter((note) => note.type && (type === undefined || note.type === type));
  }

  /** Notes by path, name or alias, ignoring case. */
  find(query: string): Note[] {
    const key = linkKey(query.trim());
    const all = [...this.notes.values()];
    const exact = all.filter((note) => [key, `${key}.md`].includes(linkKey(note.path)));
    if (exact.length) return exact;
    return all.filter((note) => linkKey(note.name) === key || note.aliases.some((alias) => linkKey(alias) === key));
  }

  get(query: string): Note {
    const hits = this.find(query);
    if (!hits.length) throw new Error(`Nessuna nota trovata per «${query}».`);
    if (hits.length > 1) throw new Error(`«${query}» è ambiguo: ${hits.map((note) => note.path).join(", ")}`);
    return hits[0];
  }

  /** Resolved links to other notes, leaving out embedded Bases views. */
  relationLinks(note: Note): Link[] {
    return note.links.filter((link) => link.resolved && link.resolved !== note.path && this.notes.has(link.resolved));
  }
}
