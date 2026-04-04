import { Command } from 'commander';
import { getBaseUrl } from '../config.js';
import { error, info, json, isJsonMode, table } from '../output.js';

export const browseCommand = new Command('browse')
  .description('Browse the public API directory')
  .argument('[directory]', 'Literal "directory" (optional)')
  .option('--category <cat>', 'Show APIs in a specific category')
  .option('--limit <n>', 'Max results', parseInt, 20)
  .action(async (_dir, opts) => {
    try {
      const baseUrl = getBaseUrl();

      if (opts.category) {
        // Show APIs in the given category
        const params = new URLSearchParams({
          category: opts.category,
          limit: String(opts.limit),
        });

        const res = await fetch(
          `${baseUrl}/directory/apis?${params.toString()}`,
        );

        if (!res.ok) {
          error(`Failed to fetch directory (HTTP ${res.status}).`);
          process.exitCode = 1;
          return;
        }

        const apis = (await res.json()) as Record<string, unknown>[];

        if (isJsonMode()) {
          json(apis);
          return;
        }

        if (apis.length === 0) {
          info(`No APIs found in category "${opts.category}".`);
          return;
        }

        info(`Category: ${opts.category}`);
        table(
          ['Name', 'Slug', 'Description'],
          apis.map((a) => [
            String(a.name || ''),
            String(a.slug || ''),
            truncate(String(a.description || ''), 60),
          ]),
        );
      } else {
        // Show available categories
        const res = await fetch(`${baseUrl}/directory/categories`);

        if (!res.ok) {
          error(`Failed to fetch categories (HTTP ${res.status}).`);
          process.exitCode = 1;
          return;
        }

        const categories = (await res.json()) as Record<string, unknown>[];

        if (isJsonMode()) {
          json(categories);
          return;
        }

        if (categories.length === 0) {
          info('No categories available.');
          return;
        }

        info('API Directory Categories');
        table(
          ['Category', 'Count', 'Description'],
          categories.map((c) => [
            String(c.name || c.slug || ''),
            String(c.count ?? ''),
            String(c.description || ''),
          ]),
        );
        console.log('');
        info('Use --category <name> to browse APIs in a category.');
      }
    } catch (err) {
      error(`Browse failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '\u2026';
}
