// Checks of a real vault, run only with VAULT=<vault folder>: no lint errors, every
// recall test passes, the templates are what the schema generates. The author's
// vault runs them on GitHub at every push, where Obsidian is not available.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { lint } from "../src/lint";
import { RECALL_FILE, SCHEMA_FILE, TEMPLATES_FOLDER } from "../src/paths";
import { runRecall } from "../src/recall";
import { Schema } from "../src/schema";
import { templateFiles } from "../src/templates";
import { localDate } from "../src/text";
import { vaultFromDisk } from "./helpers";

const root = process.env.VAULT;
const skip = root ? false : "set VAULT=<vault folder> to check a vault";
const read = (path: string) => readFileSync(join(root!, path), "utf8");
const schema = () => new Schema(parse(read(SCHEMA_FILE)));

test("the vault has no lint errors", { skip }, () => {
  const errors = lint(vaultFromDisk(root!), schema(), localDate()).filter((issue) => issue.severity === "error");
  assert.deepEqual(errors.map((issue) => `${issue.code} ${issue.path}:${issue.line} ${issue.message}`), []);
});

test("every recall test finds its answer", { skip }, () => {
  const results = runRecall(vaultFromDisk(root!), parse(read(RECALL_FILE)));
  assert.deepEqual(results.filter((result) => !result.ok).map((result) => `${result.id}: ${result.got.join(", ")}`), []);
});

test("the templates of the vault are what the schema generates", { skip }, () => {
  const generated = templateFiles(schema());
  const files = readdirSync(join(root!, TEMPLATES_FOLDER)).map((file) => file.replace(/\.md$/, ""));
  assert.deepEqual([...generated.keys()].sort(), files.sort());
  for (const [name, text] of generated) assert.equal(text, read(`${TEMPLATES_FOLDER}/${name}.md`), name);
});
