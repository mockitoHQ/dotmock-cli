import { Command } from 'commander';
import { api, ApiError } from '../client.js';
import { error, info, json, isJsonMode, success } from '../output.js';
import { executeAction as execute } from '../actions.js';

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
      const result = await executeAction('dotmock_get_api', { apiId: slug });

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
      const fixture = await execute<Record<string, unknown>>(
        'dotmock_get_llm_fixture',
        { apiId: opts.api, fixtureId: opts.id },
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

const getEndpointCommand = new Command('endpoint')
  .description('Get the complete behavior for one endpoint')
  .requiredOption('--api <id>', 'API ID or slug')
  .requiredOption('--method <method>', 'HTTP method')
  .requiredOption('--path <path>', 'Endpoint path')
  .action(async (opts) => {
    try {
      const endpoint = await execute<Record<string, unknown>>(
        'dotmock_get_endpoint',
        {
          apiId: opts.api,
          method: String(opts.method).toUpperCase(),
          path: opts.path,
        },
      );
      if (isJsonMode()) {
        json(endpoint);
        return;
      }
      success(`${String(opts.method).toUpperCase()} ${opts.path}`);
      console.log(JSON.stringify(endpoint, null, 2));
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Failed to get endpoint (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Failed to get endpoint: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

const getStatsCommand = new Command('stats')
  .description('Get usage and performance statistics for an API')
  .requiredOption('--api <id>', 'API ID or slug')
  .action(async (opts) => {
    try {
      const stats = await execute<Record<string, unknown>>(
        'dotmock_get_api_stats',
        { apiId: opts.api },
      );
      if (isJsonMode()) {
        json(stats);
        return;
      }
      success('API statistics');
      for (const [key, value] of Object.entries(stats)) {
        info(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Failed to get API statistics (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Failed to get API statistics: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

export const getCommand = new Command('get')
  .description('Get API, endpoint, fixture, or statistics details')
  .addCommand(getApiCommand)
  .addCommand(getFixtureCommand)
  .addCommand(getEndpointCommand)
  .addCommand(getStatsCommand);
