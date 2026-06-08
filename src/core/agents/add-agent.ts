import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/load";
import { pathExists } from "../fs/read";
import { buildTemplateContext } from "../render/context";
import { renderFile } from "../render/engine";
import { normalizeText } from "../util/hash";

const AGENT_TEMPLATES: Record<string, string> = {
  leader: "common/.claude/agents/leader.md.eta",
  implementer: "common/.claude/agents/implementer.md.eta",
  reviewer: "common/.claude/agents/reviewer.md.eta",
  "security-reviewer": "common/.claude/agents/security-reviewer.md.eta",
  spec_author: "sdd/.claude/agents/spec_author.md.eta",
};

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export interface AddAgentOptions {
  cwd: string;
  role: string;
  name?: string;
  tools?: string;
  from?: string;
}

export interface AddAgentResult {
  added: boolean;
  name: string;
  reason?: string;
}

/** Replace `key: ...` on the first matching line (the frontmatter). */
function setFrontmatterField(content: string, key: string, value: string): string {
  const re = new RegExp(`(^|\\n)(${key}:)[^\\n]*`);
  return re.test(content) ? content.replace(re, `$1$2 ${value}`) : content;
}

/** Add a subagent definition from a built-in role template. */
export async function addAgent(opts: AddAgentOptions): Promise<AddAgentResult> {
  const name = opts.name ?? opts.role;
  const fail = (reason: string): AddAgentResult => ({ added: false, name, reason });

  const sourceRole = opts.from ?? opts.role;
  const template = AGENT_TEMPLATES[sourceRole];
  if (!template) {
    return fail(
      `unknown role "${sourceRole}" — known: ${Object.keys(AGENT_TEMPLATES).join(", ")} (or use --from)`,
    );
  }
  if (!NAME_RE.test(name)) return fail("invalid agent name (lowercase letters, digits, _ and -)");

  const config = await loadConfig(opts.cwd).catch(() => null);
  if (!config) return fail("no reins.config.json — run `reins init`");

  const dest = path.join(opts.cwd, ".claude/agents", `${name}.md`);
  if (await pathExists(dest)) return fail("an agent with that name already exists");

  const ctx = buildTemplateContext(config, {
    projectName: path.basename(opts.cwd),
    date: new Date().toISOString().slice(0, 10),
  });
  let content = renderFile(template, ctx as unknown as Record<string, unknown>);
  if (name !== sourceRole) content = setFrontmatterField(content, "name", name);
  if (opts.tools) content = setFrontmatterField(content, "tools", opts.tools);

  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, normalizeText(content), "utf8");
  return { added: true, name };
}
