#!/usr/bin/env node
import { Command } from 'commander';
import { loginCommand, logoutCommand } from './commands/login.js';
import { statusCommand } from './commands/status.js';
import { createCommand } from './commands/create.js';
import { listCommand } from './commands/list.js';
import { getCommand } from './commands/get.js';
import { updateCommand } from './commands/update.js';
import { deleteCommand } from './commands/delete.js';
import { searchCommand } from './commands/search.js';
import { browseCommand } from './commands/browse.js';
import { cloneCommand } from './commands/clone.js';
import { configureCommand } from './commands/configure.js';
import { exampleCommand } from './commands/example.js';
import { webhookCommand } from './commands/webhook.js';

const program = new Command();

program
  .name('dotmock')
  .description('CLI for dotMock — create, manage, and use mock APIs')
  .version('0.1.0');

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

program.parse();
