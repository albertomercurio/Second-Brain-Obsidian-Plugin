import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { renderNote } from "../src/frontmatter";
import fixture from "./fixtures/frontmatter-style.json";

fixture.cases.forEach((c, i) => {
  test(`frontmatter case ${i + 1} keeps the layout of the vault and reads back the same`, () => {
    assert.equal(renderNote(c.meta, ""), c.yaml);
    assert.deepEqual(parse(c.yaml.replace(/^---\n|---\n$/g, "")), c.meta);
  });
});
