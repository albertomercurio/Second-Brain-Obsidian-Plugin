import { test } from "node:test";
import assert from "node:assert/strict";
import { propertyTypes, templateFiles } from "../src/templates";
import { schema } from "./helpers";

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
