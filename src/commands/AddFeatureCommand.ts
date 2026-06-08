import path from "node:path";
import { Command, Option } from "clipanion";
import { addFeature } from "../core/features/add-feature";

/** `reins add-feature <slug>` — register a feature in feature_list.json. */
export class AddFeatureCommand extends Command {
  static override paths = [["add-feature"]];

  static override usage = Command.Usage({
    category: "Authoring",
    description: "Register a new feature in feature_list.json.",
    examples: [
      ["Queue a feature", "reins add-feature auth-login --title 'Login with email'"],
      ["Queue and scaffold its SDD spec", "reins add-feature auth-login --with-spec"],
    ],
  });

  slug = Option.String({ required: true, name: "slug" });
  cwd = Option.String("--cwd", { description: "Run as if started in this directory" });
  title = Option.String("--title", { description: "Human-readable feature title" });
  withSpec = Option.Boolean("--with-spec", false, {
    description: "Scaffold specs/<slug>/ from the SDD template",
  });
  dependsOn = Option.String("--depends-on", { description: "Comma-separated feature slugs" });
  json = Option.Boolean("--json", false, { description: "Machine-readable output" });

  async execute(): Promise<number> {
    const cwd = path.resolve(this.cwd ?? process.cwd());
    const dependsOn = this.dependsOn
      ? this.dependsOn
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    const result = await addFeature({
      cwd,
      slug: this.slug,
      title: this.title,
      withSpec: this.withSpec,
      dependsOn,
    });

    if (this.json) {
      this.context.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else if (result.added) {
      this.context.stdout.write(
        `Added feature "${result.slug}" (pending).` +
          (result.specCreated ? ` Spec scaffolded at specs/${result.slug}/.` : "") +
          "\n",
      );
      if (this.withSpec && !result.specCreated) {
        this.context.stdout.write(
          "Note: no specs/_template found (lite preset?) — spec not scaffolded.\n",
        );
      }
    } else {
      this.context.stderr.write(`Could not add feature: ${result.reason}\n`);
    }

    return result.added ? 0 : 1;
  }
}
