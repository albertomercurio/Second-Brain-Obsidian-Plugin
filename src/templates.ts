// ---------------------------------------------------------------------------
// What the schema generates: note templates (applied by Templater) and the
// property types Obsidian shows.
// ---------------------------------------------------------------------------

import { renderNote } from "./frontmatter";
import { baseKind, isList, type Schema } from "./schema";

/** Template name → text: one for each type, one for each kind with its own properties. */
export function templateFiles(schema: Schema): Map<string, string> {
  const files = new Map<string, string>();
  for (const spec of schema.types.values()) {
    const meta = { [schema.typeProperty]: spec.name };
    files.set(spec.name, renderNote(schema.conform(meta) ?? meta, spec.body));
    if (!schema.kindProperty) continue;
    for (const kind of Object.keys(spec.kindTemplates)) {
      const kindMeta = { ...meta, [schema.kindProperty]: kind };
      files.set(`${spec.name} - ${kind}`, renderNote(schema.conform(kindMeta) ?? kindMeta, spec.body));
    }
  }
  return files;
}

const OBSIDIAN_TYPES: Record<string, string> = { bool: "checkbox", date: "date", datetime: "datetime", int: "number", number: "number" };
// Obsidian's own properties: it records them in lower case, with their own type, and rewrites the file so.
const NATIVE = ["aliases", "tags", "cssclasses"];

/** The contents of .obsidian/types.json, keeping what is already there. */
export function propertyTypes(schema: Schema, current: { types?: Record<string, string> }): string {
  const types = current.types ?? {};
  for (const field of [...schema.allFields()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const native = field.name.toLowerCase();
    if (NATIVE.includes(native)) {
      delete types[field.name];
      types[native] = native;
    } else {
      types[field.name] = isList(field) ? "multitext" : OBSIDIAN_TYPES[baseKind(field)] ?? "text";
    }
  }
  return JSON.stringify({ ...current, types }, null, 2);
}
