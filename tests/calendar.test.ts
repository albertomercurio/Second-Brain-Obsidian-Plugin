import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { type CalendarEvent, calendarSpec, clean, draftFromNote, eventId, eventPath, fileTitle, noteFromEvent, peopleByEmail } from "../src/calendar";
import { callHelper, expandHome } from "../src/helper";
import { checkValue } from "../src/schema";
import { propertyTypes } from "../src/templates";
import { note, schema, vaultOf } from "./helpers";

const spec = calendarSpec(schema)!;

test("the calendar rule of the schema names the properties", () => {
  assert.equal(spec.type, "Event");
  assert.equal(spec.folder, "Records");
  assert.deepEqual([spec.start, spec.end, spec.location, spec.participants, spec.email, spec.link, spec.kind], ["Date", "End Date", "Location", "Participants", "Email", "Calendar Event", "Meeting"]);
});

test("datetime: a day, or a day and a time; an Obsidian date and time property", () => {
  const field = schema.fieldsFor("Event").get("Date")!;
  for (const value of ["2026-11-10", "2026-11-10T14:30", "2026-11-10T14:30:00"]) assert.deepEqual(checkValue(field, value), [], value);
  for (const value of ["2026-11-31", "2026-11-10T24:00", "2026-11-10 14:30", "10/11/2026"]) assert.equal(checkValue(field, value).length, 1, value);
  assert.equal(JSON.parse(propertyTypes(schema, {})).types.Date, "datetime");
});

test("a note with a time is an event with a time", () => {
  const draft = draftFromNote("Meeting with Ada (2026-11-10)", { Date: "2026-11-10T14:00", "End Date": "2026-11-10T15:30", Location: "BSP 727" }, spec);
  assert.deepEqual(draft, { title: "Meeting with Ada", start: "2026-11-10T14:00", end: "2026-11-10T15:30", all_day: false, location: "BSP 727" });
  assert.deepEqual(draftFromNote("Call (2026-11-10)", { Date: "2026-11-10T09:00" }, spec), { title: "Call", start: "2026-11-10T09:00", all_day: false });
});

test("a note with days only is an event of whole days", () => {
  assert.deepEqual(draftFromNote("School (2026-11-10)", { Date: "2026-11-10", "End Date": "2026-11-12" }, spec), {
    title: "School",
    start: "2026-11-10",
    end: "2026-11-12",
    all_day: true,
  });
});

test("a note that cannot become an event says why", () => {
  assert.throws(() => draftFromNote("Talk (2026-11-10)", {}, spec), /no Date/);
  assert.throws(() => draftFromNote("(2026-11-10)", { Date: "2026-11-10" }, spec), /title/);
  assert.throws(() => draftFromNote("Talk (2026-11-10)", { Date: "2026-11-10T10:00", "End Date": "2026-11-10" }, spec), /End Date needs a time/);
  assert.throws(() => draftFromNote("Talk (2026-11-10)", { Date: "2026-11-10", "End Date": "2026-11-10T12:00" }, spec), /Date needs a time/);
});

test("text from the calendar cannot run Templater or make links", () => {
  assert.equal(clean("Review <% tp.system.prompt() %> [[Secret]]\nnow"), "Review tp.system.prompt() Secret now");
  assert.equal(fileTitle('Sync: A/B? "draft" #3 [x]'), "Sync A B draft 3 x");
  assert.equal(eventId("ical://ekevent/ABC%3A123?method=show&options=more"), "ABC:123");
  assert.equal(eventId("https://example.org"), null);
});

test("a note from an event: name, template order, people known by their address", () => {
  const vault = vaultOf({
    "Notes/People/Ada Lovelace.md": note('Type: Person\nEmail:\n  - "ada@example.org"'),
    "Notes/People/Alberto Mercurio.md": note('Type: Person\nEmail:\n  - "me@example.org"'),
  });
  const people = peopleByEmail(vault, schema, spec);
  assert.equal(people.get("ada@example.org"), "Ada Lovelace");
  const event: CalendarEvent = {
    id: "E1",
    title: "Sync <% x %> with Ada",
    start: "2026-11-10T14:00:00+01:00",
    end: "2026-11-10T15:00:00+01:00",
    all_day: false,
    location: "BSP 727",
    account: "Work",
    link: "ical://ekevent/E1?method=show&options=more",
    organizer: { email: "me@example.org", me: true },
    attendees: [
      { email: "ADA@example.org", me: false },
      { email: "someone@else.org", me: false },
      { email: "me@example.org", me: true },
    ],
  };
  const { path, text } = noteFromEvent(event, spec, schema, people);
  assert.equal(path, "Records/Sync x with Ada (2026-11-10).md");
  assert.equal(eventPath(spec, event, 2), "Records/Sync x with Ada 2 (2026-11-10).md");
  const [, yaml, body] = text.split("---\n");
  assert.deepEqual(parse(yaml), {
    Type: "Event",
    Kind: "Meeting",
    Date: "2026-11-10T14:00",
    Participants: ["[[Alberto Mercurio]]", "[[Ada Lovelace]]"],
    Projects: null,
    "End Date": "2026-11-10T15:00",
    Location: "BSP 727",
    "Calendar Event": "ical://ekevent/E1?method=show&options=more",
  });
  assert.match(body, /^Participants not in the vault: someone@else\.org\.\n\n## Notes/);
  assert.ok(!text.includes("<%"));
});

test("a one-day event has no end in its note", () => {
  const event: CalendarEvent = { id: "E2", title: "Holiday", start: "2026-12-25", end: "2026-12-25", all_day: true, account: "Personal", link: "ical://ekevent/E2" };
  const meta = parse(noteFromEvent(event, spec, schema, new Map()).text.split("---\n")[1]);
  assert.equal(meta.Date, "2026-12-25");
  assert.equal(meta["End Date"], undefined);
});

test("the helper answers one JSON line on a Unix socket", async () => {
  const folder = mkdtempSync(join(tmpdir(), "sb-helper-"));
  const socketPath = join(folder, "helper.sock");
  const requests: unknown[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (line: string) => {
      const request = JSON.parse(line.trim());
      requests.push(request);
      const reply = request.tool === "health" ? { ok: true, result: { access: "full" } } : { ok: false, error: "Strumento sconosciuto." };
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    assert.deepEqual(await callHelper(net, socketPath, "health", {}), { access: "full" });
    await assert.rejects(callHelper(net, socketPath, "other", { a: 1 }), /Strumento sconosciuto/);
    assert.deepEqual(requests, [{ tool: "health", arguments: {} }, { tool: "other", arguments: { a: 1 } }]);
    await assert.rejects(callHelper(net, join(folder, "missing.sock"), "health", {}), /is it installed/);
  } finally {
    server.close();
    rmSync(folder, { recursive: true, force: true });
  }
  assert.equal(expandHome("~/Library/x.sock", "/Users/a"), "/Users/a/Library/x.sock");
});
