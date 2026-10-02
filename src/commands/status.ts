import { Command } from 'commander';
import { getApiKey, getBaseUrl } from '../config.js';
import { ApiError } from '../client.js';
import { success, error, info, json, isJsonMode, table } from '../output.js';

interface ValidateKeyResponse {
  valid: boolean;
  teamId?: string;
  userId?: string;
  permissions?: string[];
  /** Shape varies by plan catalog version; render defensively. */
  plan?: {
    name?: string;
    limits?: Record<string, unknown> | null;
    current?: Record<string, unknown> | null;
  } | null;
}

/** Known limit keys (current plan catalog first, then legacy keys) with labels and formatters. */
const LIMIT_LABELS: Record<string, { label: string; format?: (value: number) => string; usage?: string[] }> = {
  usageBalanceMicrodollars: { label: 'Usage balance', format: (v) => `$${(v / 1_000_000).toFixed(2)}`, usage: ['usageMicrodollars', 'usedMicrodollars', 'spentMicrodollars'] },
  activeWorkspaces: { label: 'Active workspaces', usage: ['activeWorkspaces', 'apis'] },
  collaborators: { label: 'Collaborators', usage: ['collaborators', 'teamMembers'] },
  realtimeConcurrentConnections: { label: 'Realtime connections', usage: ['realtimeConcurrentConnections'] },
  realtimeConnectionMinutes: { label: 'Realtime minutes', usage: ['realtimeConnectionMinutes'] },
  realtimeOutboundDeliveries: { label: 'Realtime deliveries', usage: ['realtimeOutboundDeliveries'] },
  providerBackedAuthoring: { label: 'AI authoring' },
  dryRuns: { label: 'Dry runs' },
  apis: { label: 'APIs', usage: ['apis'] },
  requestsPerMonth: { label: 'Requests/month', usage: ['requestsThisMonth'] },
  teamMembers: { label: 'Team members', usage: ['teamMembers'] },
  customDomains: { label: 'Custom domains', usage: ['customDomains'] },
};

function humanize(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

function formatValue(value: unknown, format?: (value: number) => string): string {
  if (value === null) return 'unlimited';
  if (value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number' && Number.isFinite(value)) return format ? format(value) : value.toLocaleString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Rows for the plan table; never throws on missing or unexpected fields. */
export function planRows(plan: ValidateKeyResponse['plan']): string[][] {
  if (!plan || typeof plan !== 'object') return [];
  const limits = plan.limits && typeof plan.limits === 'object' ? plan.limits : {};
  const current = plan.current && typeof plan.current === 'object' ? plan.current : {};
  const rows: string[][] = [['Plan', String(plan.name ?? 'unknown'), '—']];
  const known = Object.keys(LIMIT_LABELS).filter((key) => key in limits);
  const unknown = Object.keys(limits).filter((key) => !(key in LIMIT_LABELS));
  for (const key of [...known, ...unknown]) {
    const meta = LIMIT_LABELS[key] ?? { label: humanize(key) };
    const usageKey = (meta.usage ?? [key]).find((candidate) => current[candidate] !== undefined);
    rows.push([meta.label, usageKey ? formatValue(current[usageKey], meta.format) : '—', formatValue(limits[key], meta.format)]);
  }
  return rows;
}

export const statusCommand = new Command('status')
  .description('Show current authentication status and account info')
  .action(async () => {
    try {
      const apiKey = getApiKey();

      if (!apiKey) {
        error('Not logged in. Run `dotmock login` to authenticate.');
        process.exitCode = 1;
        return;
      }

      const baseUrl = getBaseUrl();
      const url = `${baseUrl}/agent/actions/validate-key`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ apiKey }),
      });

      if (!response.ok) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = await response.text();
        }
        throw new ApiError(response.status, body);
      }

      const result = (await response.json()) as ValidateKeyResponse;

      if (!result?.valid) {
        error(
          'Stored API key is no longer valid. Run `dotmock login` to re-authenticate.',
        );
        process.exitCode = 1;
        return;
      }

      if (isJsonMode()) {
        json({
          authenticated: true,
          teamId: result.teamId,
          userId: result.userId,
          plan: result.plan ?? null,
          apiUrl: baseUrl,
        });
        return;
      }

      success('Authenticated');
      info(`API URL: ${baseUrl}`);
      info(`Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);

      if (result.teamId) {
        info(`Team: ${result.teamId}`);
      }

      const rows = planRows(result.plan);
      if (rows.length) {
        console.log('');
        table(['Resource', 'Used', 'Limit'], rows);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Status check failed (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Status check failed: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });
