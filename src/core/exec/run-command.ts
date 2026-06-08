import { execa } from "execa";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a shell command line, capturing output and never throwing on non-zero exit. */
export async function runShell(
  command: string,
  opts: { cwd: string; timeoutMs?: number },
): Promise<RunResult> {
  try {
    const res = await execa(command, {
      shell: true,
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 120_000,
      reject: false,
      stripFinalNewline: true,
    });
    return {
      exitCode: typeof res.exitCode === "number" ? res.exitCode : 1,
      stdout: typeof res.stdout === "string" ? res.stdout : "",
      stderr: typeof res.stderr === "string" ? res.stderr : "",
      timedOut: Boolean(res.timedOut),
    };
  } catch (err: any) {
    return {
      exitCode: typeof err?.exitCode === "number" ? err.exitCode : 1,
      stdout: typeof err?.stdout === "string" ? err.stdout : "",
      stderr: typeof err?.stderr === "string" ? err.stderr : String(err?.message ?? err),
      timedOut: Boolean(err?.timedOut),
    };
  }
}

/** True if a binary is resolvable on PATH. */
export async function hasBinary(bin: string): Promise<boolean> {
  const probe = process.platform === "win32" ? `where ${bin}` : `command -v ${bin}`;
  const res = await runShell(probe, { cwd: process.cwd(), timeoutMs: 5_000 });
  return res.exitCode === 0;
}
