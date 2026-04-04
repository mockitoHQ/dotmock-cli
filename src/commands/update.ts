import { Command } from 'commander';
import { api, ApiError } from '../client.js';
import { success, error, json, isJsonMode } from '../output.js';

interface ActionResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

async function executeAction(
  action: string,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  return api<ActionResult>('POST', '/internal/mcp/execute-action', {
    action,
    params,
    context: {},
  });
}

const updateApiCommand = new Command('api')
  .description('Update a mock API')
  .argument('<slug>', 'API slug')
  .option('--name <name>', 'New API name')
  .option('--description <text>', 'New API description')
  .action(async (slug: string, opts) => {
    try {
      const params: Record<string, unknown> = { apiId: slug };
      if (opts.name) params.name = opts.name;
      if (opts.description) params.description = opts.description;

      const result = await executeAction('mockito_update_api', params);

      if (!result.success) {
        error(result.error || 'Failed to update API.');
        process.exitCode = 1;
        return;
      }

      if (isJsonMode()) {
        json(result.data);
        return;
      }

      success(`API "${slug}" updated.`);
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Failed to update API (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Failed to update API: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

const updateFixtureCommand = new Command('fixture')
  .description('Update an LLM fixture')
  .requiredOption('--api <slug>', 'API slug')
  .requiredOption('--id <id>', 'Fixture ID')
  .option('--name <name>', 'New fixture name')
  .option('--priority <n>', 'New priority', parseInt)
  .option('--match <text>', 'New user message match')
  .option('--response <text>', 'New response text')
  .action(async (opts) => {
    try {
      const body: Record<string, unknown> = {};
      if (opts.name) body.name = opts.name;
      if (opts.priority !== undefined) body.priority = opts.priority;
      if (opts.match) body.userMessage = opts.match;
      if (opts.response) body.response = opts.response;

      if (Object.keys(body).length === 0) {
        error('No update fields provided. Use --name, --priority, --match, or --response.');
        process.exitCode = 1;
        return;
      }

      const result = await api(
        'PATCH',
        `/mock-apis/${opts.api}/llm-fixtures/${opts.id}`,
        body,
      );

      if (isJsonMode()) {
        json(result);
        return;
      }

      success(`Fixture "${opts.id}" updated.`);
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Failed to update fixture (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Failed to update fixture: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

export const updateCommand = new Command('update')
  .description('Update an API or fixture')
  .addCommand(updateApiCommand)
  .addCommand(updateFixtureCommand);
