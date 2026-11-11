import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { lint, slug } from "../src/lint";
import { Schema } from "../src/schema";
import fixture from "./fixtures/lint-vault.json";
import { note, schema, vaultOf } from "./helpers";

const issuesOf = (files: Record<string, string>, today = "2026-10-26", s = schema) => lint(vaultOf(files), s, today);
const codes = (files: Record<string, string>, today?: string, s?: Schema) => issuesOf(files, today, s).map((issue) => issue.code);

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

test("a Templater command is an error anywhere but in the templates", () => {
  const command = "<%* tp.user.anything() %>";
  assert.ok(codes({ "Inbox/mail.md": `From an email: ${command}\n` }).includes("templater-command"));
  assert.ok(codes({ "Library/Articles/A.md": note(`Type: Article\nTitle: "${command}"`) }).includes("templater-command"));
  assert.ok(codes({ "2026-10-26_04_DOC.md": `About ${command}\n` }).includes("templater-command"));
  assert.ok(!codes({ "system/templates/Task.md": `${command}\n` }).includes("templater-command"));
});

test("hints: case of a property, aliases, similar names", () => {
  const issues = issuesOf({
    "Notes/Projects/Q.md": note("Type: Project\nKind: Research\nStatus: Idea\nstatus: x\nCollaboratrs: y", "[[M. Rossi]] [[Mario Rosi]]\n"),
    "Notes/People/Mario Rossi.md": note("Type: Person\nAliases:\n  - M. Rossi"),
  });
  const hint = (message: string) => issues.find((issue) => issue.message.includes(message))?.hint;
  assert.equal(hint(": status"), 'write "Status"');
  assert.equal(hint("Collaboratrs"), 'maybe "Collaborators"?');
  assert.match(hint("body: M. Rossi")!, /an alias of "Mario Rossi"/);
  assert.equal(hint("body: Mario Rosi"), 'maybe "Mario Rossi"?');
});

test("a link in a property is reported on its line", () => {
  const issues = issuesOf({ "Notes/Projects/P.md": note('Type: Project\nKind: Research\nStatus: Idea\nCollaborators:\n  - "[[Nobody]]"') });
  assert.deepEqual(issues.filter((issue) => issue.code === "link-broken").map((issue) => [issue.line, issue.message]), [[6, "link without a destination in property Collaborators: Nobody"]]);
});

test("open notes untouched for longer than stale_after are reported", () => {
  const files = { "Notes/Projects/P.md": note("Type: Project\nKind: Research\nStatus: In Progress") };
  assert.ok(!codes(files).includes("project-stale"));
  assert.ok(codes(files, "2027-10-26").includes("project-stale"));
  assert.ok(!codes({ "Notes/Projects/P.md": note("Type: Project\nKind: Research\nStatus: Completed") }, "2027-10-26").includes("project-stale"));
});

test("a deadline passed is overdue while the note is open, and not once it is closed", () => {
  const task = (done: string) => ({ "Tasks/T.md": note(`Type: Task\nDone: ${done}\nDue Date: 2026-01-01`) });
  const overdue = issuesOf(task("false")).find((issue) => issue.code === "task-overdue")!;
  assert.equal(overdue.message, "Due Date passed on 2026-01-01");
  assert.equal(overdue.hint, "if it is done, set Done: true");
  assert.ok(!codes(task("true")).includes("task-overdue"));
  const project = (status: string) => ({ "Notes/Projects/P.md": note(`Type: Project\nKind: Grant\nStatus: ${status}\nEnd: 2026-01-01`) });
  assert.equal(issuesOf(project("In Progress")).find((issue) => issue.code === "project-overdue")?.message, "End passed on 2026-01-01, but Status is still In Progress");
  assert.ok(!codes(project("Completed")).includes("project-overdue"));
  assert.ok(!codes(project("On Hold")).includes("project-overdue"), "neither open nor closed");
});

test("a date before the one it must follow is an error", () => {
  assert.ok(codes({ "Notes/Roles/R.md": note("Type: Role\nStart: 2026-02-01\nEnd: 2026-01-01") }).includes("date-order"));
  assert.ok(!codes({ "Notes/Roles/R.md": note("Type: Role\nStart: 2026-01-01\nEnd: 2026-02-01") }).includes("date-order"));
});

test("on the same day, a time before or equal to the one it must follow is an error", () => {
  const event = (start: string, end: string) => codes({ "Records/M (2026-11-08).md": note(`Type: Event\nKind: Meeting\nDate: ${start}\nEnd Date: ${end}`) });
  assert.ok(event("2026-11-08T12:30", "2026-11-08T12:15").includes("date-order"));
  assert.ok(event("2026-11-08T12:30:00", "2026-11-08T12:30").includes("date-order"));
  assert.ok(!event("2026-11-08T12:30", "2026-11-08T12:45:00").includes("date-order"));
  assert.ok(!event("2026-11-08T23:30", "2026-11-09T00:30").includes("date-order"));
  assert.ok(!event("2026-11-08T12:30", "2026-11-08").includes("date-order"));
});

test("a typed note with no links in either direction is isolated", () => {
  const vault = vaultOf({ "Notes/Ideas/Alone.md": note("Type: Idea") });
  const isolated = lint(vault, schema, "2026-11-04").filter((issue) => issue.code === "isolated").map((issue) => issue.path);
  assert.deepEqual(isolated, ["Notes/Ideas/Alone.md"]);
});

test("a recommended property left empty is a warning", () => {
  const rules = new Schema(parse("types:\n  Article:\n    recommended: [PDF]\n    fields:\n      PDF: {kind: \"list[link]\"}"), "Type");
  const vault = vaultOf({
    "Notes/With.md": note('Type: Article\nPDF:\n  - "[[with.pdf]]"'),
    "Notes/Without.md": note("Type: Article\nPDF:"),
    "Files/with.pdf": "",
  });
  const issues = lint(vault, rules, "2026-11-11").filter((issue) => issue.code === "field-recommended");
  assert.deepEqual(issues.map((issue) => [issue.severity, issue.path, issue.message]), [["warning", "Notes/Without.md", "PDF is empty"]]);
});

test("a file in an attachment folder that no note links or embeds is unlinked", () => {
  const rules = new Schema(parse("attachment_folders: [Files]\ntypes: {}"), "Type");
  const vault = vaultOf({
    "Notes/Paper.md": note('Type: Article\nPDF:\n  - "[[paper.pdf]]"', "![[figure.png]]"),
    "Files/paper.pdf": "",
    "Files/figure.png": "",
    "Files/Inbox/forgotten.png": "",
    "Data/daily.jsonl": "",
  });
  const unlinked = lint(vault, rules, "2026-11-11").filter((issue) => issue.code === "file-unlinked").map((issue) => issue.path);
  assert.deepEqual(unlinked, ["Files/Inbox/forgotten.png"]);
  assert.deepEqual(lint(vault, schema, "2026-11-11").filter((issue) => issue.code === "file-unlinked"), [], "without attachment folders, no check");
});

test("duplicates: shared identifiers are errors, similar titles and names warnings", () => {
  const rules = new Schema(
    parse(`
types:
  Paper:
    fields:
      Title: {unique: similar}
      DOI: {unique: true}
      Version Of: {kind: link}
  Peer Review:
    person_name: [Given, Family]
    fields:
      ID: {unique: true}
`),
    "Type"
  );
  const issues = issuesOf(
    {
      "P/A.md": note("Type: Paper\nTitle: A Study\nDOI: 10.1/X"),
      "P/B.md": note("Type: Paper\nTitle: a study!\nDOI: 10.1/x"),
      "P/C.md": note("Type: Paper\nTitle: Other"),
      "P/D.md": note('Type: Paper\nTitle: Other\nVersion Of: "[[C]]"'),
      "R/Ada Lovelace.md": note("Type: Peer Review\nGiven: Ada\nFamily: Lovelace"),
      "R/A Lovelace.md": note("Type: Peer Review\nGiven: A.\nFamily: Lovelace"),
      "R/Ada King.md": note("Type: Peer Review\nGiven: Ada\nFamily: King\nID: 1"),
      "R/A. King.md": note("Type: Peer Review\nID: 2"),
    },
    "2026-10-26",
    rules
  ).filter((issue) => issue.code.endsWith("-duplicate"));
  assert.deepEqual(
    issues.map((issue) => [issue.severity, issue.code, issue.path]),
    [
      ["error", "paper-duplicate", "P/B.md"],
      ["warning", "paper-duplicate", "P/B.md"],
      ["warning", "peer-review-duplicate", "R/Ada Lovelace.md"],
    ]
  );
});

test("types become codes in lowercase with dashes", () => {
  assert.equal(slug("Peer Review"), "peer-review");
  assert.equal(slug("Task"), "task");
});

test("without a schema, the checks that need none still run", () => {
  const empty = new Schema(null, "type");
  assert.deepEqual(codes({ "a.md": "[[Nowhere]]\n" }, "2026-10-26", empty), ["link-broken"]);
});

test("a dated name ends with the day of its property", () => {
  const event = (date: string) => note(`Type: Event\nKind: Meeting\nDate: ${date}`);
  const issues = issuesOf({
    "Records/Sync (2026-05-14).md": event("2026-05-14T10:00"),
    "Records/2026-05-14 Old style.md": event("2026-05-14"),
    "Records/Wrong day (2026-05-13).md": event("2026-05-14"),
  }).filter((issue) => issue.code === "event-name-date");
  assert.deepEqual(
    issues.map((issue) => [issue.path, issue.hint]),
    [
      ["Records/2026-05-14 Old style.md", 'rename it "Old style (2026-05-14)"'],
      ["Records/Wrong day (2026-05-13).md", 'rename it "Wrong day (2026-05-14)"'],
    ]
  );
});

test("a date and time at 00:00 is probably a whole day", () => {
  const issues = issuesOf({
    "Records/Party (2026-05-14).md": note("Type: Event\nKind: Other\nDate: 2026-05-14T00:00"),
    "Records/Night shift (2026-05-15).md": note("Type: Event\nKind: Other\nDate: 2026-05-15T00:30"),
  }).filter((issue) => issue.code === "datetime-midnight");
  assert.deepEqual(issues.map((issue) => [issue.path, issue.hint]), [["Records/Party (2026-05-14).md", "for a whole day, keep only the day: 2026-05-14"]]);
});
