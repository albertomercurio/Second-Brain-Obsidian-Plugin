// ---------------------------------------------------------------------------
// The schema of the vault (system/schemas/schema.yaml): types, their properties
// and how to check a value. The host parses the YAML; this module interprets it.
// To add a type or a property, edit the YAML: no code changes are needed.
// ---------------------------------------------------------------------------

import { asDate } from "./text";
import type { Meta } from "./vault";

export interface Field {
  name: string;
  /** "string", "date", "enum", "link", "list[link]", … */
  kind: string;
  values: unknown[];
  /** For links: the types they may point to. */
  target: string[];
  /** Project kinds the field is reserved to. */
  kinds: string[];
}

export interface TypeSpec {
  name: string;
  folder: string;
  required: string[];
  template: string[];
  kindTemplates: Record<string, string[]>;
  fields: Map<string, Field>;
  body: string;
}

export const isList = (field: Field): boolean => field.kind.startsWith("list[");
export const baseKind = (field: Field): string => (isList(field) ? field.kind.slice(5, -1) : field.kind);

function readFields(raw: Record<string, any> = {}): Map<string, Field> {
  return new Map(
    Object.entries(raw).map(([name, spec]) => {
      const s = typeof spec === "string" ? { kind: spec } : spec ?? {};
      return [name, { name, kind: s.kind ?? "string", values: s.values ?? [], target: s.target ?? [], kinds: s.kinds ?? [] }];
    })
  );
}

export class Schema {
  readonly types = new Map<string, TypeSpec>();
  readonly contentFolders: string[];
  readonly freeFolders: string[];
  private commonFields: Map<string, Field>;
  private commonRequired: string[];

  constructor(data: any) {
    this.contentFolders = data.content_folders ?? [];
    this.freeFolders = data.free_folders ?? [];
    this.commonFields = readFields(data.common?.fields);
    this.commonRequired = data.common?.required ?? [];
    for (const [name, raw] of Object.entries<any>(data.types ?? {})) {
      this.types.set(name, {
        name,
        folder: raw.folder,
        required: raw.required ?? [],
        template: raw.template ?? [],
        kindTemplates: raw.kind_templates ?? {},
        fields: readFields(raw.fields),
        body: raw.body ?? "",
      });
    }
  }

  fieldsFor(type: string): Map<string, Field> {
    return new Map([...this.commonFields, ...(this.types.get(type)?.fields ?? [])]);
  }

  /** Every property of the schema, once. */
  allFields(): Field[] {
    const all = new Map(this.commonFields);
    for (const spec of this.types.values()) for (const [name, field] of spec.fields) all.set(name, field);
    return [...all.values()];
  }

  /** Folders the schema assigns to notes. */
  folders(): string[] {
    return [...this.contentFolders, ...this.freeFolders, ...[...this.types.values()].map((spec) => spec.folder)];
  }

  requiredFor(type: string): string[] {
    return [...new Set([...this.commonRequired, ...(this.types.get(type)?.required ?? [])])];
  }

  inContentFolder(path: string): boolean {
    return this.contentFolders.some((folder) => path.startsWith(`${folder}/`));
  }

  inFreeFolder(path: string): boolean {
    return this.freeFolders.some((folder) => path.startsWith(`${folder}/`));
  }

  /**
   * The frontmatter a note should have: `Type`, then the template of its type
   * and kind in order (missing ones empty), then any other property as it was.
   * Returns null when nothing changes, order included.
   */
  conform(meta: Meta): Meta | null {
    const spec = typeof meta.Type === "string" ? this.types.get(meta.Type) : undefined;
    if (!spec) return null;
    const template = (typeof meta.Kind === "string" && spec.kindTemplates[meta.Kind]) || spec.template;
    const next: Meta = {};
    for (const key of ["Type", ...template]) next[key] = key in meta ? meta[key] : spec.fields.get(key)?.kind === "bool" ? false : null;
    for (const [key, value] of Object.entries(meta)) if (!(key in next)) next[key] = value;
    return Object.keys(next).join("\n") === Object.keys(meta).join("\n") ? null : next;
  }
}

export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

const ORCID = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
const DOI = /^10\.\d{4,9}\/\S+$/;
const LINK_ONLY = /^\s*\[\[[^[\]\n]+\]\]\s*$/;

function checkScalar(field: Field, value: unknown): string[] {
  const fail = (message: string, ok: boolean) => (ok ? [] : [message]);
  const text = typeof value === "string" ? value : "";
  switch (baseKind(field)) {
    case "string":
    case "text":
      return fail(`atteso testo, trovato ${typeof value}`, typeof value === "string");
    case "int":
      return fail("atteso un numero intero", Number.isInteger(value));
    case "number":
      return fail("atteso un numero", typeof value === "number");
    case "bool":
      return fail("atteso true o false (checkbox)", typeof value === "boolean");
    case "date":
      return fail("attesa una data YYYY-MM-DD", asDate(value) !== null);
    case "url":
      return fail("atteso un URL http(s)", /^https?:\/\//.test(text));
    case "doi":
      return fail("DOI non valido (atteso 10.xxxx/...)", DOI.test(text));
    case "orcid":
      return fail("ORCID non valido (atteso 0000-0000-0000-0000)", ORCID.test(text));
    case "enum":
      return fail(`valore «${value}» non ammesso: ${field.values.join(", ")}`, field.values.includes(value));
    case "link":
      return fail('atteso un wikilink tra virgolette, per esempio "[[Nota]]"', LINK_ONLY.test(text));
    default:
      return [];
  }
}

/** Problems of a value against its field; empty when valid. */
export function checkValue(field: Field, value: unknown): string[] {
  if (isEmpty(value)) return [];
  if (!isList(field)) return checkScalar(field, value);
  if (!Array.isArray(value)) return [`dovrebbe essere una lista (${field.kind})`];
  const problems = value.some(isEmpty) ? ["contiene elementi vuoti"] : [];
  for (const item of value) if (!isEmpty(item)) problems.push(...checkScalar(field, item));
  return [...new Set(problems)].sort();
}
