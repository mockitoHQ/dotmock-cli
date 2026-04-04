import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { getBaseUrl, writeConfig, deleteConfig, readConfig } from '../config.js';
import { ApiError } from '../client.js';
import { success, error, info, json, isJsonMode } from '../output.js';

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

async function promptForKey(): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr, // Use stderr so prompts don't mix with JSON output
  });

  return new Promise((resolve) => {
    rl.question('Enter your API key (mck_...): ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function validateKey(apiKey: string): Promise<ValidateKeyResponse> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/internal/mcp/validate-key`;

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

  return (await response.json()) as ValidateKeyResponse;
}

export const loginCommand = new Command('login')
  .description('Authenticate with your dotMock API key')
  .argument('[key]', 'API key (mck_...)')
  .action(async (key?: string) => {
    try {
      const apiKey = key || (await promptForKey());

      if (!apiKey) {
        error('No API key provided.');
        process.exitCode = 1;
        return;
      }

      if (!apiKey.startsWith('mck_')) {
        error('Invalid API key format. Keys start with "mck_".');
        process.exitCode = 1;
        return;
      }

      info('Validating API key...');

      const result = await validateKey(apiKey);

      if (!result.valid) {
        error('Invalid API key. Check that your key is correct and active.');
        process.exitCode = 1;
        return;
      }

      // Preserve existing config (e.g. baseUrl) and store the key
      const existing = readConfig() || {};
      writeConfig({ ...existing, apiKey });

      if (isJsonMode()) {
        json({
          status: 'authenticated',
          teamId: result.teamId,
          plan: result.plan?.name,
        });
        return;
      }

      success('Logged in successfully!');

      if (result.plan) {
        info(`Team: ${result.teamId}`);
        info(`Plan: ${result.plan.name}`);
        info(
          `APIs: ${result.plan.current.apis}/${result.plan.limits.apis}`,
        );
        info(
          `Requests this month: ${result.plan.current.requestsThisMonth.toLocaleString()}/${result.plan.limits.requestsPerMonth.toLocaleString()}`,
        );
      }
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Authentication failed (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Authentication failed: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

export const logoutCommand = new Command('logout')
  .description('Remove stored API key')
  .action(() => {
    deleteConfig();

    if (isJsonMode()) {
      json({ status: 'logged_out' });
      return;
    }

    success('Logged out. API key removed from ~/.dotmock/config.json');
  });
