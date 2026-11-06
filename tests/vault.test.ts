import { test } from "node:test";
import assert from "node:assert/strict";
import { Resolver } from "../src/vault";
import { note, vaultOf } from "./helpers";

test("wikilinks: display text, headings and embeds; code is left out", () => {
  const vault = vaultOf({
    "A.md": note("Type: Topic", "[[B|text]] [[B#Heading]] ![[B]] `[[Code]]`\n```\n[[Fence]]\n```\n[md](B.md) [web](https://x.org/a.md)\n"),
    "B.md": "b",
  });
  const links = vault.get("A").links;
  assert.deepEqual(links.map((link) => [link.target, link.kind]), [["B", "wikilink"], ["B", "wikilink"], ["B", "embed"], ["B.md", "markdown"]]);
  assert.ok(links.every((link) => link.resolved === "B.md"));
  assert.equal(links[3].line, 8);
});

test("a wikilink without quotes in the YAML is recognised as malformed", () => {
  const vault = vaultOf({ "A.md": note("Related:\n  - [[B]]\nOther: [[C]]"), "B.md": "", "C.md": "" });
  assert.deepEqual(vault.get("A").links.map((link) => [link.target, link.field, link.malformed]), [["B", "Related", true], ["C", "Other", true]]);
});

test("links resolve ignoring case, in NFC, and by partial path", () => {
  const resolver = new Resolver(["Notes/People/Muñoz.md", "Notes/x/QuantumToolbox.jl.md", "Views/Articles.base"]);
  const path = (target: string) => resolver.resolve(target, "a.md").path;
  assert.equal(path("MUÑOZ"), "Notes/People/Muñoz.md");
  assert.equal(path("Muñoz"), "Notes/People/Muñoz.md");
  assert.equal(path("quantumtoolbox.jl"), "Notes/x/QuantumToolbox.jl.md");
  assert.equal(path("People/Muñoz"), "Notes/People/Muñoz.md");
  assert.equal(path("Articles.base"), "Views/Articles.base");
  assert.equal(path("Nobody"), null);
});

test("a file name in NFD on disk resolves from a link in NFC", () => {
  const vault = vaultOf({ "Notes/Muñoz.md": note("Type: Person"), "T.md": note('Related:\n  - "[[Muñoz]]"') });
  assert.equal(vault.get("T").links[0].resolved, "Notes/Muñoz.md");
});

test("an ambiguous name picks the shallowest file and reports the others", () => {
  const { path, candidates } = new Resolver(["x/y/Same.md", "z/Same.md"]).resolve("Same", "a.md");
  assert.equal(path, "z/Same.md");
  assert.deepEqual(candidates, ["z/Same.md", "x/y/Same.md"]);
});

test("notes are found by name, alias or path; a missing one is an error", () => {
  const vault = vaultOf({ "N/Mario Rossi.md": note("Aliases:\n  - M. Rossi") });
  assert.equal(vault.get("m. rossi").path, "N/Mario Rossi.md");
  assert.equal(vault.get("N/Mario Rossi").path, "N/Mario Rossi.md");
  assert.throws(() => vault.get("Nobody"), /Nessuna nota/);
});
