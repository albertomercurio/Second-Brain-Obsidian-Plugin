# Second Brain for Obsidian

Checks an Obsidian vault against a schema of note types and reads its links as typed relations.

- **Lint**: property names and values against the schema, broken and ambiguous links, duplicates, dates in the wrong order or passed, notes nobody links to, text that looks like an instruction to an AI agent. Errors and warnings stay in the status bar, updated after every change; a click lists them.
- **Typed relations**: a link in the property `Collaborators` is a `Collaborators` relation, and the reverse one is computed, never written. `links` groups a note's links by relation, `path` finds the shortest chain between two notes, `neighbors` lists the notes within N steps.
- **Templates**: note templates and Obsidian property types are generated from the schema; `conform` gives a note the properties of its template, in order.
- **Renames**: after a rename in Obsidian, Bases views, the schema and the settings follow.
- **Briefing**: a one-page starting context for AI agents, kept current.
- **Calendar** (Obsidian for Mac): add the event a note describes to the calendar, or make a note from an event, through a local helper that holds the calendar permission.

Links come from Obsidian's own index, resolved as Obsidian resolves them.

## Settings

| Setting | Default | |
| --- | --- | --- |
| Schema file | `Second Brain/schema.yaml` | The schema below. Without it, only the checks that need no schema run |
| Type property | `type` | The property that holds the type of a note |
| Ignored folders | none | Left out of checks, links and counts, one per line |
| Templates folder | `Second Brain/Templates` | Written by `templates`; always ignored |
| Briefing file | `Second Brain/briefing.md` | Rewritten after every change; always ignored. Empty: no briefing |
| Log file | `Second Brain/log.md` | `conform` adds an entry `## [YYYY-MM-DD] conform \| …`; the latest five go in the briefing |
| Recall tests file | `Second Brain/recall.yaml` | See below |
| Calendar helper socket | none | Unix socket of the calendar helper (see Calendar); `~` is the home folder. Empty: no calendar commands |

## The schema

A YAML file. Everything is optional except `types`.

```yaml
content_folders: [Notes, Library]   # every note inside must have a type
free_folders: [Inbox]               # capture: no type needed; checked for suspicious text
kind_property: kind                 # selects kind templates and fields reserved to a kind

common:                             # fields and requirements of every type
  required: [type]
  fields:
    aliases: {kind: "list[string]"}

types:
  Person:
    folder: Notes/People            # notes of the type belong here
    template: [given, family, orcid, affiliations]   # properties of every note, in order
    required: [family]
    person_name: [given, family]    # "A. Lovelace" and "Ada Lovelace" may be the same person
    expect_backlinks: true          # report a person no note links to
    fields:
      given: {kind: string}
      family: {kind: string}
      orcid: {kind: orcid, unique: true}             # two people never share it
      affiliations: {kind: "list[link]", target: [Organization]}
    body: |
      ## Notes

  Paper:
    folder: Library/Papers
    fields:
      title: {kind: string, unique: similar}         # same title, ignoring case and punctuation: a warning,
                                                     # unless one paper links to the other
      doi: {kind: doi, unique: true}

  Task:
    folder: Notes/Tasks
    closed: {done: true}            # out of the agenda, never overdue
    briefing: [priority, due]       # open tasks listed in the briefing, sorted by these
    fields:
      done: {kind: bool}
      priority: {kind: enum, values: [High, Medium, Low]}
      due: {kind: date, deadline: true, agenda: due}  # overdue once passed while open; in the agenda

  Project:
    folder: Notes/Projects
    kind_templates:                 # a template for each value of the kind property
      Grant: [kind, status, funder, start, end]
    open: {status: [Active, Submitted]}              # without it: every note that is not closed
    closed: {status: [Done, Rejected]}
    stale_after: 180                # report open projects nobody modified for 180 days
    fields:
      kind: {kind: enum, values: [Research, Grant]}
      status: {kind: enum, values: [Idea, Active, Submitted, Done, Rejected]}
      funder: {kind: link, target: [Organization], kinds: [Grant]}   # only for grants
      start: {kind: date}
      end: {kind: date, after: start, deadline: true, agenda: ends}  # never before start; with times, after it
```

**Field kinds**: `string`, `text`, `int`, `number`, `bool` (checkbox), `date` (YYYY-MM-DD), `datetime` (YYYY-MM-DD or YYYY-MM-DDTHH:mm; Obsidian's date and time), `url`, `doi`, `orcid`, `enum` (with `values`), `link` (`"[[Note]]"`, with the allowed types in `target`), and `list[…]` of any of them. A field can be written as just its kind: `title: string`.

**Rules of a type**: `open` and `closed` are conditions, property → value or list of values; a note matches when any of the properties has one of the values. `agenda` puts a date in the briefing's next 30 days, with the label given (`true`: the property's name). `calendar` names the properties of the calendar commands (see Calendar). `name_date` names a date property whose day ends every note's name, in parentheses: `Meeting with Ada (2026-11-10)`; titles repeat, the day keeps names unique.

**Codes**. Problems that follow a rule of the schema start with the type in lowercase with dashes: `person-duplicate`, `task-overdue`, `project-stale`, `event-name-date`. The others: `yaml-invalid`, `type-missing`, `type-unknown`, `folder-mismatch`, `field-required`, `field-unknown`, `field-kind`, `field-for-kind`, `datetime-midnight` (00:00, which Obsidian's date-and-time field writes when only the day is edited), `date-order`, `link-broken`, `link-unquoted`, `link-ambiguous`, `link-target-type`, `name-duplicate`, `alias-collision`, `isolated`, `no-backlinks`, `injection-suspect`, `templater-command`, `filename-chars`, `file-large`, `file-too-large`, `base-link-broken`, `base-folder-broken`, `schema-missing`, `schema-invalid`.

## Recall tests

Questions with a known answer, solved only through the links: they tell whether the vault stays reachable.

```yaml
checks:
  - id: R1
    question: Who funds the project?
    op: field                 # the notes a property links to
    note: My Project
    field: funder
    expect: [Some Agency]
  - id: R2
    question: Who works on it?
    op: incoming              # the notes linking here, through `field` if given
    note: My Project
    field: projects
    expect: [Ada Lovelace]
  - id: R3
    question: How is Ada linked to the agency?
    op: path                  # the shortest chain, at most max_length notes
    from: Ada Lovelace
    to: Some Agency
    expect: [My Project]
    max_length: 3
  - id: R4
    question: Ada's papers on engines?
    op: notes                 # notes of `type` whose properties link to all of these
    type: Paper
    links: {authors: Ada Lovelace, topics: Engines}
    expect: [Sketch of the Analytical Engine]
```

## Commands

In the palette: *Check the vault*, *Conform this note to its template*; on the Mac, with the calendar helper, *Add this event to the calendar*, *New note from a calendar event*, *Open this event in the calendar*.

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

## Calendar

The calendar commands need Obsidian for Mac and a local helper that reads and writes the calendar: the plugin itself never touches it. One type of the schema mirrors events, named by its `calendar` rule:

```yaml
  Event:
    folder: Events
    name_date: Date             # notes named "Title (YYYY-MM-DD)"
    calendar:
      start: Date               # required: date, or date and time (kind datetime)
      end: End Date             # for a whole-day event, the last day
      location: Location
      participants: Participants  # links to the people taking part
      email: Email              # property of those notes with their addresses
      link: Calendar Event      # required: the link that opens the event in the calendar
      kind: Meeting             # kind of the notes made from events
```

- *Add this event to the calendar*, on a note of that type: shows the event (title from the note's name without the day, start and end, location) and the calendar to use, then creates it, or updates the one in `link`, and writes the link in the note. It never invites anyone.
- *New note from a calendar event*: lists the events of the last week and of the next two, nearest first; for the one chosen, makes a note in the type's folder, named `Title (YYYY-MM-DD)` when the type has `name_date`, with the template's properties, the people whose address a note knows, and the other addresses in the text. When the event already has a note, opens it. Text from the calendar loses Templater tags and wikilink brackets.
- *Open this event in the calendar*: opens the note's `link`.

The helper answers on a Unix socket, one JSON line each way: `{"tool": "…", "arguments": {…}}` → `{"ok": true, "result": …}` or `{"ok": false, "error": "…"}`. The commands use `health` (`accounts`: `role` and, when found, `source`), `list_events` (`from`, `to`, `limit` → `events`), `create_event` (`account`, `title`, `start`, `end`, `all_day`, `location`, `url`) and `update_event` (`id` and the same fields). An event has `id`, `title`, `start` and `end` (ISO 8601 with the computer's offset; for a whole day, YYYY-MM-DD with the last day included), `all_day`, `location`, `account`, `organizer` and `attendees` (`email`, `me`), and `link` (`ical://ekevent/<id>?…`, which macOS Calendar opens). The helper decides what may be written; the plugin only asks.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build                 # dist/main.js; with VAULT_PLUGIN_DIR=<vault>/.obsidian/plugins/second-brain, also installed there
```

`src/` holds the logic and knows nothing of Obsidian: it receives the vault as an index with links already resolved, which `main.ts` builds from Obsidian's metadata cache and the tests from fixtures. The calendar client gets Node's `net` from `main.ts`, which loads it only on the Mac, so the plugin still loads on mobile. A vault is checked inside Obsidian: status bar, *Check the vault*, `obsidian-cli second-brain:lint`. MIT license.
