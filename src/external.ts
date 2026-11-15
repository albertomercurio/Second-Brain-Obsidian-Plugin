// External checks (Obsidian for desktop): commands of the settings that run from
// the vault's folder after every change and print problems as JSON, which join
// the lint. For what the plugin cannot see itself, such as the versions of a file
// that a sync service set aside. Output: an array of
// {severity, code, path, line?, message, hint?}, paths relative to the vault;
// nothing printed means no problems.

import type { Issue, Severity } from "./lint";

const SEVERITIES: Severity[] = ["error", "warning", "info"];

/** The problems a command printed; throws if its output is not such an array. */
export function parseExternalIssues(output: string): Issue[] {
  if (!output.trim()) return [];
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    throw new Error("its output is not JSON");
  }
  if (!Array.isArray(data)) throw new Error("its output is not a JSON array");
  return data.map((item, index) => {
    const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const { severity, code, path, line, message, hint } = entry;
    if (!SEVERITIES.includes(severity as Severity) || typeof code !== "string" || !code.trim() || typeof path !== "string" || typeof message !== "string") {
      throw new Error(`problem ${index + 1} needs a severity (error, warning or info), a code, a path and a message`);
    }
    return {
      severity: severity as Severity,
      code: code.trim(),
      path,
      line: typeof line === "number" && Number.isInteger(line) && line > 0 ? line : 1,
      message,
      hint: typeof hint === "string" ? hint : "",
    };
  });
}

/** A command that failed or printed something else: a warning, so that a broken check is not silent. */
export function externalFailure(command: string, reason: string): Issue {
  return {
    severity: "warning",
    code: "external-check-failed",
    path: command,
    line: 1,
    message: `this external check failed: ${reason.trim() || "no reason given"}`,
    hint: "run it from the vault's folder to see why, or take it out of the settings",
  };
}
