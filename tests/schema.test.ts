import { test } from "node:test";
import assert from "node:assert/strict";
import { checkValue, type Field } from "../src/schema";
import { schema } from "./helpers";

const field = (kind: string, extra: Partial<Field> = {}): Field => ({ name: "F", kind, values: [], target: [], kinds: [], ...extra });

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
  assert.deepEqual(checkValue(field("int"), "2023"), ["atteso un numero intero"]);
  assert.deepEqual(checkValue(field("date"), "2026-10-26"), []);
  assert.deepEqual(checkValue(field("date"), "2026-13-01"), ["attesa una data YYYY-MM-DD"]);
  assert.deepEqual(checkValue(field("bool"), "no"), ["atteso true o false (checkbox)"]);
  assert.deepEqual(checkValue(field("list[link]"), ["[[A]]"]), []);
  assert.deepEqual(checkValue(field("list[link]"), "[[A]]"), ["dovrebbe essere una lista (list[link])"]);
  assert.match(checkValue(field("enum", { values: ["High"] }), "Urgent")[0], /non ammesso: High/);
  assert.deepEqual(checkValue(field("orcid"), null), [], "an empty property is fine");
});
