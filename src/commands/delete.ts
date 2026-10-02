import { Command } from 'commander';
import { ApiError } from '../client.js';
import { success, error, info, json, isJsonMode } from '../output.js';
import { executeAction } from '../actions.js';
import { resolveApiId } from '../lib/api-ref.js';
import { confirmDestructive } from '../lib/confirm.js';

function fail(err: unknown, what: string): void {
  if (err instanceof ApiError) error(`Failed to delete ${what} (HTTP ${err.status}): ${err.message}`);
  else error(`Failed to delete ${what}: ${(err as Error).message}`);
  process.exitCode = 1;
}

const deleteApiCommand = new Command('api')
  .description('Delete a mock API')
  .argument('<api>', 'API ID, subdomain, or name')
  .option('-y, --yes', 'Skip the confirmation prompt (required in CI / non-interactive shells)')
  .option('--force', 'Alias for --yes')
  .action(async (ref: string, opts) => {
    try {
      const apiId = await resolveApiId(ref);
      const label = apiId === ref ? ref : `${ref} (${apiId})`;
      if (!(await confirmDestructive(`Delete API "${label}"? This cannot be undone.`, opts.yes || opts.force))) {
        info('Aborted.');
        return;
      }
      // The explicit command plus confirmation is the user's consent.
      await executeAction('dotmock_delete_api', { apiId, approved: true });
      if (isJsonMode()) {
        json({ deleted: true, apiId, ref });
        return;
      }
      success(`API "${label}" deleted.`);
    } catch (err) {
      fail(err, 'API');
    }
  });

const deleteFixtureCommand = new Command('fixture')
  .description('Delete an LLM fixture')
  .requiredOption('--api <api>', 'API ID, subdomain, or name')
  .requiredOption('--id <id>', 'Fixture ID')
  .action(async (opts) => {
    try {
      const apiId = await resolveApiId(opts.api);
      await executeAction('dotmock_delete_llm_fixture', { apiId, fixtureId: opts.id, approved: true });
      if (isJsonMode()) {
        json({ deleted: true, api: apiId, id: opts.id });
        return;
      }
      success(`Fixture "${opts.id}" deleted.`);
    } catch (err) {
      fail(err, 'fixture');
    }
  });

export const deleteCommand = new Command('delete')
  .alias('rm')
  .description('Delete an API or fixture')
  .addCommand(deleteApiCommand)
  .addCommand(deleteFixtureCommand);
