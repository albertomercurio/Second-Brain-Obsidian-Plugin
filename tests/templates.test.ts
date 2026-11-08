import { test } from "node:test";
import assert from "node:assert/strict";
import { Schema } from "../src/schema";
import { completeNew, propertyTypes, templateFiles } from "../src/templates";
import { note, schema } from "./helpers";

test("each type has a template: its properties in order, then its body", () => {
  const task = templateFiles(schema).get("Task")!;
  assert.match(task, /^---\nType: Task\nDone: false\nAssignees:\nPriority:\nDue Date:\nProjects:\n---\n## Details\n/);
});

test("property types come from the schema and keep the rest of the file", () => {
  const written = JSON.parse(propertyTypes(schema, { types: { Mine: "text", Aliases: "multitext" } }));
  assert.equal(written.types.Mine, "text");
  assert.equal(written.types.Aliases, undefined);
  assert.equal(written.types.aliases, "aliases");
  assert.equal(written.types.Read, "checkbox");
  assert.equal(written.types.Year, "number");
  assert.equal(written.types.Authors, "multitext");
});

test("a property Obsidian would show as a date in one type and as a date and time in another is a conflict", () => {
  assert.deepEqual(schema.typeConflicts(), []);
  const clash = new Schema(
    {
      types: {
        Event: { fields: { Date: { kind: "datetime" }, Topics: { kind: "list[link]" } } },
        Record: { fields: { Date: { kind: "date" }, Topics: { kind: "list[link]" } } },
        Therapy: { fields: { Date: { kind: "date" }, Dose: { kind: "string" } } },
      },
    },
    "Type"
  );
  assert.deepEqual(clash.typeConflicts(), ["Date: datetime in Event; date in Record, Therapy"]);
});

test("a new note with a type gets its template: properties in order, values kept, then the body", () => {
  const done = completeNew(note("Type: Task\nPriority: High"), schema)!;
  assert.match(done, /^---\nType: Task\nDone: false\nAssignees:\nPriority: High\nDue Date:\nProjects:\n---\n## Details\n/);
});

test("a new note follows the template of its kind", () => {
  const done = completeNew(note("Type: Project\nKind: Grant\nStatus: Drafting"), schema)!;
  assert.match(done, /^---\nType: Project\nKind: Grant\nStatus: Drafting\nProgramme:\nFunder:/);
});

test("notes with text, without a type or of an unknown type stay as they are", () => {
  assert.equal(completeNew(note("Type: Task", "Call Ada.\n"), schema), null);
  assert.equal(completeNew(note("Status: Drafting"), schema), null);
  assert.equal(completeNew(note("Type: Recipe"), schema), null);
  assert.equal(completeNew("", schema), null);
});
