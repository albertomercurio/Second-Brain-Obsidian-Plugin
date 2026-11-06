// The briefing: starting context for agents, in one short page. What it lists
// comes from the schema: dates with an `agenda` label, `deadline` dates passed,
// the open notes of types with a `briefing` list.

import { plural } from "./commands";
import { countBySeverity, type Issue } from "./lint";
import { type Field, isEmpty, type Schema } from "./schema";
import { addDays, asDate, compare } from "./text";
import type { Note, Vault } from "./vault";

const HORIZON_DAYS = 30;
const RECENT_DAYS = 14;

type Row = { day: string; label: string; note: Note };

function agenda(vault: Vault, schema: Schema, today: string): { next: Row[]; overdue: Row[] } {
  const horizon = addDays(today, HORIZON_DAYS);
  const next: Row[] = [];
  const overdue: Row[] = [];
  for (const spec of schema.types.values()) {
    const dated = [...schema.fieldsFor(spec.name).values()].filter((field) => field.agenda || field.deadline);
    if (!dated.length) continue;
    for (const note of vault.typedNotes(spec.name)) {
      if (schema.isClosed(spec, note.meta)) continue;
      for (const field of dated) {
        const day = asDate(note.meta[field.name]);
        if (!day) continue;
        const row = { day, label: field.agenda ?? field.name, note };
        if (day >= today && day <= horizon) {
          if (field.agenda) next.push(row);
        } else if (day < today && field.deadline && schema.isOpen(spec, note.meta)) overdue.push(row);
      }
    }
  }
  const byDay = (a: Row, b: Row) => compare(a.day, b.day) || compare(a.note.path, b.note.path);
  return { next: next.sort(byDay), overdue: overdue.sort(byDay) };
}

/** Sorts by each property in turn: enums in the order of their values, the rest as text, empty last. */
function byProperties(fields: (Field | undefined)[], names: string[]) {
  const rank = (index: number, value: unknown): [number, string] => {
    if (isEmpty(value)) return [Number.MAX_SAFE_INTEGER, ""];
    const position = fields[index]?.values.indexOf(value) ?? -1;
    return position >= 0 ? [position, ""] : [-1, String(value)];
  };
  return (a: Note, b: Note): number => {
    for (const [i, name] of names.entries()) {
      const [rankA, textA] = rank(i, a.meta[name]);
      const [rankB, textB] = rank(i, b.meta[name]);
      const order = rankA - rankB || compare(textA, textB);
      if (order) return order;
    }
    return compare(a.name, b.name);
  };
}

export function briefing(vault: Vault, schema: Schema, issues: Issue[], today: string, log = ""): string {
  const rowLine = ({ day, label, note }: Row) => `- ${day} · ${label} · [[${note.name}]]`;
  const counts = countBySeverity(issues);
  const composition = [...schema.types.keys()]
    .map((type) => [type, vault.typedNotes(type).length] as const)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${type} ${count}`)
    .join(", ");
  const toSort = [...vault.notes.keys()].filter((path) => schema.inFreeFolder(path)).length;
  const { next, overdue } = agenda(vault, schema, today);

  const lists = [...schema.types.values()]
    .filter((spec) => spec.briefing.length)
    .map((spec) => {
      const fields = schema.fieldsFor(spec.name);
      const lines = vault
        .typedNotes(spec.name)
        .filter((note) => schema.isOpen(spec, note.meta))
        .sort(byProperties(spec.briefing.map((name) => fields.get(name)), spec.briefing))
        .map((note) => {
          const extra = spec.briefing.map((name) => note.meta[name]).filter((value) => !isEmpty(value));
          return `- [[${note.name}]]${extra.length ? ` · ${extra.join(" · ")}` : ""}`;
        });
      return [spec.name, lines] as const;
    });

  const since = Date.parse(`${addDays(today, -RECENT_DAYS)}T00:00:00Z`);
  const recent = [...vault.notes.values()]
    .filter((note) => note.type && note.mtime >= since)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 10)
    .map((note) => `- ${new Date(note.mtime).toISOString().slice(0, 10)} · [[${note.name}]]`);
  const logEntries = [...log.matchAll(/^## \[(\d{4}-\d{2}-\d{2})\] (.+)$/gm)].slice(-5).map((m) => `- ${m[1]} · ${m[2]}`);

  const section = (title: string, lines: string[], empty: string) => ["", `## ${title}`, "", ...(lines.length ? lines : [`- ${empty}`])];
  return [
    "# Briefing",
    "",
    `Generated: ${today} · by the Second Brain plugin after every change · starting context for agents, no AI`,
    ...section(
      "Archive",
      [
        `- Objects: ${composition || "none"}.`,
        `- Lint: ${plural(counts.error, "error")}, ${plural(counts.warning, "warning")}, ${plural(counts.info, "notice")} (\`obsidian-cli second-brain:lint\`).`,
        ...(schema.freeFolders.length ? [`- To sort in ${schema.freeFolders.join(", ")}: ${toSort}.`] : []),
      ],
      ""
    ),
    ...section(`Next ${HORIZON_DAYS} days`, next.map(rowLine), "Nothing scheduled."),
    ...(overdue.length ? section("Overdue", overdue.map(rowLine), "") : []),
    ...lists.flatMap(([type, lines]) => section(`Open: ${type}`, lines, "None.")),
    ...section(`Recently changed notes (${RECENT_DAYS} days)`, recent, "None."),
    ...section("Latest log entries", logEntries, "Empty log."),
    "",
  ].join("\n");
}
