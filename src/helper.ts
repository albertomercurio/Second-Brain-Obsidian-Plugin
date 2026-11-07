// The local calendar helper answers on a Unix socket, one JSON line each way:
// {"tool": …, "arguments": {…}} → {"ok": true, "result": …} or {"ok": false, "error": "…"}.
// The helper holds the calendar permission; the plugin only asks. Node's `net`
// comes from the caller, so this module also runs in the tests.

import type * as Net from "net";

/** A path with ~ for the home folder. */
export const expandHome = (path: string, home: string): string => (path === "~" || path.startsWith("~/") ? home + path.slice(1) : path);

export function callHelper<T>(net: typeof Net, socketPath: string, tool: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = "";
    let settled = false;
    const finish = (error: Error | null, result?: T) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result as T);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => finish(new Error("the calendar helper did not answer in time")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ tool, arguments: args })}\n`));
    socket.on("data", (chunk: string) => {
      data += chunk;
      const end = data.indexOf("\n");
      if (end < 0) return;
      let reply: { ok?: boolean; result?: T; error?: string };
      try {
        reply = JSON.parse(data.slice(0, end));
      } catch {
        return finish(new Error("unreadable answer from the calendar helper"));
      }
      finish(reply.ok ? null : new Error(reply.error ?? "the calendar helper refused"), reply.result);
    });
    socket.on("error", (err) => finish(new Error(`the calendar helper does not answer (${err.message}): is it installed?`)));
    socket.on("end", () => finish(new Error("the calendar helper closed the connection without an answer")));
  });
}
