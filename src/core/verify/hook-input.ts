import type { Readable } from "node:stream";

/**
 * Read the JSON payload Claude Code pipes to a hook command on stdin and return
 * its `session_id`. Never blocks a manual run: a TTY is skipped, and an open
 * pipe that never closes is abandoned after `timeoutMs`.
 */
export async function readHookSessionId(
  stdin: Readable & { isTTY?: boolean },
  timeoutMs = 1_000,
): Promise<string | null> {
  if (stdin.isTTY) return null;
  const text = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", finish);
      stdin.off("error", finish);
      // Release the pipe so a never-closing stdin can't keep the process alive.
      stdin.destroy();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer | string): void => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.on("data", onData);
    stdin.once("end", finish);
    stdin.once("error", finish);
    stdin.resume();
  });
  try {
    const data = JSON.parse(text) as { session_id?: unknown };
    return typeof data.session_id === "string" && data.session_id ? data.session_id : null;
  } catch {
    return null;
  }
}
