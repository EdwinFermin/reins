import path from "node:path";
import { Command, Option } from "clipanion";
import { addAgent } from "../core/agents/add-agent";

/** `reins add-agent <role>` — add a subagent role from a template. */
export class AddAgentCommand extends Command {
  static override paths = [["add-agent"]];

  static override usage = Command.Usage({
    category: "Authoring",
    description: "Add a subagent role to the harness from a template.",
    examples: [
      ["Add the spec_author agent", "reins add-agent spec_author"],
      [
        "Add a custom reviewer",
        "reins add-agent perf-reviewer --from reviewer --tools 'Read, Grep, Bash'",
      ],
      [
        "Add a cheap explorer agent",
        "reins add-agent explorer --from reviewer --model haiku --effort low",
      ],
    ],
  });

  role = Option.String({ required: true, name: "role" });
  cwd = Option.String("--cwd", { description: "Run as if started in this directory" });
  name = Option.String("--name", { description: "Override the agent file/identity name" });
  tools = Option.String("--tools", { description: "Override the allowed tools list" });
  from = Option.String("--from", { description: "Base a custom role on an existing one" });
  model = Option.String("--model", {
    description: "Model: sonnet|opus|haiku|fable, a full model ID, or inherit",
  });
  effort = Option.String("--effort", { description: "Effort level: low|medium|high|xhigh|max" });
  json = Option.Boolean("--json", false, { description: "Machine-readable output" });

  async execute(): Promise<number> {
    const cwd = path.resolve(this.cwd ?? process.cwd());
    const result = await addAgent({
      cwd,
      role: this.role,
      name: this.name,
      tools: this.tools,
      from: this.from,
      model: this.model,
      effort: this.effort,
    });

    if (this.json) {
      this.context.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else if (result.added) {
      this.context.stdout.write(
        `Added agent "${result.name}" at .claude/agents/${result.name}.md\n`,
      );
    } else {
      this.context.stderr.write(`Could not add agent: ${result.reason}\n`);
    }

    return result.added ? 0 : 1;
  }
}
