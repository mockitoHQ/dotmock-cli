import { Command } from 'commander';
import { api, ApiError } from '../client.js';
import { error, info, json, isJsonMode, success } from '../output.js';

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

const getApiCommand = new Command('api')
  .description('Get details of a mock API')
  .argument('<slug>', 'API slug')
  .action(async (slug: string) => {
    try {
      const result = await executeAction('mockito_get_api', { apiId: slug });

      if (!result.success) {
        error(result.error || 'Failed to get API.');
        process.exitCode = 1;
        return;
      }

      const data = result.data || {};

      if (isJsonMode()) {
        json(data);
        return;
      }

      success(`${data.name || slug}`);
      info(`Type: ${data.type || 'rest'}`);
      if (data.url || data.mockUrl) info(`URL: ${data.url || data.mockUrl}`);
      if (data.status) info(`Status: ${data.status}`);
      if (data.description) info(`Description: ${data.description}`);
      if (data.slug) info(`Slug: ${data.slug}`);
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Failed to get API (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Failed to get API: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

const getFixtureCommand = new Command('fixture')
  .description('Get details of an LLM fixture')
  .requiredOption('--api <slug>', 'API slug')
  .requiredOption('--id <id>', 'Fixture ID')
  .action(async (opts) => {
    try {
      const fixture = await api<Record<string, unknown>>(
        'GET',
        `/mock-apis/${opts.api}/llm-fixtures/${opts.id}`,
      );

      if (isJsonMode()) {
        json(fixture);
        return;
      }

      success(`Fixture: ${fixture.name || opts.id}`);
      if (fixture.priority !== undefined) info(`Priority: ${fixture.priority}`);
      if (fixture.userMessage) info(`Match: ${fixture.userMessage}`);
      if (fixture.model) info(`Model: ${fixture.model}`);
      if (fixture.systemPrompt) info(`System prompt: ${fixture.systemPrompt}`);
      if (fixture.response) info(`Response: ${fixture.response}`);
      if (fixture.toolName) info(`Tool: ${fixture.toolName}`);
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Failed to get fixture (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Failed to get fixture: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

export const getCommand = new Command('get')
  .description('Get details of an API or fixture')
  .addCommand(getApiCommand)
  .addCommand(getFixtureCommand);
