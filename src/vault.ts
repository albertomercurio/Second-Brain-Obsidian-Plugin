// ---------------------------------------------------------------------------
// The vault in memory: notes, properties and links, from an index the host has
// already resolved. In Obsidian the index is its metadata cache; in the tests,
// fixtures. Nothing is stored: every run builds the vault again.
//
// The text of notes is still read where the index says nothing: frontmatter
// that is not valid YAML, links written without quotes, suspicious text.
// ---------------------------------------------------------------------------

import { compare, linkKey, nfc } from "./text";

export type ParseYaml = (text: string) => unknown;
export type Meta = Record<string, unknown>;

/** A link as the host resolved it. */
export interface IndexedLink {
  /** Destination as written, without `#heading` and `|text`. */
  target: string;
  /** Path of the file it points to, or null when there is none. */
  resolved: string | null;
  /** Frontmatter key of a link in a property, e.g. "Collaborators.0"; absent in the body. */
  key?: string;
  /** The link as written, e.g. "[[Note|text]]". */
  original: string;
  /** Line of a link in the body, 1-based. */
  line?: number;
}

/** A file of the vault as the host indexes it. */
export interface IndexedFile {
  path: string;
  size: number;
  /** Last modification, in milliseconds. */
  mtime: number;
  /** Text of notes and Bases views. */
  text?: string;
  /** Notes: the properties, as the host parsed them. */
  frontmatter?: Meta | null;
  /** Notes: the aliases. */
  aliases?: string[];
  /** Notes: the links, in properties and in the body. */
  links?: IndexedLink[];
}

export interface VaultIndex {
  files: IndexedFile[];
  /** Resolves a link from a file as the host does: the path it points to, or null. */
  resolve(target: string, source: string): string | null;
}

export interface VaultOptions {
  /** Property that holds the type of a note. */
  typeProperty: string;
  parseYaml: ParseYaml;
  /** Files left out of notes, links and checks; links to them still resolve. */
  ignored?: (path: string) => boolean;
}

export interface VaultFile {
  path: string;
  size: number;
  mtime: number;
  text?: string;
}

export interface Link {
  source: string;
  target: string;
  /** Frontmatter property; null when the link is in the body. */
  field: string | null;
  line: number;
  resolved: string | null;
  /** Files with the same name, when there is more than one. */
  candidates: string[];
  /** The link as written, e.g. "[[Note|text]]". */
  original: string;
}

/** A wikilink written without quotes in the YAML: a list inside a list, not a link. */
export interface UnquotedLink {
  target: string;
  field: string;
  line: number;
}

export class Note {
  links: Link[] = [];
  unquotedLinks: UnquotedLink[] = [];

  constructor(
    readonly path: string,
    readonly type: string | null,
    readonly meta: Meta,
    readonly aliases: string[],
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
}

/** Files whose text the core reads. */
export const hasText = (path: string): boolean => /\.(md|base)$/i.test(path);

export function splitFrontmatter(text: string): { raw: string | null; body: string; bodyLine: number } {
  const lines = text.split(/(?<=\n)/);
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end > 0) return { raw: lines.slice(1, end).join(""), body: lines.slice(end + 1).join(""), bodyLine: end + 2 };
  }
  return { raw: null, body: text, bodyLine: 1 };
}

/** Why a frontmatter cannot be read as properties, or null. */
export function frontmatterError(raw: string | null, parseYaml: ParseYaml): string | null {
  if (!raw?.trim()) return null;
  try {
    const loaded = parseYaml(raw);
    if (loaded === null || loaded === undefined || (typeof loaded === "object" && !Array.isArray(loaded))) return null;
    return "the frontmatter is not a map of key: value";
  } catch (err) {
    return `invalid YAML: ${err instanceof Error ? err.message : err}`.replace(/\n/g, " ");
  }
}

/** "[[X]]" without quotes reads as a list inside a list in YAML. */
function* unquoted(value: unknown): Generator<string> {
  if (Array.isArray(value) && value.length === 1 && Array.isArray(value[0]) && value[0].length === 1 && ["string", "number"].includes(typeof value[0][0])) {
    yield String(value[0][0]);
  } else if (Array.isArray(value)) {
    for (const item of value) yield* unquoted(item);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) yield* unquoted(item);
  }
}

/** First line of the frontmatter (1-based in the file) that passes a test, or 1. */
function frontmatterLine(raw: string | null, test: (line: string) => boolean): number {
  const index = (raw ?? "").split(/\r?\n/).findIndex(test);
  return index < 0 ? 1 : index + 2;
}

/** The property of a frontmatter key: "Collaborators.0" → "Collaborators", minding names with dots. */
function propertyOf(key: string, meta: Meta): string {
  const names = Object.keys(meta).filter((name) => key === name || key.startsWith(`${name}.`));
  return names.sort((a, b) => b.length - a.length)[0] ?? key.split(".")[0];
}

const baseName = (path: string) => linkKey(path.slice(path.lastIndexOf("/") + 1));

export class Vault {
  readonly files: VaultFile[];
  readonly notes = new Map<string, Note>();
  readonly backlinks = new Map<string, Link[]>();
  private folders = new Set<string>();
  private byName = new Map<string, string[]>();
  private resolver: VaultIndex["resolve"];

  constructor(index: VaultIndex, options: VaultOptions) {
    const ignored = options.ignored ?? (() => false);
    const all = index.files.map((file) => ({ ...file, path: nfc(file.path) })).sort((a, b) => compare(a.path, b.path));
    this.resolver = index.resolve;
    for (const { path } of all) {
      for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) this.folders.add(path.slice(0, i));
      const names = path.toLowerCase().endsWith(".md") ? [baseName(path), baseName(path).slice(0, -3)] : [baseName(path)];
      for (const name of names) this.byName.set(name, [...(this.byName.get(name) ?? []), path]);
    }
    const kept = all.filter((file) => !ignored(file.path));
    this.files = kept.map(({ path, size, mtime, text }) => ({ path, size, mtime, text }));
    for (const file of kept) {
      if (file.path.toLowerCase().endsWith(".md")) this.notes.set(file.path, this.readNote(file, options));
    }
    for (const note of this.notes.values()) {
      for (const link of note.links) {
        if (link.resolved && link.resolved !== note.path) this.backlinks.set(link.resolved, [...(this.backlinks.get(link.resolved) ?? []), link]);
      }
    }
  }

  private readNote(file: IndexedFile, options: VaultOptions): Note {
    const { raw, body, bodyLine } = splitFrontmatter(file.text ?? "");
    const error = frontmatterError(raw, options.parseYaml);
    const meta: Meta = error ? {} : file.frontmatter ?? {};
    const value = meta[options.typeProperty];
    const type = typeof value === "string" && value ? value : null;
    const note = new Note(file.path, type, meta, file.aliases ?? [], body, bodyLine, raw, error, file.mtime);
    note.links = (file.links ?? []).map((link) => ({
      source: file.path,
      target: link.target,
      field: link.key === undefined ? null : propertyOf(link.key, meta),
      line: link.line ?? (link.key === undefined ? 1 : frontmatterLine(raw, (line) => line.includes(link.original))),
      resolved: link.resolved === null ? null : nfc(link.resolved),
      candidates: link.resolved === null ? [] : this.sameName(link.target),
      original: link.original,
    }));
    for (const [field, value] of Object.entries(meta)) {
      for (const target of unquoted(value)) {
        const bare = new RegExp(`(?:^|[^"'])\\[\\[${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\]`);
        note.unquotedLinks.push({ target, field, line: frontmatterLine(raw, (line) => bare.test(line)) });
      }
    }
    return note;
  }

  /** Files sharing the name a link uses, nearest the root first, when more than one. */
  private sameName(target: string): string[] {
    if (!target || target.includes("/")) return [];
    const matches = [...(this.byName.get(linkKey(target)) ?? [])];
    const depth = (path: string) => path.split("/").length;
    return matches.length > 1 ? matches.sort((a, b) => depth(a) - depth(b) || compare(a, b)) : [];
  }

  /** The file a link points to, as the host resolves it. */
  resolve(target: string, source: string): string | null {
    return this.resolver(target, source);
  }

  /** Whether a folder holds any file, ignored ones included. */
  hasFolder(folder: string): boolean {
    return this.folders.has(folder);
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
    if (!hits.length) throw new Error(`No note found for "${query}".`);
    if (hits.length > 1) throw new Error(`"${query}" is ambiguous: ${hits.map((note) => note.path).join(", ")}`);
    return hits[0];
  }

  /** Resolved links to other notes, leaving out embedded Bases views and attachments. */
  relationLinks(note: Note): Link[] {
    return note.links.filter((link) => link.resolved && link.resolved !== note.path && this.notes.has(link.resolved));
  }
}
