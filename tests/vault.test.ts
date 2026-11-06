import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { isIgnored, readSettings, renamedSettings, DEFAULT_SETTINGS } from "../src/settings";
import { Vault, type VaultIndex } from "../src/vault";
import { note, settings, vaultOf } from "./helpers";

/** An index as Obsidian gives it: links already resolved, properties with their key. */
const index: VaultIndex = {
  files: [
    {
      path: "Projects/P.md",
      size: 10,
      mtime: 0,
      text: '---\nType: Project\nCollaborators:\n  - "[[Ada]]"\n  - "[[Nobody]]"\nPeople.Lead: "[[Ada]]"\nOld:\n  - [[Ada]]\n---\nSee [[Ada|her]].\n',
      frontmatter: { Type: "Project", Collaborators: ["[[Ada]]", "[[Nobody]]"], "People.Lead": "[[Ada]]", Old: [[["Ada"]]] },
      aliases: [],
      links: [
        { target: "Ada", resolved: "People/Ada.md", key: "Collaborators.0", original: "[[Ada]]" },
        { target: "Nobody", resolved: null, key: "Collaborators.1", original: "[[Nobody]]" },
        { target: "Ada", resolved: "People/Ada.md", key: "People.Lead", original: "[[Ada]]" },
        { target: "Ada", resolved: "People/Ada.md", original: "[[Ada|her]]", line: 10 },
      ],
    },
    { path: "People/Ada.md", size: 10, mtime: 0, text: "---\nType: Person\n---\n", frontmatter: { Type: "Person" }, aliases: ["Countess"], links: [] },
    { path: "Other/Ada.md", size: 10, mtime: 0, text: "", frontmatter: null, aliases: [], links: [] },
  ],
  resolve: (target) => (target === "Ada" ? "People/Ada.md" : null),
};

test("links come from the index: property from the key, line from the text", () => {
  const vault = new Vault(index, { typeProperty: "Type", parseYaml: parse });
  const links = vault.get("Projects/P").links;
  assert.deepEqual(
    links.map((link) => [link.field, link.line, link.resolved]),
    [
      ["Collaborators", 4, "People/Ada.md"],
      ["Collaborators", 5, null],
      ["People.Lead", 4, "People/Ada.md"],
      [null, 10, "People/Ada.md"],
    ]
  );
  assert.deepEqual(links[0].candidates, ["Other/Ada.md", "People/Ada.md"], "two files named Ada");
  assert.deepEqual(vault.backlinks.get("People/Ada.md")!.map((link) => link.field), ["Collaborators", "People.Lead", null]);
});

test("a wikilink without quotes in the YAML is found in the text, not in the index", () => {
  const vault = new Vault(index, { typeProperty: "Type", parseYaml: parse });
  assert.deepEqual(vault.get("Projects/P").unquotedLinks, [{ target: "Ada", field: "Old", line: 8 }]);
});

test("frontmatter that is not valid YAML or not a map is an error, with no properties", () => {
  const vault = vaultOf({ "a.md": "---\nType: [oops\n---\n", "b.md": "---\n- x\n---\n", "c.md": note("Type: Topic") });
  assert.match(vault.get("a").frontmatterError!, /^invalid YAML/);
  assert.deepEqual(vault.get("a").meta, {});
  assert.equal(vault.get("b").frontmatterError, "the frontmatter is not a map of key: value");
  assert.equal(vault.get("c").type, "Topic");
});

test("notes are found by name, alias or path; a missing one is an error", () => {
  const vault = vaultOf({ "N/Mario Rossi.md": note("Aliases:\n  - M. Rossi") });
  assert.equal(vault.get("m. rossi").path, "N/Mario Rossi.md");
  assert.equal(vault.get("N/Mario Rossi").path, "N/Mario Rossi.md");
  assert.throws(() => vault.get("Nobody"), /No note found/);
});

test("ignored folders, templates and the briefing are left out, but links to them resolve", () => {
  const vault = vaultOf({
    "system/templates/Task.md": note("Type: Task"),
    "system/generated/briefing.md": "# Briefing",
    "system/tests/recall.yaml": "checks: []",
    "Notes/A.md": "[[Task]]",
  });
  assert.deepEqual([...vault.notes.keys()], ["Notes/A.md"]);
  assert.equal(vault.get("A").links[0].resolved, "system/templates/Task.md");
  assert.equal(vault.relationLinks(vault.get("A")).length, 0, "not a relation: the template is not a note of the vault");
  assert.ok(vault.hasFolder("system/tests"));
});

test("settings: defaults, ignored paths, renames", () => {
  assert.deepEqual(readSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings({ typeProperty: " Type ", ignoredFolders: ["/Archive/", 3], other: 1 }), { ...DEFAULT_SETTINGS, typeProperty: "Type", ignoredFolders: ["Archive"] });
  assert.ok(isIgnored("system/generated/x.md", settings));
  assert.ok(isIgnored(".obsidian/app.json", settings));
  assert.ok(!isIgnored("system/generatedx.md", settings));
  assert.ok(!isIgnored("system/log.md", settings));
  const renamed = renamedSettings(settings, "system", "meta")!;
  assert.equal(renamed.schemaFile, "meta/schemas/schema.yaml");
  assert.deepEqual(renamed.ignoredFolders, ["meta/generated", "meta/tests", "meta/hooks"]);
  assert.equal(renamedSettings(settings, "system/log.md", "system/journal.md")!.logFile, "system/journal.md");
  assert.equal(renamedSettings(settings, "Notes", "Cards"), null);
});
