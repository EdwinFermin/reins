import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists, readJsonIfExists } from "../fs/read";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface AddFeatureOptions {
  cwd: string;
  slug: string;
  title?: string;
  withSpec?: boolean;
  dependsOn?: string[];
}

export interface AddFeatureResult {
  added: boolean;
  slug: string;
  specCreated: boolean;
  specFiles: string[];
  reason?: string;
}

interface FeatureList {
  version?: number;
  rules?: unknown;
  features?: { slug?: string; state?: string }[];
}

/** Register a new feature in feature_list.json, optionally scaffolding its spec. */
export async function addFeature(opts: AddFeatureOptions): Promise<AddFeatureResult> {
  const base = { added: false, slug: opts.slug, specCreated: false, specFiles: [] as string[] };

  if (!SLUG_RE.test(opts.slug)) {
    return { ...base, reason: "invalid slug (use lowercase letters, digits, and hyphens)" };
  }

  const flPath = path.join(opts.cwd, "feature_list.json");
  const fl = await readJsonIfExists<FeatureList>(flPath);
  if (!fl) return { ...base, reason: "feature_list.json not found — run `reins init`" };

  const features = Array.isArray(fl.features) ? fl.features : [];
  if (features.some((f) => f.slug === opts.slug)) {
    return { ...base, reason: "a feature with that slug already exists" };
  }

  const now = new Date().toISOString();
  features.push({
    slug: opts.slug,
    title: opts.title ?? opts.slug,
    state: "pending",
    dependsOn: opts.dependsOn ?? [],
    createdAt: now,
    updatedAt: now,
  } as never);
  fl.features = features;
  await writeFile(flPath, JSON.stringify(fl, null, 2) + "\n", "utf8");

  let specCreated = false;
  const specFiles: string[] = [];
  if (opts.withSpec) {
    const templateDir = path.join(opts.cwd, "specs", "_template");
    if (await pathExists(templateDir)) {
      const destDir = path.join(opts.cwd, "specs", opts.slug);
      await mkdir(destDir, { recursive: true });
      for (const name of await readdir(templateDir)) {
        const srcText = await readFile(path.join(templateDir, name), "utf8");
        await writeFile(
          path.join(destDir, name),
          srcText.replaceAll("<feature>", opts.slug),
          "utf8",
        );
        specFiles.push(path.join("specs", opts.slug, name));
      }
      specCreated = true;
    }
  }

  return { added: true, slug: opts.slug, specCreated, specFiles };
}
