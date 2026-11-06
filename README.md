# Second Brain for Obsidian

Checks an Obsidian vault against a schema of note types and reads its links as typed relations.

- **Lint**: property names and values against the schema, broken links, duplicate people and articles, impossible dates, BibTeX that disagrees with the note, text that looks like an instruction to an AI agent. Errors and warnings stay in the status bar, updated after every change.
- **Typed relations**: a link in the property `Collaborators` is a `Collaborators` relation, and the reverse one is computed, never written. `links` groups a note's links by relation, `path` finds the shortest chain between two notes, `neighbors` lists the notes within N steps.
- **Templates**: note templates and Obsidian property types are generated from the schema; `conform` gives a note the properties of its template, in order.
- **Renames**: after a rename, Bases views, the schema and settings follow.
- **Briefing**: a one-page starting context for AI agents, kept current.

## Commands

In the palette: *Check the vault*, *Conform this note to its template*.

In Obsidian's command line (Obsidian 1.12.2 or later, app open):

```sh
obsidian-cli second-brain:lint [all] [format=json]
obsidian-cli second-brain:links file="Note" [format=json]
obsidian-cli second-brain:path from="A" to="B" [all]
obsidian-cli second-brain:neighbors file="Note" [depth=2]
obsidian-cli second-brain:conform [file="Note"] [apply]
obsidian-cli second-brain:templates
obsidian-cli second-brain:briefing
obsidian-cli second-brain:recall
```

## Status

Built for the author's vault: it reads the schema from `system/schemas/schema.yaml`, expects a `Type` property, and some checks and all messages (in Italian) follow that vault. A configurable version is planned.

## Development

```sh
npm ci
npm test                      # unit tests
VAULT=<vault> npm test        # also checks a real vault: lint, recall tests, templates
npm run typecheck
VAULT_PLUGIN_DIR=<vault>/.obsidian/plugins/second-brain npm run build
obsidian-cli plugin:reload id=second-brain
```

`src/` holds the logic, without Obsidian; `main.ts` connects it to Obsidian. MIT license.
