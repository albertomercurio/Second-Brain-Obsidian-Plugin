// Recall tests: questions with a known answer, solved only through the links
// (the recall file of the settings). They measure whether the memory stays
// reachable. Operations:
//   field     the notes a property of `note` links to
//   incoming  the notes linking to `note`, through `field` if given
//   path      the shortest chain from `from` to `to`
//   notes     the notes (of `type`, if given) whose properties link to the given
//             notes: `links: {Authors: Ada Lovelace, Topics: Analytical engine}`

import { shortestPath } from "./graph";
import { compare } from "./text";
import type { Vault } from "./vault";

export interface RecallResult {
  id: string;
  question: string;
  ok: boolean;
  got: string[];
}

function answer(vault: Vault, check: any): string[] {
  const names = (paths: (string | null)[]) =>
    paths.flatMap((path) => (path && vault.notes.get(path) ? [vault.notes.get(path)!.name] : [])).sort(compare);
  switch (check.op) {
    case "field":
      return names(vault.get(check.note).links.filter((link) => link.field === check.field).map((link) => link.resolved));
    case "incoming": {
      const links = vault.backlinks.get(vault.get(check.note).path) ?? [];
      return names(links.filter((link) => !check.field || link.field === check.field).map((link) => link.source));
    }
    case "path": {
      const steps = shortestPath(vault, vault.get(check.from), vault.get(check.to)) ?? [];
      return steps.map((step) => vault.notes.get(step.path)!.name);
    }
    case "notes": {
      let notes = check.type ? vault.typedNotes(check.type) : [...vault.notes.values()];
      for (const [field, query] of Object.entries<string>(check.links ?? {})) {
        const target = vault.get(query).path;
        notes = notes.filter((note) => note.links.some((link) => link.field === field && link.resolved === target));
      }
      return notes.map((note) => note.name).sort(compare);
    }
    default:
      throw new Error(`Unknown operation in recall test ${check.id}: ${check.op}`);
  }
}

export function runRecall(vault: Vault, spec: any): RecallResult[] {
  return (spec?.checks ?? []).map((check: any) => {
    const got = answer(vault, check);
    const found = (check.expect ?? []).every((expected: string) => got.includes(expected));
    const shortEnough = check.max_length === undefined || (got.length > 0 && got.length <= check.max_length);
    return { id: check.id, question: check.question, ok: found && shortEnough, got };
  });
}
