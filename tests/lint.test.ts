import { test } from "node:test";
import assert from "node:assert/strict";
import { lint } from "../src/lint";
import fixture from "./fixtures/lint-vault.json";
import { note, schema, vaultOf } from "./helpers";

const issuesOf = (files: Record<string, string>) => lint(vaultOf(files), schema, "2026-10-26");
const codes = (files: Record<string, string>) => issuesOf(files).map((issue) => issue.code);

test("an archive full of mistakes: every problem, and only those", () => {
  const found = [...new Set(lint(vaultOf(fixture.files), schema, fixture.today).map((issue) => `${issue.code} ${issue.path}`))].sort();
  assert.deepEqual(found, fixture.expected);
});

test("a clean note has no problems", () => {
  const issues = issuesOf({
    "Notes/People/Mario Rossi.md": note("Type: Person\nFirst Name: Mario\nLast Name: Rossi"),
    "Notes/Projects/P.md": note('Type: Project\nKind: Research\nStatus: Idea\nCollaborators:\n  - "[[Mario Rossi]]"'),
  });
  assert.deepEqual(issues.filter((issue) => issue.severity !== "info"), []);
});

test("an impossible date is a mistake in the note, not a crash", () => {
  assert.ok(codes({ "Tasks/T.md": note("Type: Task\nDue Date: 2020-02-30") }).includes("field-kind"));
});

test("a Templater command in content is an error: it would run when the file is created", () => {
  const command = "<%* tp.user.anything() %>";
  assert.ok(codes({ "Inbox/mail.md": `From an email: ${command}\n` }).includes("templater-command"));
  assert.ok(codes({ "Library/Articles/A.md": note(`Type: Article\nTitle: "${command}"`) }).includes("templater-command"));
  assert.ok(codes({ "2026-10-26_04_DOC.md": `About ${command}\n` }).includes("templater-command"));
  assert.ok(!codes({ "system/guides/g.md": `How to write ${command}\n` }).includes("templater-command"));
});

test("hints: case of a property, aliases, similar names", () => {
  const issues = issuesOf({
    "Notes/Projects/Q.md": note("Type: Project\nKind: Research\nStatus: Idea\nstatus: x\nCollaboratrs: y", "[[M. Rossi]] [[Mario Rosi]]\n"),
    "Notes/People/Mario Rossi.md": note("Type: Person\nAliases:\n  - M. Rossi"),
  });
  const hint = (message: string) => issues.find((issue) => issue.message.includes(message))?.hint;
  assert.equal(hint(": status"), "scrivi «Status»");
  assert.equal(hint("Collaboratrs"), "forse «Collaborators»?");
  assert.match(hint("corpo: M. Rossi")!, /è un alias di «Mario Rossi»/);
  assert.equal(hint("corpo: Mario Rosi"), "forse «Mario Rossi»?");
});

test("large collaborations: only the first author needs to be linked", () => {
  const authors = Array.from({ length: 30 }, (_, i) => `Family${i}, A`).join(" and ");
  const entry = `@article{K,\n    author = {${authors}},\n  }`;
  const files = {
    "Notes/People/Family0.md": note("Type: Person\nLast Name: Family0"),
    "Library/Articles/A.md": note(`Type: Article\nTitle: T\nAuthors:\n  - "[[Family0]]"\nBibTeX: |-\n  ${entry}`),
  };
  assert.ok(!codes(files).includes("reference-mismatch"));
});

test("recently modified projects are not stale, old ones are", () => {
  const files = { "Notes/Projects/P.md": note("Type: Project\nKind: Research\nStatus: In Progress") };
  assert.ok(!codes(files).includes("project-stale"));
  assert.ok(lint(vaultOf(files), schema, "2027-10-26").some((issue) => issue.code === "project-stale"));
});

test("a typed note with no links in either direction is isolated", () => {
  const vault = vaultOf({ "Notes/Ideas/Alone.md": note("Type: Idea") });
  const isolated = lint(vault, schema, "2026-11-04").filter((issue) => issue.code === "isolated").map((issue) => issue.path);
  assert.deepEqual(isolated, ["Notes/Ideas/Alone.md"]);
});

test("compound surnames split differently by the source are not a mismatch; another surname is", () => {
  const article = (family: string) => note(`Type: Article\nTitle: T\nAuthors:\n  - "[[Anton Frisk Kockum]]"\nBibTeX: |-\n  @article{K2017T,\n    author = {${family}, Anton},\n    title = {T},\n  }`);
  const person = note("Type: Person\nFirst Name: Anton\nLast Name: Frisk Kockum");
  const codes = (family: string) => lint(vaultOf({ "Notes/People/Anton Frisk Kockum.md": person, "Library/Articles/A.md": article(family) }), schema, "2026-11-04").map((issue) => issue.code);
  assert.ok(!codes("Kockum").includes("reference-mismatch"));
  assert.ok(codes("Rossi").includes("reference-mismatch"));
});
