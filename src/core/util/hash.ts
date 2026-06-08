import { createHash } from "node:crypto";

/** Stable SHA-256 hex digest of a UTF-8 string. */
export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Normalize text for stable comparison: LF line endings, single trailing newline. */
export function normalizeText(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\s+$/, "") + "\n";
}

/** Pretty-print JSON deterministically (2-space, trailing newline). */
export function normalizeJson(jsonText: string): string {
  return JSON.stringify(JSON.parse(jsonText), null, 2) + "\n";
}
