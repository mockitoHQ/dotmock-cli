import { Command } from 'commander';
import { getApiKey, getBaseUrl } from '../config.js';
import { ApiError } from '../client.js';
import { success, error, info, json, isJsonMode, table } from '../output.js';

interface ValidateKeyResponse {
  valid: boolean;
  teamId?: string;
  userId?: string;
  permissions?: string[];
  plan?: {
    name: string;
    limits: {
      apis: number;
      requestsPerMonth: number;
      teamMembers: number;
      customDomains: number;
    };
    current: {
      apis: number;
      requestsThisMonth: number;
      teamMembers: number;
    };
  };
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

      if (!result.valid) {
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
          plan: result.plan,
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

      if (result.plan) {
        console.log('');
        table(
          ['Resource', 'Used', 'Limit'],
          [
            ['Plan', result.plan.name, '—'],
            [
              'APIs',
              String(result.plan.current.apis),
              String(result.plan.limits.apis),
            ],
            [
              'Requests/month',
              result.plan.current.requestsThisMonth.toLocaleString(),
              result.plan.limits.requestsPerMonth.toLocaleString(),
            ],
            [
              'Team members',
              String(result.plan.current.teamMembers),
              String(result.plan.limits.teamMembers),
            ],
          ],
        );
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
