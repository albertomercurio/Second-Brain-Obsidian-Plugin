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
  "Inbox/x.md": "To sort\n",
  "system/log.md": "## [2026-10-26] edit | first\n",
});

test("links of a note, grouped by property", () => {
  const links = linksOf(vault, vault.get("A"));
  assert.deepEqual(links.outgoing, { Authors: ["Notes/People/Mario Rossi.md"], Topics: ["Notes/Topics/T.md"] });
  assert.deepEqual(links.unresolved, ["Missing"]);
  assert.deepEqual(linksOf(vault, vault.get("T")).incoming, { Topics: ["Library/Articles/A.md"] });
});

test("the command line prints links and paths with the name of each relation", () => {
  assert.equal(linksReport(vault, "T", false), "# T\n\nIn uscita:\n  (nessuno)\n\nIn entrata:\n  Topics: A");
  assert.equal(pathReport(vault, "Mario Rossi", "T", false), "Mario Rossi ←Authors— A —Topics→ T\n(2 passi)");
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
      { id: "R5", question: "articles", op: "articles", author: "Mario Rossi", topic: "T", expect: ["A"] },
      { id: "R6", question: "wrong", op: "field", note: "A", field: "Topics", expect: ["Other"] },
    ],
  });
  assert.deepEqual(results.map((result) => result.ok), [true, true, true, false, true, false]);
});

test("the briefing lists what comes next, what is late and the log", () => {
  const today = "2026-10-26";
  const text = briefing(vault, schema, lint(vault, schema, today), today);
  assert.match(text, /## Next 30 days\n\n- 2026-11-01 · due · \[\[Soon\]\]/);
  assert.match(text, /## Overdue\n\n- 2026-01-01 · due · \[\[Late\]\]/);
  assert.match(text, /## Open tasks\n\n- \[\[Soon\]\] · High · 2026-11-01\n- \[\[Late\]\] · 2026-01-01/);
  assert.match(text, /Inbox items to sort: 1\./);
  assert.match(text, /## Latest log entries\n\n- 2026-10-26 · edit \| first/);
});
