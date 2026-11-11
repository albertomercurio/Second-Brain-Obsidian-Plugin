// ---------------------------------------------------------------------------
// The schema of the vault: types of notes, their properties, how to check a
// value, and the rules the checks and the briefing follow. The host parses the
// YAML; this module interprets it. The format is described in the README.
// ---------------------------------------------------------------------------

import { asDate } from "./text";
import type { Meta } from "./vault";

export interface Field {
  name: string;
  /** "string", "date", "datetime", "enum", "link", "list[link]", … */
  kind: string;
  values: unknown[];
  /** For links: the types they may point to. */
  target: string[];
  /** Kinds (values of the kind property) the field is reserved to. */
  kinds: string[];
  /** true: an identifier, two notes of the type never share it; "similar": a name, a shared one is suspicious. */
  unique: boolean | "similar";
  /** For dates: the property this one cannot precede. */
  after: string | null;
  /** For dates: passed while the note is open, it is overdue. */
  deadline: boolean;
  /** For dates: label in the briefing's agenda; null when not shown. */
  agenda: string | null;
}

/** Property → values: a note matches when any of the properties has one of its values. */
export type Condition = Map<string, unknown[]>;

export interface TypeSpec {
  name: string;
  folder: string;
  required: string[];
  template: string[];
  kindTemplates: Record<string, string[]>;
  fields: Map<string, Field>;
  body: string;
  /** Notes in progress; without it, every note that is not closed. */
  open: Condition | null;
  /** Notes that are done: out of the agenda, never overdue. */
  closed: Condition | null;
  /** Days after which an open note nobody modified is reported. */
  staleAfter: number | null;
  /** Days after which a closed note nobody modified is removed by the cleanup. */
  pruneAfter: number | null;
  /** A note nobody links to is reported. */
  expectBacklinks: boolean;
  /** Properties with the given and family name: similar names are possible duplicates. */
  personName: [string, string] | null;
  /** Properties shown for each open note in the briefing; empty: the type is not listed. */
  briefing: string[];
  /** Role → property, for the calendar commands: start, end, location, participants, email, link, kind. */
  calendar: Record<string, string> | null;
  /** Property whose day ends the note's name, in parentheses: "Title (YYYY-MM-DD)". */
  nameDate: string | null;
}

export const isList = (field: Field): boolean => field.kind.startsWith("list[");
export const baseKind = (field: Field): string => (isList(field) ? field.kind.slice(5, -1) : field.kind);

const OBSIDIAN_TYPES: Record<string, string> = { bool: "checkbox", date: "date", datetime: "datetime", int: "number", number: "number" };

/** The type Obsidian gives a property: one per name, for the whole vault. */
export const obsidianType = (field: Field): string => (isList(field) ? "multitext" : OBSIDIAN_TYPES[baseKind(field)] ?? "text");

const list = (value: unknown): unknown[] => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);
const strings = (value: unknown): string[] => list(value).map(String);

/** A map of names from YAML, or null when there is none. */
function readNames(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => typeof value === "string" && value) as [string, string][]);
}

function readFields(raw: Record<string, any> = {}): Map<string, Field> {
  return new Map(
    Object.entries(raw ?? {}).map(([name, spec]) => {
      const s = typeof spec === "string" ? { kind: spec } : spec ?? {};
      const agenda = s.agenda === true ? name : typeof s.agenda === "string" && s.agenda ? s.agenda : null;
      return [
        name,
        {
          name,
          kind: s.kind ?? "string",
          values: list(s.values),
          target: strings(s.target),
          kinds: strings(s.kinds),
          unique: s.unique === "similar" ? "similar" : s.unique === true,
          after: typeof s.after === "string" ? s.after : null,
          deadline: s.deadline === true,
          agenda,
        },
      ];
    })
  );
}

function readCondition(raw: unknown): Condition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return new Map(Object.entries(raw).map(([property, values]) => [property, list(values)]));
}

function matches(condition: Condition, meta: Meta): boolean {
  return [...condition].some(([property, values]) => list(meta[property]).some((value) => values.includes(value)));
}

export class Schema {
  readonly types = new Map<string, TypeSpec>();
  readonly contentFolders: string[];
  readonly freeFolders: string[];
  /** Folders of attachments: every file inside should be linked by a note. */
  readonly attachmentFolders: string[];
  /** Property whose values select a kind template and the fields reserved to a kind. */
  readonly kindProperty: string | null;
  private commonFields: Map<string, Field>;
  private commonRequired: string[];

  constructor(data: any, readonly typeProperty: string) {
    data = data && typeof data === "object" ? data : {};
    this.contentFolders = strings(data.content_folders);
    this.freeFolders = strings(data.free_folders);
    this.attachmentFolders = strings(data.attachment_folders);
    this.kindProperty = typeof data.kind_property === "string" ? data.kind_property : null;
    this.commonFields = readFields(data.common?.fields);
    this.commonRequired = strings(data.common?.required);
    for (const [name, raw] of Object.entries<any>(data.types ?? {})) {
      const spec = raw ?? {};
      const personName = strings(spec.person_name);
      this.types.set(name, {
        name,
        folder: spec.folder ?? "",
        required: strings(spec.required),
        template: strings(spec.template),
        kindTemplates: spec.kind_templates ?? {},
        fields: readFields(spec.fields),
        body: spec.body ?? "",
        open: readCondition(spec.open),
        closed: readCondition(spec.closed),
        staleAfter: typeof spec.stale_after === "number" ? spec.stale_after : null,
        pruneAfter: typeof spec.prune_after === "number" ? spec.prune_after : null,
        expectBacklinks: spec.expect_backlinks === true,
        personName: personName.length === 2 ? [personName[0], personName[1]] : null,
        briefing: strings(spec.briefing),
        calendar: readNames(spec.calendar),
        nameDate: typeof spec.name_date === "string" ? spec.name_date : null,
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

  /**
   * Properties defined with kinds that Obsidian would show differently in different types:
   * Obsidian keeps one type per property name, so one of them would be wrong.
   */
  typeConflicts(): string[] {
    const seen = new Map<string, Map<string, string[]>>();
    const note = (owner: string, field: Field) => {
      const types = seen.get(field.name) ?? new Map<string, string[]>();
      const type = obsidianType(field);
      types.set(type, [...(types.get(type) ?? []), owner]);
      seen.set(field.name, types);
    };
    for (const field of this.commonFields.values()) note("common", field);
    for (const spec of this.types.values()) for (const field of spec.fields.values()) note(spec.name, field);
    return [...seen]
      .filter(([, types]) => types.size > 1)
      .map(([name, types]) => `${name}: ${[...types].map(([type, owners]) => `${type} in ${owners.join(", ")}`).join("; ")}`);
  }

  /** Folders the schema assigns to notes. */
  folders(): string[] {
    return [...this.contentFolders, ...this.freeFolders, ...[...this.types.values()].map((spec) => spec.folder).filter(Boolean)];
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

  inAttachmentFolder(path: string): boolean {
    return this.attachmentFolders.some((folder) => path.startsWith(`${folder}/`));
  }

  /** The kind of a note, when the schema names a kind property. */
  kindOf(meta: Meta): string | null {
    const value = this.kindProperty ? meta[this.kindProperty] : undefined;
    return typeof value === "string" && value ? value : null;
  }

  isClosed(spec: TypeSpec, meta: Meta): boolean {
    return spec.closed ? matches(spec.closed, meta) : false;
  }

  isOpen(spec: TypeSpec, meta: Meta): boolean {
    return spec.open ? matches(spec.open, meta) : !this.isClosed(spec, meta);
  }

  /**
   * The frontmatter a note should have: the type property, then the template of
   * its type and kind in order (missing ones empty), then any other property as
   * it was. Returns null when nothing changes, order included.
   */
  conform(meta: Meta): Meta | null {
    const type = meta[this.typeProperty];
    const spec = typeof type === "string" ? this.types.get(type) : undefined;
    if (!spec) return null;
    const kind = this.kindOf(meta);
    const template = (kind && spec.kindTemplates[kind]) || spec.template;
    const next: Meta = {};
    for (const key of [this.typeProperty, ...template]) next[key] = key in meta ? meta[key] : spec.fields.get(key)?.kind === "bool" ? false : null;
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
const DATETIME = /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)?$/;
const LINK_ONLY = /^\s*\[\[[^[\]\n]+\]\]\s*$/;

function checkScalar(field: Field, value: unknown): string[] {
  const fail = (message: string, ok: boolean) => (ok ? [] : [message]);
  const text = typeof value === "string" ? value : "";
  switch (baseKind(field)) {
    case "string":
    case "text":
      return fail(`expected text, found ${typeof value}`, typeof value === "string");
    case "int":
      return fail("expected a whole number", Number.isInteger(value));
    case "number":
      return fail("expected a number", typeof value === "number");
    case "bool":
      return fail("expected true or false (checkbox)", typeof value === "boolean");
    case "date":
      return fail("expected a date YYYY-MM-DD", asDate(value) !== null);
    case "datetime":
      return fail("expected a date YYYY-MM-DD, or a date and time YYYY-MM-DDTHH:mm", DATETIME.test(text) && asDate(text) !== null);
    case "url":
      return fail("expected an http(s) URL", /^https?:\/\//.test(text));
    case "doi":
      return fail("invalid DOI (expected 10.xxxx/...)", DOI.test(text));
    case "orcid":
      return fail("invalid ORCID (expected 0000-0000-0000-0000)", ORCID.test(text));
    case "enum":
      return fail(`value "${value}" not allowed: ${field.values.join(", ")}`, field.values.includes(value));
    case "link":
      return fail('expected a wikilink in quotes, for example "[[Note]]"', LINK_ONLY.test(text));
    default:
      return [];
  }
}

/** Problems of a value against its field; empty when valid. */
export function checkValue(field: Field, value: unknown): string[] {
  if (isEmpty(value)) return [];
  if (!isList(field)) return checkScalar(field, value);
  if (!Array.isArray(value)) return [`should be a list (${field.kind})`];
  const problems = value.some(isEmpty) ? ["contains empty items"] : [];
  for (const item of value) if (!isEmpty(item)) problems.push(...checkScalar(field, item));
  return [...new Set(problems)].sort();
}
