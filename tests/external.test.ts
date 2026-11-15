import { test } from "node:test";
import assert from "node:assert/strict";
import { externalFailure, parseExternalIssues } from "../src/external";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";

test("external problems: line and hint are optional, nothing printed is no problem", () => {
  assert.deepEqual(parseExternalIssues(""), []);
  assert.deepEqual(parseExternalIssues(" []\n"), []);
  assert.deepEqual(parseExternalIssues('[{"severity":"warning","code":" sync ","path":"A.md","message":"m","line":0}]'), [
    { severity: "warning", code: "sync", path: "A.md", line: 1, message: "m", hint: "" },
  ]);
  assert.deepEqual(parseExternalIssues('[{"severity":"info","code":"c","path":"B.md","line":7,"message":"m","hint":"h"}]')[0], {
    severity: "info",
    code: "c",
    path: "B.md",
    line: 7,
    message: "m",
    hint: "h",
  });
});

test("external problems: anything else is refused", () => {
  assert.throws(() => parseExternalIssues("not json"), /not JSON/);
  assert.throws(() => parseExternalIssues('{"severity":"error"}'), /not a JSON array/);
  assert.throws(() => parseExternalIssues('[{"severity":"fatal","code":"c","path":"A.md","message":"m"}]'), /problem 1 needs/);
  assert.throws(() => parseExternalIssues('[{"severity":"error","code":"c","path":"A.md","message":"m"}, {"severity":"error","path":"A.md","message":"m"}]'), /problem 2 needs/);
  assert.throws(() => parseExternalIssues("[null]"), /problem 1 needs/);
});

test("a failed external check is a warning on the command", () => {
  const issue = externalFailure("tools/check", " exit 1\n");
  assert.equal(issue.severity, "warning");
  assert.equal(issue.code, "external-check-failed");
  assert.equal(issue.path, "tools/check");
  assert.match(issue.message, /failed: exit 1$/);
  assert.match(externalFailure("x", "").message, /no reason given/);
});

test("external checks in the settings: non-empty strings, trimmed", () => {
  assert.deepEqual(DEFAULT_SETTINGS.externalChecks, []);
  assert.deepEqual(readSettings({ externalChecks: [" tools/a ", "", 3, "tools/b check"] }).externalChecks, ["tools/a", "tools/b check"]);
  assert.deepEqual(readSettings({ externalChecks: "tools/a" }).externalChecks, []);
});
