// ---------------------------------------------------------------------------
// The calendar commands: notes of one type mirror events of the calendar. A
// local helper reads and writes the calendar (see helper.ts); this module turns
// a note into the fields of an event and an event into a new note. The schema
// names the properties with the `calendar` rule of the type.
// ---------------------------------------------------------------------------

import { renderNote } from "./frontmatter";
import type { Schema } from "./schema";
import { asDate, datedName, nfc, splitDatedName } from "./text";
import type { Meta, Vault } from "./vault";

/** The properties the commands use, from the `calendar` rule of a type. */
export interface CalendarSpec {
  type: string;
  folder: string;
  body: string;
  /** Date, or date and time, of the start; required. */
  start: string;
  end: string | null;
  location: string | null;
  /** Links to the notes of the people taking part. */
  participants: string | null;
  /** Property of those notes holding their email addresses. */
  email: string | null;
  /** Where the link that opens the event in the calendar is kept; required. */
  link: string;
  /** Names end with the day, "Title (YYYY-MM-DD)": the type has `name_date`. */
  dated: boolean;
  /** Value of the kind property for notes made from an event. */
  kind: string | null;
}

/** An event as the helper gives it. */
export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO 8601 with the offset of the computer, or YYYY-MM-DD for a whole day. */
  start: string;
  /** The same; for a whole day, the last day included. */
  end: string;
  all_day: boolean;
  location?: string | null;
  account: string;
  link: string;
  organizer?: Person | null;
  attendees?: Person[];
}

interface Person {
  name?: string | null;
  email?: string | null;
  me?: boolean;
}

/** The fields of an event to create or update. */
export interface Draft {
  title: string;
  start: string;
  end?: string;
  all_day: boolean;
  location?: string;
}

/** The first type with a `calendar` rule naming at least `start` and `link`. */
export function calendarSpec(schema: Schema): CalendarSpec | null {
  for (const spec of schema.types.values()) {
    const rule = spec.calendar;
    if (!rule?.start || !rule.link) continue;
    return {
      type: spec.name,
      folder: spec.folder,
      body: spec.body,
      start: rule.start,
      end: rule.end ?? null,
      location: rule.location ?? null,
      participants: rule.participants ?? null,
      email: rule.email ?? null,
      link: rule.link,
      kind: rule.kind ?? null,
      dated: spec.nameDate !== null,
    };
  }
  return null;
}

/** Text from outside the vault, safe in a note: no Templater commands, no wikilinks, one line. */
export function clean(text: string): string {
  return nfc(text)
    .replace(/<%|%>/g, "")
    .replace(/\[\[|\]\]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A title that is a valid file name, also inside a link. */
export function fileTitle(text: string): string {
  return clean(text).replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").replace(/^\.+/, "").trim().slice(0, 120).trim();
}

/** The event id inside a calendar link (ical://ekevent/<id>?…), or null. */
export function eventId(link: unknown): string | null {
  const match = typeof link === "string" ? /^ical:\/\/ekevent\/([^?#]+)/.exec(link) : null;
  return match ? decodeURIComponent(match[1]) : null;
}

const MOMENT = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/;

/** Day and time (HH:MM, or null for a whole day) of a property value. */
function moment(value: unknown): { day: string; time: string | null } | null {
  const text = typeof value === "string" ? value.trim() : "";
  const match = MOMENT.exec(text);
  if (!match || asDate(match[1]) === null) return null;
  return { day: match[1], time: match[2] ?? null };
}

/** The fields of the event a note describes. Throws with a readable message when they are not enough. */
export function draftFromNote(name: string, meta: Meta, spec: CalendarSpec): Draft {
  const title = clean(spec.dated ? splitDatedName(name)?.title ?? name : name);
  if (!title) throw new Error("the note needs a title before the date in its name");
  const start = moment(meta[spec.start]);
  if (!start) throw new Error(`the note has no ${spec.start}`);
  const end = spec.end ? moment(meta[spec.end]) : null;
  const location = spec.location && typeof meta[spec.location] === "string" ? clean(meta[spec.location] as string) : "";
  const draft: Draft = { title, start: start.day, all_day: start.time === null };
  if (start.time) {
    draft.start = `${start.day}T${start.time}`;
    if (end && !end.time) throw new Error(`${spec.end} needs a time too, like ${spec.start}`);
    if (end) draft.end = `${end.day}T${end.time}`;
  } else if (end) {
    if (end.time) throw new Error(`${spec.start} needs a time too, like ${spec.end}`);
    draft.end = end.day;
  }
  if (location) draft.location = location;
  return draft;
}

/** Email address (lower case) → name of the note, for the types the participants link to. */
export function peopleByEmail(vault: Vault, schema: Schema, spec: CalendarSpec): Map<string, string> {
  const people = new Map<string, string>();
  if (!spec.participants || !spec.email) return people;
  const targets = schema.fieldsFor(spec.type).get(spec.participants)?.target ?? [];
  for (const note of vault.typedNotes()) {
    if (!note.type || !targets.includes(note.type)) continue;
    const emails = note.meta[spec.email];
    for (const email of Array.isArray(emails) ? emails : [emails]) {
      if (typeof email === "string" && email.includes("@")) people.set(email.trim().toLowerCase(), note.name);
    }
  }
  return people;
}

/** The property value of an instant of the helper: YYYY-MM-DDTHH:mm in the computer's time, or the day. */
const propertyMoment = (value: string, allDay: boolean): string => (allDay ? value.slice(0, 10) : value.slice(0, 16));

/** Where the note of an event goes: "Title (YYYY-MM-DD)" in the type's folder; `n` > 1 numbers a second note. */
export function eventPath(spec: CalendarSpec, event: CalendarEvent, n = 1): string {
  const title = (fileTitle(event.title) || "Event") + (n > 1 ? ` ${n}` : "");
  const name = spec.dated ? datedName(title, event.start.slice(0, 10)) : title;
  return `${spec.folder ? `${spec.folder}/` : ""}${name}.md`;
}

/**
 * A new note for an event: in the folder of the type, named as `eventPath` says, with the
 * template's properties in order. People are linked when the vault knows their address;
 * the other addresses go in the text, to be added by hand.
 */
export function noteFromEvent(event: CalendarEvent, spec: CalendarSpec, schema: Schema, people: Map<string, string>): { path: string; text: string } {
  const meta: Meta = { [schema.typeProperty]: spec.type };
  if (schema.kindProperty && spec.kind) meta[schema.kindProperty] = spec.kind;
  meta[spec.start] = propertyMoment(event.start, event.all_day);
  const end = propertyMoment(event.end, event.all_day);
  if (spec.end && end !== meta[spec.start]) meta[spec.end] = end;

  const linked = new Set<string>();
  const others = new Set<string>();
  for (const person of [event.organizer, ...(event.attendees ?? [])]) {
    const email = person?.email?.toLowerCase();
    if (!email) continue;
    const name = people.get(email);
    if (name) linked.add(name);
    else if (!person?.me) others.add(clean(email));
  }
  if (spec.participants && linked.size) meta[spec.participants] = [...linked].map((name) => `[[${name}]]`);
  const location = clean(event.location ?? "");
  if (spec.location && location) meta[spec.location] = location;
  meta[spec.link] = event.link;

  const intro = others.size ? `Participants not in the vault: ${[...others].join(", ")}.\n\n` : "";
  return { path: eventPath(spec, event), text: renderNote(schema.conform(meta) ?? meta, intro + spec.body) };
}
