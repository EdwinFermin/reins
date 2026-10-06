import type { Readable } from "node:stream";

export interface HookPayload {
  sessionId: string | null;
  /** Files the triggering tool call touched (PostToolUse on Edit/Write/MultiEdit). */
  filePaths: string[];
}

/**
 * Read the JSON payload Claude Code pipes to a hook command on stdin: its
 * `session_id`, and for a PostToolUse on a file tool the edited path. Never
 * blocks a manual run: a TTY is skipped, and an open pipe that never closes is
 * abandoned after `timeoutMs`.
 */
export async function readHookPayload(
  stdin: Readable & { isTTY?: boolean },
  timeoutMs = 1_000,
): Promise<HookPayload> {
  const empty: HookPayload = { sessionId: null, filePaths: [] };
  if (stdin.isTTY) return empty;
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
    const data = JSON.parse(text) as {
      session_id?: unknown;
      tool_input?: { file_path?: unknown; filePath?: unknown; edits?: unknown };
    };
    const sessionId =
      typeof data.session_id === "string" && data.session_id ? data.session_id : null;
    const input = data.tool_input ?? {};
    const filePaths = [input.file_path, input.filePath].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    return { sessionId, filePaths: [...new Set(filePaths)] };
  } catch {
    return empty;
  }
}

/** Back-compat wrapper: just the session id. */
export async function readHookSessionId(
  stdin: Readable & { isTTY?: boolean },
  timeoutMs = 1_000,
): Promise<string | null> {
  return (await readHookPayload(stdin, timeoutMs)).sessionId;
}
