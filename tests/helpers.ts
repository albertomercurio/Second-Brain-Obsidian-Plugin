// Vaults for the tests, from { path: text }. The index stands in for Obsidian's
// metadata cache: frontmatter parsed, links found and resolved as Obsidian does
// for the cases the tests use (by path, relative path or name, ignoring case).
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { Schema } from "../src/schema";
import { DEFAULT_SETTINGS, isIgnored, type Settings } from "../src/settings";
import { compare, linkKey, nfc } from "../src/text";
import { hasText, type IndexedFile, type IndexedLink, type Meta, splitFrontmatter, Vault, type VaultIndex } from "../src/vault";

/** Settings of the vault the fixtures copy. */
export const settings: Settings = {
  ...DEFAULT_SETTINGS,
  schemaFile: "system/schemas/schema.yaml",
  typeProperty: "Type",
  ignoredFolders: ["system/generated", "system/tests", "system/hooks"],
  templatesFolder: "system/templates",
  briefingFile: "system/generated/briefing.md",
  logFile: "system/log.md",
  recallFile: "system/tests/recall.yaml",
};

export const schema = new Schema(parse(readFileSync("tests/fixtures/schema.yaml", "utf8")), settings.typeProperty);

export const note = (meta: string, body = ""): string => `---\n${meta}\n---\n${body}`;

const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const MARKDOWN_LINK = /(!?)\[([^\]\n]*)\]\((<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\)/g;
const INLINE_CODE = /(`+)(?:(?!\1).)+?\1/g;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WHOLE_LINK = /^\[\[([^[\]\n]+)\]\]$/;

const linkpath = (inner: string) => inner.replace(/\\\|/g, "|").split("|")[0].split("#")[0].trim();

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/** Resolves links as Obsidian does: exact path, relative path, then by name, the shallowest first. */
export function resolver(paths: string[]): VaultIndex["resolve"] {
  const byPath = new Map(paths.map((path) => [linkKey(path), path]));
  const exact = (key: string) => byPath.get(key) ?? byPath.get(`${key}.md`) ?? null;
  return (target, source) => {
    const clean = nfc(target).trim().replace(/^\/+/, "");
    if (!clean) return source;
    const key = linkKey(clean);
    const folder = source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : "";
    const direct = exact(key) ?? exact(linkKey(normalizePath(`${folder}/${clean}`)));
    if (direct) return direct;
    const matches = [...byPath]
      .filter(([path]) => path === key || path === `${key}.md` || path.endsWith(`/${key}`) || path.endsWith(`/${key}.md`))
      .map(([, path]) => path)
      .sort((a, b) => a.split("/").length - b.split("/").length || compare(a, b));
    return matches[0] ?? null;
  };
}

/** Links in property values written as a whole wikilink, with their key. */
function* frontmatterLinks(value: unknown, key: string): Generator<{ key: string; inner: string; original: string }> {
  if (typeof value === "string") {
    const m = value.trim().match(WHOLE_LINK);
    if (m) yield { key, inner: m[1], original: value.trim() };
  } else if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) yield* frontmatterLinks(item, `${key}.${i}`);
  } else if (value && typeof value === "object") {
    for (const [name, item] of Object.entries(value)) yield* frontmatterLinks(item, `${key}.${name}`);
  }
}

function bodyLinks(body: string, bodyLine: number): { inner: string; original: string; line: number; markdown: boolean }[] {
  const links: { inner: string; original: string; line: number; markdown: boolean }[] = [];
  let fence: string | null = null;
  body.split(/\r?\n/).forEach((line, offset) => {
    const marker = line.trimStart().slice(0, 3);
    if (marker === "```" || marker === "~~~") {
      fence = fence === null ? marker : fence === marker ? null : fence;
      return;
    }
    if (fence) return;
    const clean = line.replace(INLINE_CODE, (code) => " ".repeat(code.length));
    for (const m of clean.matchAll(WIKILINK)) links.push({ inner: m[2], original: m[0], line: bodyLine + offset, markdown: false });
    for (const m of clean.matchAll(MARKDOWN_LINK)) {
      const destination = m[3].replace(/^<|>$/g, "");
      if (URL_SCHEME.test(destination) || destination.startsWith("#")) continue;
      links.push({ inner: decodeURIComponent(destination), original: m[0], line: bodyLine + offset, markdown: true });
    }
  });
  return links;
}

/** The index Obsidian would give for these files. */
export function indexOf(files: Record<string, string>, mtime = Date.parse("2026-10-20")): VaultIndex {
  const resolve = resolver(Object.keys(files));
  const indexed = Object.entries(files).map(([path, text]): IndexedFile => {
    const file: IndexedFile = { path, size: text.length, mtime, text: hasText(path) ? text : undefined };
    if (!path.endsWith(".md")) return file;
    const { raw, body, bodyLine } = splitFrontmatter(text);
    let meta: Meta | null = null;
    try {
      const loaded = raw ? parse(raw) : null;
      if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) meta = loaded as Meta;
    } catch {
      meta = null;
    }
    const link = (inner: string, original: string): IndexedLink => {
      const target = linkpath(inner);
      return { target, resolved: resolve(target, path), original };
    };
    file.frontmatter = meta;
    const aliases = meta?.aliases ?? meta?.Aliases;
    file.aliases = typeof aliases === "string" ? [aliases] : Array.isArray(aliases) ? aliases.map(String) : [];
    file.links = [
      ...Object.entries(meta ?? {}).flatMap(([key, value]) => [...frontmatterLinks(value, key)].map((l) => ({ ...link(l.inner, l.original), key: l.key }))),
      ...bodyLinks(body, bodyLine).map((l) => ({ ...link(l.inner, l.original), line: l.line })),
    ];
    return file;
  });
  return { files: indexed, resolve };
}

/** A vault from { path: text }, read with the settings above. */
export function vaultOf(files: Record<string, string>, mtime?: number): Vault {
  return new Vault(indexOf(files, mtime), { typeProperty: settings.typeProperty, parseYaml: parse, ignored: (path) => isIgnored(path, settings) });
}
