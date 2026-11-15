# Second Brain for Obsidian

Checks an Obsidian vault against a schema of note types and reads its links as typed relations.

- **Lint**: property names and values against the schema, broken and ambiguous links, duplicates, dates in the wrong order or passed, notes nobody links to, text that looks like an instruction to an AI agent. Errors and warnings stay in the status bar, updated after every change; a click lists them.
- **Typed relations**: a link in the property `Collaborators` is a `Collaborators` relation, and the reverse one is computed, never written. `links` groups a note's links by relation, `path` finds the shortest chain between two notes, `neighbors` lists the notes within N steps.
- **Templates**: note templates and Obsidian property types are generated from the schema; a new note gets its template as soon as it has a type, wherever it is; `conform` gives a note the properties of its template, in order.
- **Renames**: after a rename in Obsidian, Bases views, the schema and the settings follow.
- **Cleanup**: `prune` removes closed notes nobody has modified for a while, such as old tasks done; where they are cited, the links become text.
- **Briefing**: a one-page starting context for AI agents, kept current.
- **Calendar** (Obsidian for Mac): add the event a note describes to the calendar, or make a note from an event, through a local helper that holds the calendar permission.
- **Health import** (Obsidian for desktop): reads the JSON exports of [Health Auto Export](https://www.healthyapps.dev) into JSON Lines files in the vault, ready for charts: days, workouts with their minutes and kilometre splits, running dynamics, heart-rate zones and training load.

Links come from Obsidian's own index, resolved as Obsidian resolves them.

## Settings

| Setting | Default | |
| --- | --- | --- |
| Schema file | `Second Brain/schema.yaml` | The schema below. Without it, only the checks that need no schema run |
| Type property | `type` | The property that holds the type of a note |
| Ignored folders | none | Left out of checks, links and counts, one per line |
| Templates folder | `Second Brain/Templates` | Written by `templates`; always ignored |
| Briefing file | `Second Brain/briefing.md` | Rewritten after every change; always ignored. Empty: no briefing |
| Log file | `Second Brain/log.md` | `conform` and `prune` add an entry `## [YYYY-MM-DD] conform \| …`; the latest five go in the briefing |
| Recall tests file | `Second Brain/recall.yaml` | See below |
| Complete new notes | on | A note created in Obsidian gets its template once it has a type (see New notes) |
| Calendar helper socket | none | Unix socket of the calendar helper (see Calendar); `~` is the home folder. Empty: no calendar commands |
| Health sources | none | One per line: a folder of Health Auto Export's exports, `->`, the vault folder for its data (see Health import) |
| Maximum heart rate | 0 | For heart-rate zones and training load; 0: the highest seen in a workout |
| Heart-rate zones | empty | The lowest heart rate of zones 2–5 in bpm, as a watch sets them (`132, 146, 159, 173`); empty: tenths of the heart-rate reserve |
| Sex | male | For the weighting of the training load |
| Import every (minutes) | 60 | Automatic imports while Obsidian is open; 0: only by command |

## The schema

A YAML file. Everything is optional except `types`.

```yaml
content_folders: [Notes, Library]   # every note inside must have a type
free_folders: [Inbox]               # capture: no type needed; checked for suspicious text
attachment_folders: [Files]         # every file inside should be linked by a note
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
    recommended: [orcid]            # empty: a warning, not an error
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
    prune_after: 90                 # prune removes tasks done and not modified for 90 days
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

**Rules of a type**: `open` and `closed` are conditions, property → value or list of values; a note matches when any of the properties has one of the values. `agenda` puts a date in the briefing's next 30 days, with the label given (`true`: the property's name). `calendar` names the properties of the calendar commands (see Calendar). `stale_after` and `prune_after` count days from the last modification of the file, which never comes before a note was closed: the count can start late, never early. `name_date` names a date property whose day ends every note's name, in parentheses: `Meeting with Ada (2026-11-10)`; titles repeat, the day keeps names unique.

**Codes**. Problems that follow a rule of the schema start with the type in lowercase with dashes: `person-duplicate`, `task-overdue`, `project-stale`, `event-name-date`. The others: `yaml-invalid`, `type-missing`, `type-unknown`, `folder-mismatch`, `field-required`, `field-recommended` (a property of `recommended` left empty), `field-unknown`, `field-kind`, `field-for-kind`, `datetime-midnight` (00:00, which Obsidian's date-and-time field writes when only the day is edited), `date-order`, `link-broken`, `link-unquoted`, `link-ambiguous`, `link-target-type`, `name-duplicate`, `alias-collision`, `isolated`, `no-backlinks`, `file-unlinked` (a file in an attachment folder that no note links or embeds), `injection-suspect`, `templater-command`, `filename-chars`, `file-large`, `file-too-large`, `base-link-broken`, `base-folder-broken`, `schema-missing`, `schema-invalid`, `property-type-conflict` (a property with kinds that Obsidian shows differently in two types: Obsidian keeps one type per name, so `.obsidian/types.json` would be wrong for one of them).

## New notes

A note created in Obsidian, by a Bases view's **New** button, a click on a link or the file menu, gets the template of its type as soon as it has one: the properties of its type and kind in order, the values already written kept, then the type's `body`. The template comes from the type, not from the folder, so one folder can hold notes of many types. The plugin completes only notes created since Obsidian started and only while they have no text: it never touches a note someone has written in. Turn it off in the settings when another plugin applies templates.

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

In the palette: *Check the vault*, *Conform this note to its template*; on the Mac, with the calendar helper, *Add this event to the calendar*, *New note from a calendar event*, *Open this event in the calendar*; on desktop, with health sources, *Import health data now*.

In Obsidian's command line (Obsidian 1.12.2 or later, app open):

```sh
obsidian-cli second-brain:lint [all] [format=json]
obsidian-cli second-brain:links file="Note" [format=json]
obsidian-cli second-brain:path from="A" to="B" [all]
obsidian-cli second-brain:neighbors file="Note" [depth=2]
obsidian-cli second-brain:conform [file="Note"] [apply]
obsidian-cli second-brain:prune [file="Note"] [apply]
obsidian-cli second-brain:templates
obsidian-cli second-brain:briefing
obsidian-cli second-brain:recall
obsidian-cli second-brain:health-import [apply] [rebuild]
```

### Cleanup

`prune` lists the closed notes of the types with `prune_after` that nobody has modified for that many days, and with `apply` removes them, to the trash that Obsidian's settings name (*Files and links → Deleted files*), then adds an entry to the log. Where a removed note is cited, a link in the body becomes its text followed by ✓ (`- [[Send the code]]` → `- Send the code ✓`), and a link in a property is taken out of it. A note with text of its own (a line that is not blank, a heading or a line of its type's `body`) is listed apart, to decide: move what matters to another note, then remove it with `file="Note" apply`, which removes a closed note now, whatever its age and text. The preview also names the attachments that would be left without links. The briefing counts the notes to prune.

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

## Health import

[Health Auto Export](https://www.healthyapps.dev) (iOS) exports Apple Health as JSON, by hand or with automations that write to a folder of iCloud Drive. The plugin reads such a folder, with its subfolders, into a folder of the vault, shortly after Obsidian starts and then at the interval of the settings; `health-import` shows what would change and writes with `apply`. It reads only the files that are new or changed since the last import (`rebuild`: all of them), never deletes a row, and copies only numbers, dates and the sport of each workout: names, sources, notes and GPS routes stay out.

Any export of version 2 will do; what a file holds is read from its content, not from its name:

- **Workouts**: one row each, with their minutes and kilometre splits.
- **Metrics summarised by day**: one row per day. Metrics the plugin does not know keep the export's name and unit.
- **Metrics by hour or by minute**: only the running metrics are kept, sample by sample, to give each run its dynamics. An automation of the running metrics by minute gives each run its own values; with hourly metrics they are weighted by overlap, and with daily ones they are used only on days with a single run.

The vault folder gets:

| File | One row per | Fields |
| --- | --- | --- |
| `daily.jsonl` | day | `date`; `steps`, `distance_km`, `active_kcal`, `basal_kcal`, `exercise_min`, `stand_min`, `stand_h`, `flights`, `daylight_min`; `rhr_bpm`, `hr_min_bpm`, `hr_avg_bpm`, `hr_max_bpm`, `walking_hr_bpm`, `hrv_sdnn_ms`, `hrv_rmssd_ms`, `respiratory_rate`, `spo2_pct`, `wrist_temp_c`, `vo2max`, `cardio_recovery_bpm`; `sleep_h`, `sleep_deep_h`, `sleep_rem_h`, `sleep_core_h`, `sleep_awake_h`, `sleep_start`, `sleep_end`; `weight_kg`, `body_fat_pct`, `lean_kg`, `bmi`; `walking_speed_kmh`, `walking_step_cm`, `walking_double_support_pct`, `walking_asymmetry_pct`; `run_power_w`, `run_speed_kmh`, `run_vo_cm`, `run_gct_ms`, `run_stride_m`; training load `trimp`, `atl`, `ctl`, `tsb` |
| `workouts.jsonl` | workout | `id`, `date`, `start`, `end`, `sport` (Apple's activity type: `running`, `walking`, `core_training`…), `indoor`, `duration_min`, `elapsed_min`, `distance_km`, `speed_kmh`, `pace_s_km`, `hr_avg`, `hr_min`, `hr_max`, `active_kcal`, `total_kcal`, `elevation_up_m`, `cadence_spm`, `steps`, `stride_m`, `effort`, `temp_c`, `humidity_pct`, `met`; derived `m_per_beat`, `decoupling_pct`, `trimp`, `z1_min`…`z5_min`, and for runs `run_power_w`, `power_w_kg`, `run_vo_cm`, `run_gct_ms`, `run_stride_m`, `vertical_ratio_pct`, `dynamics_src` |
| `splits.jsonl` | kilometre of a workout | `id`, `date`, `start`, `sport`, `km`, `distance_m`, `duration_s`, `pace_s_km`, `hr_avg`, `partial` |
| `running.jsonl` | running sample | `time`, `res` (`minute` or `hour`), `power_w`, `speed_kmh`, `vo_cm`, `gct_ms`, `stride_m` |
| `Workouts/<date>_<id>.jsonl` | minute of a workout | `t` (minutes from the start), `time`, `hr`, `hr_min`, `hr_max`, `dist_m`, `steps`, `kcal`, `pace_s_km`; for runs with samples by minute `power_w`, `vo_cm`, `gct_ms`, `stride_m` |
| `sources.json` | — | The source files read, with size and date, and the last import, which goes in the briefing |

Derived fields are computed again at every import from the stored rows:

- `m_per_beat`: metres per heartbeat, distance ÷ (average heart rate × minutes), for running, walking and hiking.
- `decoupling_pct`: for runs of 20 minutes or more, how much the metres per beat drop from the first half to the second.
- Zones: minutes by the average heart rate of each minute. With the zones of the settings, Z2–Z5 start at the bpm given; without, they follow the heart-rate reserve (Karvonen), with the resting heart rate of the day (or the latest in 30 days): Z1 below 60 %, Z2 60–70 %, Z3 70–80 %, Z4 80–90 %, Z5 from 90 %. Z1 is everything below Z2, so the zones add up to the minutes with a heart rate.
- `trimp`: Banister's training impulse, minute by minute.
- `atl`, `ctl`, `tsb`: fatigue (7-day exponential average of TRIMP), fitness (42 days) and form (yesterday's fitness minus fatigue).
- `power_w_kg`: running power over the latest weight within 60 days; `vertical_ratio_pct`: vertical oscillation over stride length.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build                 # dist/main.js; with VAULT_PLUGIN_DIR=<vault>/.obsidian/plugins/second-brain, also installed there
```

`src/` holds the logic and knows nothing of Obsidian: it receives the vault as an index with links already resolved, which `main.ts` builds from Obsidian's metadata cache and the tests from fixtures. The calendar client gets Node's `net` from `main.ts`, which loads it only on the Mac, and the health import gets the files from `main.ts` too, which reads them with Node's `fs` only on desktop, so the plugin still loads on mobile. A vault is checked inside Obsidian: status bar, *Check the vault*, `obsidian-cli second-brain:lint`. MIT license.
