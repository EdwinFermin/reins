import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { pathExists, readTextIfExists } from "../fs/read";
import type {
  Confidence,
  DetectedCommand,
  DetectedCommands,
  Detector,
  StackProfile,
} from "./types";

const PY_FRAMEWORKS = ["fastapi", "django", "flask", "starlette", "litestar"];

/** Extract a normalized set of dependency names from a parsed pyproject.toml. */
function collectPythonDeps(parsed: Record<string, any>): string[] {
  const out = new Set<string>();
  const addSpec = (spec: string): void => {
    const m = /^[A-Za-z0-9._-]+/.exec(spec.trim());
    if (m) out.add(m[0].toLowerCase());
  };

  // PEP 621: [project] dependencies + optional-dependencies
  const projectDeps = parsed?.project?.dependencies;
  if (Array.isArray(projectDeps)) projectDeps.forEach((d) => typeof d === "string" && addSpec(d));
  const optional = parsed?.project?.["optional-dependencies"];
  if (optional && typeof optional === "object") {
    for (const arr of Object.values(optional)) {
      if (Array.isArray(arr)) arr.forEach((d) => typeof d === "string" && addSpec(d));
    }
  }

  // Poetry: [tool.poetry.dependencies] + dev groups
  const poetryDeps = parsed?.tool?.poetry?.dependencies;
  if (poetryDeps && typeof poetryDeps === "object") {
    Object.keys(poetryDeps).forEach((k) => out.add(k.toLowerCase()));
  }
  const poetryDev =
    parsed?.tool?.poetry?.group?.dev?.dependencies ?? parsed?.tool?.poetry?.["dev-dependencies"];
  if (poetryDev && typeof poetryDev === "object") {
    Object.keys(poetryDev).forEach((k) => out.add(k.toLowerCase()));
  }

  out.delete("python");
  return [...out];
}

export const pythonDetector: Detector = {
  language: "python",
  async detect(cwd: string): Promise<StackProfile | null> {
    const pyprojectPath = path.join(cwd, "pyproject.toml");
    const hasPyproject = await pathExists(pyprojectPath);
    const hasRequirements = await pathExists(path.join(cwd, "requirements.txt"));
    const hasSetup = await pathExists(path.join(cwd, "setup.py"));
    if (!hasPyproject && !hasRequirements && !hasSetup) return null;

    let parsed: Record<string, any> = {};
    let pm = "pip";
    if (hasPyproject) {
      const text = await readTextIfExists(pyprojectPath);
      if (text) {
        try {
          parsed = parseToml(text) as Record<string, any>;
        } catch {
          parsed = {};
        }
      }
      if ((await pathExists(path.join(cwd, "uv.lock"))) || parsed?.tool?.uv) pm = "uv";
      else if (parsed?.tool?.poetry || (await pathExists(path.join(cwd, "poetry.lock"))))
        pm = "poetry";
    }

    const runPrefix = pm === "uv" ? "uv run " : pm === "poetry" ? "poetry run " : "";
    const deps = collectPythonDeps(parsed);
    const has = (name: string): boolean => deps.includes(name);
    const cmd = (value: string, confidence: Confidence, source: string): DetectedCommand => ({
      value,
      confidence,
      source,
    });

    const commands: DetectedCommands = {};
    commands.test = has("pytest")
      ? cmd(`${runPrefix}pytest`, "high", "pytest dependency")
      : cmd(`${runPrefix}pytest`, "low", "python default");
    if (has("ruff")) commands.lint = cmd(`${runPrefix}ruff check .`, "high", "ruff dependency");
    else if (has("flake8")) commands.lint = cmd(`${runPrefix}flake8`, "high", "flake8 dependency");
    if (has("mypy")) commands.typecheck = cmd(`${runPrefix}mypy .`, "high", "mypy dependency");

    const frameworks = PY_FRAMEWORKS.filter(has);

    return { language: "python", packageManager: pm, frameworks, commands };
  },
};
