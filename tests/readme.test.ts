// The examples of the README are what the plugin reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { lint } from "../src/lint";
import { runRecall } from "../src/recall";
import { Schema } from "../src/schema";
import { DEFAULT_SETTINGS } from "../src/settings";
import { Vault } from "../src/vault";
import { indexOf, note } from "./helpers";

const [schemaYaml, recallYaml] = [...readFileSync("README.md", "utf8").matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
const schema = new Schema(parse(schemaYaml), DEFAULT_SETTINGS.typeProperty);
const vaultOf = (files: Record<string, string>) => new Vault(indexOf(files), { typeProperty: DEFAULT_SETTINGS.typeProperty, parseYaml: parse });

test("the schema of the README", () => {
  assert.deepEqual([...schema.types.keys()], ["Person", "Paper", "Task", "Project"]);
  const vault = vaultOf({
    "Notes/People/Ada Lovelace.md": note("type: Person\ngiven: Ada\nfamily: Lovelace"),
    "Notes/People/A Lovelace.md": note("type: Person\ngiven: A.\nfamily: Lovelace"),
    "Notes/Tasks/Write.md": note("type: Task\ndone: false\ndue: 2026-01-01"),
    "Notes/Projects/P.md": note('type: Project\nkind: Research\nstatus: Active\nfunder: "[[Ada Lovelace]]"\nstart: 2026-02-01\nend: 2026-01-01'),
  });
  const codes = lint(vault, schema, "2026-10-26").map((issue) => `${issue.code} ${issue.path}`);
  for (const expected of [
    "person-duplicate Notes/People/Ada Lovelace.md",
    "task-overdue Notes/Tasks/Write.md",
    "project-overdue Notes/Projects/P.md",
    "date-order Notes/Projects/P.md",
    "field-for-kind Notes/Projects/P.md",
    "link-target-type Notes/Projects/P.md",
  ]) {
    assert.ok(codes.includes(expected), expected);
  }
});

test("the recall tests of the README", () => {
  const vault = vaultOf({
    "Notes/My Project.md": note('type: Project\nfunder: "[[Some Agency]]"'),
    "Notes/Some Agency.md": note("type: Organization"),
    "Notes/Ada Lovelace.md": note('type: Person\nprojects:\n  - "[[My Project]]"'),
    "Notes/Engines.md": note("type: Topic"),
    "Notes/Sketch of the Analytical Engine.md": note('type: Paper\nauthors:\n  - "[[Ada Lovelace]]"\ntopics:\n  - "[[Engines]]"'),
  });
  assert.deepEqual(runRecall(vault, parse(recallYaml)).map((result) => result.ok), [true, true, true, true]);
});
