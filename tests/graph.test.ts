import { test } from "node:test";
import assert from "node:assert/strict";
import { briefing } from "../src/briefing";
import { linksReport, pathReport } from "../src/commands";
import { linksOf, neighbours, shortestPath } from "../src/graph";
import { lint } from "../src/lint";
import { runRecall } from "../src/recall";
import { note, schema, vaultOf } from "./helpers";

const vault = vaultOf({
  "Notes/People/Mario Rossi.md": note("Type: Person"),
  "Notes/Topics/T.md": note("Type: Topic"),
  "Library/Articles/A.md": note('Type: Article\nTitle: Test\nAuthors:\n  - "[[Mario Rossi]]"\nTopics:\n  - "[[T]]"', "See [[Missing]].\n"),
  "Tasks/Soon.md": note("Type: Task\nDone: false\nPriority: High\nDue Date: 2026-11-01"),
  "Tasks/Late.md": note("Type: Task\nDone: false\nDue Date: 2026-01-01"),
  "Tasks/Done.md": note("Type: Task\nDone: true\nDue Date: 2026-01-01"),
  "Notes/Projects/Live.md": note("Type: Project\nKind: Research\nStatus: In Progress"),
  "Notes/Projects/Idea.md": note("Type: Project\nKind: Research\nStatus: Idea"),
  "Inbox/x.md": "To sort\n",
});

test("links of a note, grouped by property", () => {
  const links = linksOf(vault, vault.get("A"));
  assert.deepEqual(links.outgoing, { Authors: ["Notes/People/Mario Rossi.md"], Topics: ["Notes/Topics/T.md"] });
  assert.deepEqual(links.unresolved, ["Missing"]);
  assert.deepEqual(linksOf(vault, vault.get("T")).incoming, { Topics: ["Library/Articles/A.md"] });
});

test("the command line prints links and paths with the name of each relation", () => {
  assert.equal(linksReport(vault, "T", false), "# T\n\nOutgoing:\n  (none)\n\nIncoming:\n  Topics: A");
  assert.equal(pathReport(vault, "Mario Rossi", "T", false), "Mario Rossi ←Authors— A —Topics→ T\n(2 steps)");
});

test("shortest path and neighbours go both ways", () => {
  const steps = shortestPath(vault, vault.get("Mario Rossi"), vault.get("T"))!;
  assert.deepEqual(steps.map((step) => [step.path, step.label, step.direction]), [
    ["Notes/People/Mario Rossi.md", null, null],
    ["Library/Articles/A.md", "Authors", "in"],
    ["Notes/Topics/T.md", "Topics", "out"],
  ]);
  assert.equal(shortestPath(vault, vault.get("Mario Rossi"), vault.get("Soon")), null);
  assert.deepEqual(neighbours(vault, vault.get("Mario Rossi"), 2), [["Library/Articles/A.md", 1], ["Notes/Topics/T.md", 2]]);
});

test("recall tests: a right answer passes, a wrong or too long one fails", () => {
  const results = runRecall(vault, {
    checks: [
      { id: "R1", question: "field", op: "field", note: "A", field: "Topics", expect: ["T"] },
      { id: "R2", question: "incoming", op: "incoming", note: "Mario Rossi", field: "Authors", expect: ["A"] },
      { id: "R3", question: "path", op: "path", from: "Mario Rossi", to: "T", expect: ["A"], max_length: 3 },
      { id: "R4", question: "too long", op: "path", from: "Mario Rossi", to: "T", expect: ["A"], max_length: 2 },
      { id: "R5", question: "notes", op: "notes", type: "Article", links: { Authors: "Mario Rossi", Topics: "T" }, expect: ["A"] },
      { id: "R6", question: "wrong", op: "field", note: "A", field: "Topics", expect: ["Other"] },
    ],
  });
  assert.deepEqual(results.map((result) => result.ok), [true, true, true, false, true, false]);
  assert.throws(() => runRecall(vault, { checks: [{ id: "R7", op: "articles" }] }), /Unknown operation in recall test R7: articles/);
});

test("the briefing lists what comes next, what is late and the log", () => {
  const today = "2026-10-26";
  const text = briefing(vault, schema, lint(vault, schema, today), today, "## [2026-10-26] edit | first\n");
  assert.match(text, /## Next 30 days\n\n- 2026-11-01 · due · \[\[Soon\]\]/);
  assert.match(text, /## Overdue\n\n- 2026-01-01 · due · \[\[Late\]\]/);
  assert.match(text, /## Open: Task\n\n- \[\[Soon\]\] · High · 2026-11-01\n- \[\[Late\]\] · 2026-01-01/);
  assert.match(text, /## Open: Project\n\n- \[\[Live\]\] · Research · In Progress\n\n/);
  assert.match(text, /To sort in Inbox: 1\./);
  assert.match(text, /## Latest log entries\n\n- 2026-10-26 · edit \| first/);
});
