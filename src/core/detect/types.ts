export type Language = "node" | "python" | "go" | "rust" | "ruby" | "java" | "other";

export type Confidence = "high" | "low";

/** A command inferred from the project, with where it came from and how sure we are. */
export interface DetectedCommand {
  value: string;
  confidence: Confidence;
  source: string;
}

/** Verb -> inferred command. Missing keys mean "not detected". */
export interface DetectedCommands {
  test?: DetectedCommand;
  build?: DetectedCommand;
  lint?: DetectedCommand;
  e2e?: DetectedCommand;
  typecheck?: DetectedCommand;
}

/** Everything Reins inferred about the target project's stack. */
export interface StackProfile {
  language: Language;
  packageManager?: string;
  frameworks: string[];
  commands: DetectedCommands;
}

export interface Detector {
  language: Language;
  /** Returns a profile if this detector matches the directory, otherwise null. */
  detect(cwd: string): Promise<StackProfile | null>;
}
