import { nodeDetector } from "./node";
import { pythonDetector } from "./python";
import type { Detector, StackProfile } from "./types";

/** Detectors run in priority order; the first match wins. */
export const detectors: Detector[] = [nodeDetector, pythonDetector];

/**
 * Inspect a directory and return the best-guess stack profile. Falls back to
 * an `"other"` profile when no detector matches (the wizard fills the gaps).
 */
export async function detectStack(cwd: string): Promise<StackProfile> {
  for (const detector of detectors) {
    const profile = await detector.detect(cwd);
    if (profile) return profile;
  }
  return { language: "other", frameworks: [], commands: {} };
}

export type { Detector, DetectedCommand, DetectedCommands, Language, StackProfile } from "./types";
