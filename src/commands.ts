// What the commands of the Obsidian command line print: plain text for people and
// agents, JSON on request. The plugin registers them in main.ts.

import { countBySeverity, type Issue } from "./lint";
import { linksOf, neighbours, shortestPath } from "./graph";
import type { RecallResult } from "./recall";
import type { Vault } from "./vault";

export function lintReport(issues: Issue[], all: boolean): string {
  const counts = countBySeverity(issues);
  const lines = issues
    .filter((issue) => all || issue.severity !== "info")
    .map((issue) => `${issue.severity.padEnd(7)} ${issue.code.padEnd(20)} ${issue.path}:${issue.line}  ${issue.message}${issue.hint ? ` → ${issue.hint}` : ""}`);
  const summary = `${counts.error} errori, ${counts.warning} avvisi, ${counts.info} informazioni${all ? "" : " (all per vedere le informazioni)"}`;
  return [...lines, ...(lines.length ? [""] : []), summary].join("\n");
}

export function recallReport(results: RecallResult[]): string {
  const failed = results.filter((result) => !result.ok).length;
  return [
    ...results.map(({ ok, id, question, got }) => `${ok ? "OK  " : "FAIL"} ${id}  ${question}\n       → ${got.join(", ") || "(nessun risultato)"}`),
    "",
    `${results.length - failed}/${results.length} superati`,
  ].join("\n");
}

export function linksReport(vault: Vault, query: string, json: boolean): string {
  const result = linksOf(vault, vault.get(query));
  if (json) return JSON.stringify(result, null, 1);
  const name = (path: string) => vault.notes.get(path)!.name;
  const lines = [`# ${name(result.note)}`];
  for (const [title, group] of [["In uscita", result.outgoing], ["In entrata", result.incoming]] as const) {
    lines.push("", `${title}:`);
    const entries = Object.entries(group);
    if (!entries.length) lines.push("  (nessuno)");
    for (const [field, paths] of entries) lines.push(`  ${field}: ${paths.map(name).join(", ")}`);
  }
  if (result.unresolved.length) lines.push("", `Irrisolti: ${result.unresolved.join(", ")}`);
  return lines.join("\n");
}

export function pathReport(vault: Vault, from: string, to: string, all: boolean): string {
  const steps = shortestPath(vault, vault.get(from), vault.get(to), !all);
  if (!steps) return "Nessun percorso fra le due note.";
  const name = (path: string) => vault.notes.get(path)!.name;
  const line = steps.slice(1).map(({ path, label, direction }) => `${direction === "out" ? ` —${label}→ ` : ` ←${label}— `}${name(path)}`);
  return `${name(steps[0].path)}${line.join("")}\n(${steps.length - 1} passi)`;
}

export function neighboursReport(vault: Vault, query: string, depth: number): string {
  return [...neighbours(vault, vault.get(query), depth)]
    .map(([path, distance]) => {
      const note = vault.notes.get(path)!;
      return `${distance}  ${(note.type ?? "-").padEnd(12)} ${note.name}`;
    })
    .join("\n");
}
