import { test } from "node:test";
import assert from "node:assert/strict";
import { updateSchema, updateSettings, updateView } from "../src/references";
import { lint } from "../src/lint";
import { note, schema, vaultOf } from "./helpers";

test("renaming a note updates link() and file() in a view", () => {
  const view = 'filters:\n  and:\n    - Authors.contains(link("Old Name"))\n    - file.path == file("Notes/People/Old Name.md")\n    - Authors.contains(link("Old Name Jr"))\n    - Title == "Old Name"\n';
  assert.equal(
    updateView(view, "Notes/People/Old Name.md", "Notes/People/New Name.md", false),
    'filters:\n  and:\n    - Authors.contains(link("New Name"))\n    - file.path == file("Notes/People/New Name.md")\n    - Authors.contains(link("Old Name Jr"))\n    - Title == "Old Name"\n'
  );
});

test("renaming a folder updates inFolder() and paths below it, and nothing else", () => {
  const view = 'filters:\n  and:\n    - file.inFolder("Notes/People")\n    - file.inFolder("Notes/People/Sub")\n    - file.inFolder("Notes/Peoples")\n    - Kind == "Notes/People"\n';
  assert.equal(
    updateView(view, "Notes/People", "Notes/Humans", true),
    'filters:\n  and:\n    - file.inFolder("Notes/Humans")\n    - file.inFolder("Notes/Humans/Sub")\n    - file.inFolder("Notes/Peoples")\n    - Kind == "Notes/People"\n'
  );
});

test("renaming a folder updates the schema", () => {
  const text = "content_folders: [Notes, Library, Records, Tasks]\nfree_folders: [Inbox]\ntypes:\n  Person:\n    folder: Notes/People\n  Topic:\n    folder: Notes/Topics\n    description: Notes about Notes\n";
  assert.equal(
    updateSchema(text, "Notes", "Cards"),
    "content_folders: [Cards, Library, Records, Tasks]\nfree_folders: [Inbox]\ntypes:\n  Person:\n    folder: Cards/People\n  Topic:\n    folder: Cards/Topics\n    description: Notes about Notes\n"
  );
});

test("renaming a folder updates quoted paths in settings", () => {
  const text = '{"attachmentFolderPath":"Files/Inbox","newFileFolderPath":"Inbox","folder_templates":[{"folder":"Inbox2"}]}';
  assert.equal(updateSettings(text, "Inbox", "Capture"), '{"attachmentFolderPath":"Files/Inbox","newFileFolderPath":"Capture","folder_templates":[{"folder":"Inbox2"}]}');
  assert.equal(updateSettings(text, "Files", "Attachments"), '{"attachmentFolderPath":"Attachments/Inbox","newFileFolderPath":"Inbox","folder_templates":[{"folder":"Inbox2"}]}');
});

test("the lint reports a view filtering a folder that no longer exists", () => {
  const vault = vaultOf({
    "Views/A.base": 'filters:\n  and:\n    - file.inFolder("Notes/People")\n    - file.inFolder("Old Folder")\n',
    "Notes/People/P.md": note("Type: Person"),
  });
  const found = lint(vault, schema, "2026-11-04").filter((issue) => issue.code === "base-folder-broken");
  assert.deepEqual(found.map((issue) => issue.message), ['la vista filtra una cartella inesistente: inFolder("Old Folder")']);
});
