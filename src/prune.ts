// The cleanup: closed notes of the types with `prune_after`, not modified for that
// many days, are removed. The last modification never comes before the note was
// closed, so the count can only start late, never early. A note with text of its
// own is left for a person to decide, unless named. Where a removed note is cited,
// a link in the body becomes its text followed by ✓, and a link in a property is
// taken out of it.

import { plural } from "./commands";
import type { Schema } from "./schema";
import { daysBetween } from "./text";
import { type Meta, type Note, splitFrontmatter, type Vault } from "./vault";

export const DONE_MARK = "✓";

export interface Citation {
  /** The note that links to the removed one. */
  source: string;
  /** Property of the link; null when it is in the body. */
  field: string | null;
  /** Line of the link in the file, 1-based. */
  line: number;
  /** The link as written. */
  original: string;
}

export interface Prunable {
  note: Note;
  /** Days since the last modification. */
  idle: number;
  /** Links to it from notes that stay. */
  citations: Citation[];
  /** Files only this note links to (attachments), left without links once it is gone. */
  orphans: string[];
}

export interface PrunePlan {
  remove: Prunable[];
  /** Past their days but with text of their own: removed only when named. */
  decide: Prunable[];
}

/** Days since a note was last modified. */
const idleDays = (note: Note, today: string): number => daysBetween(new Date(note.mtime).toISOString().slice(0, 10), today);

/** Whether the body says more than the template: a line that is not blank, a heading or a line of the type's body. */
export function hasOwnText(body: string, template: string): boolean {
  const own = new Set(template.split(/\r?\n/).map((line) => line.trim()));
  return body.split(/\r?\n/).some((line) => {
    const text = line.trim();
    return text !== "" && !/^#{1,6}\s/.test(text) && !own.has(text);
  });
}

/**
 * What the cleanup removes: every closed note past its type's days, or only the
 * named one, closed, whatever its age and text.
 */
export function prunePlan(vault: Vault, schema: Schema, today: string, named?: Note): PrunePlan {
  const found: { note: Note; idle: number; own: boolean }[] = [];
  for (const note of named ? [named] : vault.typedNotes()) {
    const spec = schema.types.get(note.type ?? "");
    const eligible = spec !== undefined && spec.pruneAfter !== null && schema.isClosed(spec, note.meta);
    if (!eligible) {
      if (named) throw new Error(`"${note.name}" is not a closed note of a type with prune_after`);
      continue;
    }
    const idle = idleDays(note, today);
    if (!named && idle <= spec.pruneAfter!) continue;
    found.push({ note, idle, own: !named && hasOwnText(note.body, spec.body) });
  }
  const removed = new Set(found.filter((item) => !item.own).map((item) => item.note.path));
  const describe = ({ note, idle }: { note: Note; idle: number }): Prunable => ({
    note,
    idle,
    citations: (vault.backlinks.get(note.path) ?? [])
      .filter((link) => !removed.has(link.source))
      .map(({ source, field, line, original }) => ({ source, field, line, original })),
    orphans: [
      ...new Set(
        note.links
          .map((link) => link.resolved)
          .filter((path): path is string => path !== null && path !== note.path && !vault.notes.has(path))
          .filter((path) => (vault.backlinks.get(path) ?? []).every((link) => removed.has(link.source) || link.source === note.path))
      ),
    ],
  });
  return { remove: found.filter((item) => !item.own).map(describe), decide: found.filter((item) => item.own).map(describe) };
}

/** The text a link shows: its alias, or the name of the note. */
export function linkText(original: string, name: string): string {
  const wiki = /^!?\[\[([^\]]*)\]\]$/.exec(original.trim());
  if (wiki) {
    const bar = wiki[1].indexOf("|");
    return (bar >= 0 && wiki[1].slice(bar + 1).trim()) || name;
  }
  return /^!?\[([^\]]*)\]\(/.exec(original.trim())?.[1].trim() || name;
}

/** A note's text with its links to a removed note made text, "Name ✓": on their line, or anywhere in the body when the line has moved. */
export function unlinkBody(text: string, citations: Citation[], name: string): string {
  const lines = text.split("\n");
  const first = splitFrontmatter(text).bodyLine - 1;
  for (const { original, line, field } of citations) {
    if (field !== null) continue;
    const replacement = `${linkText(original, name)} ${DONE_MARK}`;
    const swap = (i: number) => (lines[i] = lines[i].split(original).join(replacement));
    if (line - 1 >= first && lines[line - 1]?.includes(original)) swap(line - 1);
    else for (let i = first; i < lines.length; i++) if (lines[i].includes(original)) swap(i);
  }
  return lines.join("\n");
}

/** Takes a link out of a property: out of the list, or the value emptied; an empty list stays empty as in a template. */
export function unlinkProperty(meta: Meta, field: string, original: string): void {
  const value = meta[field];
  const same = (item: unknown) => typeof item === "string" && item.trim() === original.trim();
  const rest = Array.isArray(value) ? value.filter((item) => !same(item)) : same(value) ? [] : null;
  if (rest !== null) meta[field] = rest.length ? rest : null;
}

/** What the command prints. */
export function pruneReport(plan: PrunePlan, apply: boolean, named: boolean): string {
  const lines: string[] = [];
  const item = (mark: string, { note, idle, citations, orphans }: Prunable) => {
    lines.push(`${mark} ${note.path}  (${note.type}, not modified for ${plural(idle, "day")})`);
    for (const source of [...new Set(citations.map((c) => c.source))]) {
      const where = citations.filter((c) => c.source === source).map((c) => (c.field === null ? "body: link becomes text" : `${c.field}: link taken out`));
      lines.push(`    ${source}  ${[...new Set(where)].join("; ")}`);
    }
    for (const path of orphans) lines.push(`    ${path}  left without links`);
  };
  for (const prunable of plan.remove) item(apply ? "-" : "?", prunable);
  if (plan.decide.length) {
    lines.push("", "With text of their own, to decide: move what matters to another note, then name it with file=.");
    for (const prunable of plan.decide) item("!", prunable);
  }
  const summary = named ? "" : " closed and past their prune_after days";
  lines.push("", `${plural(plan.remove.length, "note")}${summary} ${apply ? "removed" : "to remove"}${plan.decide.length ? `, ${plan.decide.length} to decide` : ""}.`);
  if (!apply && plan.remove.length) lines.push("Preview: no file written. Run again with apply.");
  return lines.join("\n");
}

/** The briefing's line, when some type has prune_after. */
export function pruneLine(vault: Vault, schema: Schema, today: string): string | null {
  if (![...schema.types.values()].some((spec) => spec.pruneAfter !== null)) return null;
  const { remove, decide } = prunePlan(vault, schema, today);
  return `To prune: ${remove.length}${decide.length ? `, ${decide.length} with text of their own to decide` : ""} (\`obsidian-cli second-brain:prune\`).`;
}
