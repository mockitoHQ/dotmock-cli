import { Command } from 'commander';
import { getBaseUrl } from '../config.js';
import { api, ApiError } from '../client.js';
import { error, info, json, isJsonMode, table } from '../output.js';

interface ActionResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

async function executeAction(
  action: string,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  return api<ActionResult>('POST', '/agent/actions/execute', {
    action,
    params,
    context: {},
  });
}

export const searchCommand = new Command('search')
  .description('Search public directory and your own APIs')
  .argument('<query>', 'Search query')
  .option('--category <cat>', 'Filter by category')
  .option('--limit <n>', 'Max results per section', parseInt, 10)
  .action(async (query: string, opts) => {
    try {
      // Fetch directory results (public, no auth)
      const baseUrl = getBaseUrl();
      const params = new URLSearchParams({ search: query });
      if (opts.category) params.set('category', opts.category);
      if (opts.limit) params.set('limit', String(opts.limit));

      const directoryPromise = fetch(
        `${baseUrl}/directory/apis?${params.toString()}`,
      )
        .then(async (res) => {
          if (!res.ok) return [];
          return (await res.json()) as Record<string, unknown>[];
        })
        .catch(() => [] as Record<string, unknown>[]);

      // Fetch own APIs (requires auth), then filter client-side
      const ownPromise = executeAction('dotmock_list_apis', {})
        .then((result) => {
          if (!result.success) return [];
          const apis = (result.data?.apis as Record<string, unknown>[]) || [];
          const q = query.toLowerCase();
          return apis.filter((a) => {
            const name = String(a.name || '').toLowerCase();
            const desc = String(a.description || '').toLowerCase();
            const slug = String(a.slug || '').toLowerCase();
            return name.includes(q) || desc.includes(q) || slug.includes(q);
          });
        })
        .catch(() => [] as Record<string, unknown>[]);

      const [directory, own] = await Promise.all([
        directoryPromise,
        ownPromise,
      ]);

      if (isJsonMode()) {
        json({ own, directory });
        return;
      }

      // Your APIs section
      if (own.length > 0) {
        info('YOUR APIS');
        table(
          ['Name', 'Type', 'URL'],
          own.slice(0, opts.limit).map((a) => [
            String(a.name || ''),
            String(a.type || 'rest'),
            String(a.url || a.mockUrl || ''),
          ]),
        );
        console.log('');
      }

      // Directory section
      if (directory.length > 0) {
        info('DIRECTORY');
        table(
          ['Name', 'Category', 'Description'],
          directory.slice(0, opts.limit).map((a) => [
            String(a.name || ''),
            String(a.category || ''),
            truncate(String(a.description || ''), 60),
          ]),
        );
      }

      if (own.length === 0 && directory.length === 0) {
        info(`No results found for "${query}".`);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Search failed (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Search failed: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '\u2026';
}
