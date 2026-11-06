// The briefing: starting context for agents, in one short page. People have the
// Home note, with the same picture as live views.

import { countBySeverity, type Issue } from "./lint";
import type { Schema } from "./schema";
import { addDays, asDate, compare } from "./text";
import type { Note, Vault } from "./vault";

const HORIZON_DAYS = 30;
const RECENT_DAYS = 14;
const LIVE_STATUS = ["In Progress", "Drafting", "Submitted", "Under Evaluation", "Awarded"];
const CLOSED_STATUS = ["Completed", "Closed", "Rejected", "Cancelled"];
const PRIORITY = ["High", "Medium", "Low"];
const DATED: [type: string, key: string, label: string][] = [
  ["Task", "Due Date", "due"],
  ["Task", "Scheduled", "scheduled"],
  ["Project", "Deadline", "official deadline"],
  ["Project", "End", "period ends"],
  ["Event", "Date", "event"],
  ["Role", "End", "role ends"],
];

type Row = { day: string; label: string; note: Note };

function upcoming(vault: Vault, today: string): { next: Row[]; overdue: Row[] } {
  const horizon = addDays(today, HORIZON_DAYS);
  const next: Row[] = [];
  const overdue: Row[] = [];
  for (const [type, key, label] of DATED) {
    for (const note of vault.typedNotes(type)) {
      const day = asDate(note.meta[key]);
      if (!day || note.meta.Done === true || CLOSED_STATUS.includes(note.meta.Status as string)) continue;
      if (day >= today && day <= horizon) next.push({ day, label, note });
      else if (day < today && ((type === "Task" && key === "Due Date") || (type === "Project" && key === "End" && note.meta.Status === "In Progress"))) {
        overdue.push({ day, label, note });
      }
    }
  }
  const byDay = (a: Row, b: Row) => compare(a.day, b.day) || compare(a.note.path, b.note.path);
  return { next: next.sort(byDay), overdue: overdue.sort(byDay) };
}

export function briefing(vault: Vault, schema: Schema, issues: Issue[], today: string): string {
  const rowLine = ({ day, label, note }: Row) => `- ${day} · ${label} · [[${note.name}]]`;
  const counts = countBySeverity(issues);
  const composition = [...schema.types.keys()]
    .map((type) => [type, vault.typedNotes(type).length] as const)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${type} ${count}`)
    .join(", ");
  const toSort = [...vault.notes.keys()].filter((path) => schema.inFreeFolder(path)).length;
  const { next, overdue } = upcoming(vault, today);

  const priority = (note: Note) => {
    const rank = PRIORITY.indexOf(note.meta.Priority as string);
    return rank < 0 ? PRIORITY.length : rank;
  };
  const tasks = vault
    .typedNotes("Task")
    .filter((note) => note.meta.Done !== true)
    .sort((a, b) => priority(a) - priority(b) || compare(String(a.meta["Due Date"] ?? "9999"), String(b.meta["Due Date"] ?? "9999")) || compare(a.name, b.name))
    .map((note) => {
      const extra = [note.meta.Priority, note.meta["Due Date"]].filter(Boolean);
      return `- [[${note.name}]]${extra.length ? ` · ${extra.join(" · ")}` : ""}`;
    });
  const projects = vault
    .typedNotes("Project")
    .filter((note) => LIVE_STATUS.includes(note.meta.Status as string))
    .sort((a, b) => compare(String(a.meta.Kind), String(b.meta.Kind)) || compare(a.name, b.name))
    .map((note) => `- [[${note.name}]] · ${note.meta.Kind} · ${note.meta.Status}`);

  const since = Date.parse(`${addDays(today, -RECENT_DAYS)}T00:00:00Z`);
  const recent = [...vault.notes.values()]
    .filter((note) => note.type && note.mtime >= since)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 10)
    .map((note) => `- ${new Date(note.mtime).toISOString().slice(0, 10)} · [[${note.name}]]`);
  const logEntries = [...(vault.notes.get("system/log.md")?.body ?? "").matchAll(/^## \[(\d{4}-\d{2}-\d{2})\] (.+)$/gm)]
    .slice(-5)
    .map((m) => `- ${m[1]} · ${m[2]}`);

  const section = (title: string, lines: string[], empty: string) => ["", `## ${title}`, "", ...(lines.length ? lines : [`- ${empty}`])];
  return [
    "# Briefing",
    "",
    `Generated: ${today} · by the Second Brain plugin after every change · starting context for agents, no AI`,
    ...section(
      "Archive",
      [
        `- Objects: ${composition}.`,
        `- Lint: ${counts.error} errors, ${counts.warning} warnings, ${counts.info} notices (\`obsidian-cli second-brain:lint\`).`,
        `- Inbox items to sort: ${toSort}.`,
      ],
      ""
    ),
    ...section(`Next ${HORIZON_DAYS} days`, next.map(rowLine), "Nothing scheduled."),
    ...(overdue.length ? section("Overdue", overdue.map(rowLine), "") : []),
    ...section("Open tasks", tasks, "None."),
    ...section("Live projects", projects, "None."),
    ...section(`Recently changed notes (${RECENT_DAYS} days)`, recent, "None."),
    ...section("Latest log entries", logEntries, "Empty log."),
    "",
  ].join("\n");
}
