import { Command } from 'commander';
import { api, ApiError } from '../client.js';
import { success, error, info, json, isJsonMode } from '../output.js';

export const cloneCommand = new Command('clone')
  .description('Clone an API from the public directory')
  .argument('<slug>', 'API slug to clone')
  .option('--name <name>', 'Name for the cloned API')
  .action(async (slug: string, opts) => {
    try {
      const body: Record<string, unknown> = { subdomain: slug };
      if (opts.name) body.name = opts.name;

      const result = await api<Record<string, unknown>>(
        'POST',
        `/catalog/${slug}/clone`,
        body,
      );

      if (isJsonMode()) {
        json(result);
        return;
      }

      success(`API cloned from "${slug}".`);
      if (result.name) info(`Name: ${result.name}`);
      if (result.url || result.mockUrl) {
        info(`URL: ${result.url || result.mockUrl}`);
      }
      if (result.slug) info(`Slug: ${result.slug}`);
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Failed to clone API (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Failed to clone API: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });
