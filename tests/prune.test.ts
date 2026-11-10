import { test } from "node:test";
import assert from "node:assert/strict";
import { briefing } from "../src/briefing";
import { lint } from "../src/lint";
import { hasOwnText, linkText, pruneLine, prunePlan, pruneReport, unlinkBody, unlinkProperty } from "../src/prune";
import { note, schema, vaultOf } from "./helpers";

// The fixtures are modified on 2026-10-20; Task has prune_after: 90.
const LATER = "2027-02-01";
const task = (done: boolean, body = "## Details\n") => note(`Type: Task\nDone: ${done}\nPriority: Low`, body);
const files = {
  "Tasks/Done.md": task(true),
  "Tasks/Open.md": task(false),
  "Tasks/Written.md": task(true, "## Details\n\nThe reviewer asked for the code; it is in ![[Files/Images/mwe.png]].\n"),
  "Tasks/Cited.md": task(true),
  "Tasks/Waiting.md": note('Type: Task\nDone: false\nDepends On:\n  - "[[Cited]]"\n  - "[[Open]]"'),
  "Events/Meeting (2026-05-14).md": note("Type: Event\nKind: Meeting\nDate: 2026-05-14", "## Actions\n- [[Cited|Send the code]]\n- [[Done]] and [[Done]] again\n"),
  "Files/Images/mwe.png": "",
};

test("closed notes past prune_after are removed; open ones, recent ones and those with text of their own are not", () => {
  const vault = vaultOf(files);
  assert.deepEqual(prunePlan(vault, schema, "2026-12-01").remove, []);
  const plan = prunePlan(vault, schema, LATER);
  assert.deepEqual(plan.remove.map((p) => p.note.path), ["Tasks/Cited.md", "Tasks/Done.md"]);
  assert.deepEqual(plan.decide.map((p) => p.note.path), ["Tasks/Written.md"]);
  assert.equal(plan.remove[0].idle, 104);
});

test("the citations of a removed note, from notes that stay", () => {
  const plan = prunePlan(vaultOf(files), schema, LATER);
  const cited = plan.remove.find((p) => p.note.name === "Cited")!;
  assert.deepEqual(
    cited.citations.map((c) => [c.source, c.field, c.original]),
    [
      ["Events/Meeting (2026-05-14).md", null, "[[Cited|Send the code]]"],
      ["Tasks/Waiting.md", "Depends On", "[[Cited]]"],
    ]
  );
  assert.deepEqual(plan.decide[0].orphans, ["Files/Images/mwe.png"]);
});

test("a named note is removed now, with its text, if it is closed", () => {
  const vault = vaultOf(files);
  const plan = prunePlan(vault, schema, "2026-10-21", vault.get("Written"));
  assert.deepEqual([plan.remove.map((p) => p.note.name), plan.decide], [["Written"], []]);
  assert.deepEqual(plan.remove[0].orphans, ["Files/Images/mwe.png"]);
  assert.throws(() => prunePlan(vault, schema, LATER, vault.get("Open")), /not a closed note of a type with prune_after/);
  assert.throws(() => prunePlan(vault, schema, LATER, vault.get("Meeting (2026-05-14)")), /not a closed note/);
});

test("text of its own: anything but blank lines, headings and the lines of the template", () => {
  assert.equal(hasOwnText("## Details\n\n", "## Details\n"), false);
  assert.equal(hasOwnText("## Notes\n### Old heading\n", "## Details\n"), false);
  assert.equal(hasOwnText("![[Projects.base#Topic Projects]]\n", "![[Projects.base#Topic Projects]]\n"), false);
  assert.equal(hasOwnText("## Details\n- ask Ada\n", "## Details\n"), true);
});

test("a link in the body becomes its text and ✓; in a property it is taken out", () => {
  assert.equal(linkText("[[Cited|Send the code]]", "Cited"), "Send the code");
  assert.equal(linkText("[[Tasks/Cited#Details]]", "Cited"), "Cited");
  assert.equal(linkText("[the code](Tasks/Cited.md)", "Cited"), "the code");
  const text = files["Events/Meeting (2026-05-14).md"];
  const plan = prunePlan(vaultOf(files), schema, LATER);
  let next = text;
  for (const p of plan.remove) next = unlinkBody(next, p.citations.filter((c) => c.source.startsWith("Events/")), p.note.name);
  assert.equal(next, text.replace("[[Cited|Send the code]]", "Send the code ✓").replace("[[Done]] and [[Done]] again", "Done ✓ and Done ✓ again"));
  // A line that has moved: the link is found elsewhere in the body, never in the properties.
  const moved = note('Type: Event\nRelated: "[[Done]]"', "intro\n- [[Done]]\n");
  assert.equal(unlinkBody(moved, [{ source: "x", field: null, line: 2, original: "[[Done]]" }], "Done"), note('Type: Event\nRelated: "[[Done]]"', "intro\n- Done ✓\n"));
  const meta: Record<string, unknown> = { "Depends On": ["[[Cited]]", "[[Open]]"], Parent: "[[Cited]]", Blocks: ["[[Cited]]"], Other: "[[Open]]" };
  for (const field of ["Depends On", "Parent", "Blocks", "Other"]) unlinkProperty(meta, field, "[[Cited]]");
  assert.deepEqual(meta, { "Depends On": ["[[Open]]"], Parent: null, Blocks: null, Other: "[[Open]]" });
});

test("the report and the briefing", () => {
  const vault = vaultOf(files);
  const plan = prunePlan(vault, schema, LATER);
  const preview = pruneReport(plan, false, false);
  assert.match(preview, /^\? Tasks\/Cited\.md {2}\(Task, not modified for 104 days\)\n {4}Events\/Meeting \(2026-05-14\)\.md {2}body: link becomes text\n {4}Tasks\/Waiting\.md {2}Depends On: link taken out\n/);
  assert.match(preview, /! Tasks\/Written\.md .*\n {4}Files\/Images\/mwe\.png {2}left without links/);
  assert.match(preview, /2 notes closed and past their prune_after days to remove, 1 to decide\.\nPreview: no file written/);
  assert.equal(pruneLine(vault, schema, LATER), "To prune: 2, 1 with text of their own to decide (`obsidian-cli second-brain:prune`).");
  assert.match(briefing(vault, schema, lint(vault, schema, LATER), LATER), /- To prune: 2, 1 with text/);
  assert.equal(pruneLine(vault, schema, "2026-10-21"), "To prune: 0 (`obsidian-cli second-brain:prune`).");
});
