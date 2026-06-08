import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Eta } from "eta";

let cachedRoot: string | null = null;

/** Find the package root (the dir holding both package.json and templates/). */
export function findPackageRoot(): string {
  if (cachedRoot) return cachedRoot;
  const start = path.dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "templates"))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedRoot = path.resolve(start, "..");
  return cachedRoot;
}

export function templatesDir(): string {
  return path.join(findPackageRoot(), "templates");
}

function makeEta(): Eta {
  // autoEscape off: we generate code/markdown/JSON, not HTML.
  // autoTrim off: keep newlines after inline conditionals so list items and
  // table rows don't collapse onto one line.
  return new Eta({ views: templatesDir(), autoEscape: false, autoTrim: false });
}

/** Render an inline template string with the given data (data is `it` in eta). */
export function renderString(template: string, data: Record<string, unknown>): string {
  return makeEta().renderString(template, data);
}

/** Render a template file (path relative to templates/, e.g. "common/CLAUDE.md.eta"). */
export function renderFile(relTemplatePath: string, data: Record<string, unknown>): string {
  const abs = path.join(templatesDir(), relTemplatePath);
  const rendered = renderString(readFileSync(abs, "utf8"), data);
  // Collapse the stray blank lines left by block conditionals.
  return rendered.replace(/\n{3,}/g, "\n\n");
}
