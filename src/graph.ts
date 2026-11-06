// The graph of relations: links of a note, shortest paths, neighbours. Built
// from resolved links between notes; frontmatter links are labelled with their
// property, links in the body with "mentions".

import { compare } from "./text";
import type { Note, Vault } from "./vault";

const BODY_LABEL = "mentions";

type Direction = "out" | "in";
type Neighbour = { path: string; label: string; direction: Direction };
export type PathStep = { path: string; label: string | null; direction: Direction | null };

function adjacency(vault: Vault, typedOnly: boolean): Map<string, Neighbour[]> {
  const edges = new Map<string, [string, string, string]>();
  for (const note of vault.notes.values()) {
    if (typedOnly && !note.type) continue;
    for (const link of vault.relationLinks(note)) {
      if (typedOnly && !vault.notes.get(link.resolved!)?.type) continue;
      const label = link.field ?? BODY_LABEL;
      edges.set(`${note.path}\n${link.resolved}\n${label}`, [note.path, link.resolved!, label]);
    }
  }
  const adj = new Map<string, Neighbour[]>();
  const push = (from: string, item: Neighbour) => adj.set(from, [...(adj.get(from) ?? []), item]);
  for (const [source, target, label] of edges.values()) {
    push(source, { path: target, label, direction: "out" });
    push(target, { path: source, label, direction: "in" });
  }
  for (const neighbours of adj.values()) {
    neighbours.sort((a, b) => compare(a.path, b.path) || compare(a.label, b.label) || compare(a.direction, b.direction));
  }
  return adj;
}

function group(pairs: [string, string][]): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const [label, path] of [...pairs].sort((a, b) => compare(a[0], b[0]))) (out[label] ??= new Set()).add(path);
  return Object.fromEntries(Object.entries(out).map(([label, paths]) => [label, [...paths].sort(compare)]));
}

/** Relations of a note, grouped by property, with its unresolved links. */
export function linksOf(vault: Vault, note: Note) {
  const outgoing = vault.relationLinks(note).map((link): [string, string] => [link.field ?? BODY_LABEL, link.resolved!]);
  const incoming = (vault.backlinks.get(note.path) ?? []).map((link): [string, string] => [link.field ?? BODY_LABEL, link.source]);
  const unresolved = note.links.filter((link) => link.resolved === null).map((link) => link.target);
  return { note: note.path, outgoing: group(outgoing), incoming: group(incoming), unresolved: [...new Set(unresolved)].sort(compare) };
}

/** Shortest undirected path between two notes, or null. */
export function shortestPath(vault: Vault, start: Note, goal: Note, typedOnly = true): PathStep[] | null {
  const adj = adjacency(vault, typedOnly);
  const previous = new Map<string, { from: string; label: string; direction: Direction } | null>([[start.path, null]]);
  const queue = [start.path];
  for (let i = 0; i < queue.length && queue[i] !== goal.path; i++) {
    for (const { path, label, direction } of adj.get(queue[i]) ?? []) {
      if (!previous.has(path)) {
        previous.set(path, { from: queue[i], label, direction });
        queue.push(path);
      }
    }
  }
  if (!previous.has(goal.path)) return null;
  const steps: PathStep[] = [];
  for (let node = goal.path; ; ) {
    const step = previous.get(node);
    if (!step) break;
    steps.unshift({ path: node, label: step.label, direction: step.direction });
    node = step.from;
  }
  return [{ path: start.path, label: null, direction: null }, ...steps];
}

/** Notes within `depth` steps, with their distance, nearest first. */
export function neighbours(vault: Vault, note: Note, depth = 1): [string, number][] {
  const adj = adjacency(vault, true);
  const distance = new Map([[note.path, 0]]);
  const queue = [note.path];
  for (let i = 0; i < queue.length; i++) {
    const current = distance.get(queue[i])!;
    if (current >= depth) continue;
    for (const { path } of adj.get(queue[i]) ?? []) {
      if (!distance.has(path)) {
        distance.set(path, current + 1);
        queue.push(path);
      }
    }
  }
  distance.delete(note.path);
  return [...distance].sort((a, b) => a[1] - b[1] || compare(a[0], b[0]));
}
