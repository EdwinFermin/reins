import path from "node:path";
import { pathExists, readJsonIfExists } from "../fs/read";
import type { DetectedCommand, DetectedCommands, Detector, StackProfile } from "./types";

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Dependency name -> friendly framework label. */
const NODE_FRAMEWORKS: Record<string, string> = {
  next: "next",
  react: "react",
  vue: "vue",
  svelte: "svelte",
  "@sveltejs/kit": "sveltekit",
  "@angular/core": "angular",
  astro: "astro",
  nuxt: "nuxt",
  "@remix-run/react": "remix",
  express: "express",
  fastify: "fastify",
  "@nestjs/core": "nestjs",
  hono: "hono",
  vite: "vite",
  expo: "expo",
  "react-native": "react-native",
};

async function detectPackageManager(cwd: string): Promise<string> {
  if (await pathExists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(path.join(cwd, "yarn.lock"))) return "yarn";
  if (
    (await pathExists(path.join(cwd, "bun.lockb"))) ||
    (await pathExists(path.join(cwd, "bun.lock")))
  )
    return "bun";
  return "npm";
}

/** How a given package manager runs `test` and an arbitrary script. */
function runners(pm: string): { test: string; run: string } {
  switch (pm) {
    case "pnpm":
      return { test: "pnpm test", run: "pnpm run" };
    case "yarn":
      return { test: "yarn test", run: "yarn run" };
    case "bun":
      return { test: "bun test", run: "bun run" };
    default:
      return { test: "npm test", run: "npm run" };
  }
}

export const nodeDetector: Detector = {
  language: "node",
  async detect(cwd: string): Promise<StackProfile | null> {
    const pkg = await readJsonIfExists<PackageJson>(path.join(cwd, "package.json"));
    if (!pkg) return null;

    const pm = await detectPackageManager(cwd);
    const r = runners(pm);
    const scripts = pkg.scripts ?? {};
    const high = (value: string, source: string): DetectedCommand => ({
      value,
      confidence: "high",
      source,
    });

    const commands: DetectedCommands = {};
    if (scripts.test) commands.test = high(r.test, "package.json scripts.test");
    if (scripts.build) commands.build = high(`${r.run} build`, "package.json scripts.build");
    if (scripts.lint) commands.lint = high(`${r.run} lint`, "package.json scripts.lint");

    const e2eScript = scripts.e2e ? "e2e" : scripts["test:e2e"] ? "test:e2e" : undefined;
    if (e2eScript)
      commands.e2e = high(`${r.run} ${e2eScript}`, `package.json scripts.${e2eScript}`);

    const tcScript = scripts.typecheck
      ? "typecheck"
      : scripts["type-check"]
        ? "type-check"
        : undefined;
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (tcScript) {
      commands.typecheck = high(`${r.run} ${tcScript}`, `package.json scripts.${tcScript}`);
    } else if (deps.typescript) {
      commands.typecheck = {
        value: "npx tsc --noEmit",
        confidence: "low",
        source: "typescript dependency",
      };
    }

    const frameworks = [
      ...new Set(
        Object.keys(deps)
          .map((d) => NODE_FRAMEWORKS[d])
          .filter((v): v is string => Boolean(v)),
      ),
    ];

    return { language: "node", packageManager: pm, frameworks, commands };
  },
};
