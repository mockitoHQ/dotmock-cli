import { Command } from 'commander';
import { createInterface } from 'node:readline';
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

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

const deleteApiCommand = new Command('api')
  .description('Delete a mock API')
  .argument('<slug>', 'API slug')
  .option('--force', 'Skip confirmation prompt')
  .action(async (slug: string, opts) => {
    try {
      if (!opts.force && !isJsonMode()) {
        const ok = await confirm(
          `Are you sure you want to delete API "${slug}"? This cannot be undone.`,
        );
        if (!ok) {
          error('Aborted.');
          return;
        }
      }

      const result = await executeAction('mockito_delete_api', {
        apiId: slug,
      });

      if (!result.success) {
        error(result.error || 'Failed to delete API.');
        process.exitCode = 1;
        return;
      }

      if (isJsonMode()) {
        json({ deleted: true, slug });
        return;
      }

      success(`API "${slug}" deleted.`);
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Failed to delete API (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Failed to delete API: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

const deleteFixtureCommand = new Command('fixture')
  .description('Delete an LLM fixture')
  .requiredOption('--api <slug>', 'API slug')
  .requiredOption('--id <id>', 'Fixture ID')
  .action(async (opts) => {
    try {
      await api('DELETE', `/mock-apis/${opts.api}/llm-fixtures/${opts.id}`);

      if (isJsonMode()) {
        json({ deleted: true, api: opts.api, id: opts.id });
        return;
      }

      success(`Fixture "${opts.id}" deleted.`);
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Failed to delete fixture (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Failed to delete fixture: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

export const deleteCommand = new Command('delete')
  .alias('rm')
  .description('Delete an API or fixture')
  .addCommand(deleteApiCommand)
  .addCommand(deleteFixtureCommand);
