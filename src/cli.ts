import { Builtins, Cli } from "clipanion";
import pkg from "../package.json";
import { InitCommand } from "./commands/InitCommand";
import { VerifyCommand } from "./commands/VerifyCommand";
import { DoctorCommand } from "./commands/DoctorCommand";
import { AddAgentCommand } from "./commands/AddAgentCommand";
import { AddFeatureCommand } from "./commands/AddFeatureCommand";
import { StatusCommand } from "./commands/StatusCommand";
import { UpdateCommand } from "./commands/UpdateCommand";
import { TelemetryCommand, TelemetryReportCommand } from "./commands/TelemetryCommand";
import { RouteCommand } from "./commands/RouteCommand";

const cli = new Cli({
  binaryLabel: "Reins",
  binaryName: "reins",
  binaryVersion: pkg.version,
});

cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);
cli.register(InitCommand);
cli.register(VerifyCommand);
cli.register(DoctorCommand);
cli.register(AddAgentCommand);
cli.register(AddFeatureCommand);
cli.register(StatusCommand);
cli.register(UpdateCommand);
cli.register(TelemetryCommand);
cli.register(TelemetryReportCommand);
cli.register(RouteCommand);

void cli.runExit(process.argv.slice(2));
