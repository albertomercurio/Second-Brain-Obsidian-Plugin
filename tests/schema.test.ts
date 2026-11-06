import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { checkValue, type Field, Schema } from "../src/schema";
import { schema } from "./helpers";

const field = (kind: string, extra: Partial<Field> = {}): Field => ({ name: "F", kind, values: [], target: [], kinds: [], unique: false, after: null, deadline: false, agenda: null, ...extra });

test("conform: template properties in order, other properties kept after them", () => {
  const next = schema.conform({ Type: "Person", Website: "https://x.org", "Last Name": "Kono", "First Name": "Shingo" })!;
  assert.deepEqual(Object.keys(next), ["Type", "First Name", "Last Name", "ORCID", "Email", "Affiliations", "Relationship", "Website"]);
  assert.equal(next["Last Name"], "Kono");
  assert.equal(schema.conform(next), null, "conforming twice changes nothing");
});

test("conform follows the Kind of a project; checkboxes start unchecked", () => {
  assert.ok("Funder" in schema.conform({ Type: "Project", Kind: "Grant" })!);
  assert.ok(!("Funder" in schema.conform({ Type: "Project", Kind: "Research" })!));
  assert.equal(schema.conform({ Type: "Task" })!.Done, false);
  assert.equal(schema.conform({ Type: "Unknown" }), null);
});

test("values are checked against their kind", () => {
  assert.deepEqual(checkValue(field("int"), 2023), []);
  assert.deepEqual(checkValue(field("int"), "2023"), ["expected a whole number"]);
  assert.deepEqual(checkValue(field("date"), "2026-10-26"), []);
  assert.deepEqual(checkValue(field("date"), "2026-13-01"), ["expected a date YYYY-MM-DD"]);
  assert.deepEqual(checkValue(field("bool"), "no"), ["expected true or false (checkbox)"]);
  assert.deepEqual(checkValue(field("list[link]"), ["[[A]]"]), []);
  assert.deepEqual(checkValue(field("list[link]"), "[[A]]"), ["should be a list (list[link])"]);
  assert.match(checkValue(field("enum", { values: ["High"] }), "Urgent")[0], /not allowed: High/);
  assert.deepEqual(checkValue(field("orcid"), null), [], "an empty property is fine");
});

test("the type and kind properties come from the settings and the schema", () => {
  const own = new Schema(parse("kind_property: category\ntypes:\n  Book:\n    template: [title]\n    kind_templates:\n      Novel: [title, narrator]\n"), "type");
  assert.deepEqual(own.conform({ title: "T", type: "Book" }), { type: "Book", title: "T" });
  assert.deepEqual(Object.keys(own.conform({ type: "Book", category: "Novel" })!), ["type", "title", "narrator", "category"]);
  assert.equal(own.conform({ Type: "Book" }), null, "another property is not the type");
});

test("rules of a type: open and closed notes, deadlines, agenda labels", () => {
  const rules = new Schema(parse("types:\n  Job:\n    open: {State: [Doing, Waiting]}\n    closed: {State: Done, Archived: true}\n    fields:\n      Due: {kind: date, deadline: true, agenda: true}\n      Start: {kind: date, agenda: starts}\n"), "type");
  const job = rules.types.get("Job")!;
  assert.ok(rules.isOpen(job, { State: "Doing" }));
  assert.ok(!rules.isOpen(job, { State: "Idea" }));
  assert.ok(rules.isClosed(job, { State: "Done" }));
  assert.ok(rules.isClosed(job, { State: "Doing", Archived: true }), "any property of the condition closes it");
  assert.equal(job.fields.get("Due")!.agenda, "Due", "agenda: true uses the name of the property");
  assert.equal(job.fields.get("Start")!.agenda, "starts");
  assert.equal(new Schema({ types: { Note: {} } }, "type").isOpen(new Schema({ types: { Note: {} } }, "type").types.get("Note")!, {}), true, "without conditions every note is open");
});
