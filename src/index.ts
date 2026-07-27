#!/usr/bin/env node
import { Command } from "commander";
import { loginCommand, logoutCommand } from "./commands/login.js";
import { statusCommand } from "./commands/status.js";
import { createCommand } from "./commands/create.js";
import { listCommand } from "./commands/list.js";
import { getCommand } from "./commands/get.js";
import { updateCommand } from "./commands/update.js";
import { deleteCommand } from "./commands/delete.js";
import { searchCommand } from "./commands/search.js";
import { browseCommand } from "./commands/browse.js";
import { cloneCommand } from "./commands/clone.js";
import { configureCommand } from "./commands/configure.js";
import { exampleCommand } from "./commands/example.js";
import { webhookCommand } from "./commands/webhook.js";
import { configCommand } from "./commands/config.js";
import { skillCommand } from "./commands/skill.js";
import { testCommand } from "./commands/test.js";
import { reorderCommand } from "./commands/reorder.js";
import { analyzeCommand } from "./commands/analyze.js";
import { stateCommand } from "./commands/state.js";
import { grpcCommand } from "./commands/grpc.js";
import { soapCommand } from "./commands/soap.js";
import { realtimeCommand } from "./commands/realtime.js";

const program = new Command();

program
  .name("dotmock")
  .description("CLI for DotMock — create, manage, and use mock APIs")
  .version("0.1.1")
  .option("--json", "Emit machine-readable JSON for coding agents and CI");

program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(statusCommand);
program.addCommand(createCommand);
program.addCommand(listCommand);
program.addCommand(getCommand);
program.addCommand(updateCommand);
program.addCommand(deleteCommand);
program.addCommand(searchCommand);
program.addCommand(browseCommand);
program.addCommand(cloneCommand);
program.addCommand(configureCommand);
program.addCommand(exampleCommand);
program.addCommand(webhookCommand);
program.addCommand(configCommand);
program.addCommand(skillCommand);
program.addCommand(testCommand);
program.addCommand(reorderCommand);
program.addCommand(analyzeCommand);
program.addCommand(stateCommand);
program.addCommand(grpcCommand);
program.addCommand(soapCommand);
program.addCommand(realtimeCommand);

program.parseAsync().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
});
