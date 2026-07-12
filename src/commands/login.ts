import { Command } from 'commander';
import { execFile } from 'node:child_process';
import { getAppUrl, getBaseUrl, writeConfig, deleteConfig, readConfig } from '../config.js';
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

interface CliAuthSessionResponse {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

type CliAuthPollResponse =
  | {
      status: 'pending';
      interval: number;
      expiresAt: string;
    }
  | {
      status: 'authorized';
      cliKey: string;
      teamId: string;
      apiKeyId?: string;
    }
  | {
      status: 'denied' | 'consumed';
    };

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

async function createCliAuthSession(): Promise<CliAuthSessionResponse> {
  const response = await fetch(`${getBaseUrl()}/auth/cli/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientName: 'DotMock CLI' }),
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

  return (await response.json()) as CliAuthSessionResponse;
}

async function pollCliAuthSession(
  deviceCode: string,
): Promise<CliAuthPollResponse> {
  const response = await fetch(
    `${getBaseUrl()}/auth/cli/sessions/${deviceCode}`,
  );

  if (response.status === 410) {
    throw new Error('CLI login session expired.');
  }

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }
    throw new ApiError(response.status, body);
  }

  return (await response.json()) as CliAuthPollResponse;
}

function getLoginUrl(userCode: string): string {
  const url = new URL('/cli/authorize', getAppUrl());
  url.searchParams.set('user_code', userCode);
  return url.toString();
}

function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  return new Promise((resolve, reject) => {
    execFile(command, args, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loginWithApiKey(apiKey: string): Promise<void> {
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

  const existing = readConfig() || {};
  writeConfig({ ...existing, apiKey, teamId: result.teamId });

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
    info(`APIs: ${result.plan.current.apis}/${result.plan.limits.apis}`);
    info(
      `Requests this month: ${result.plan.current.requestsThisMonth.toLocaleString()}/${result.plan.limits.requestsPerMonth.toLocaleString()}`,
    );
  }
}

export const loginCommand = new Command('login')
  .description('Authenticate with DotMock in your browser')
  .option('--api-key <key>', 'Authenticate directly with an API key for CI or headless environments')
  .option('--print-url', 'Print the browser login URL without opening it')
  .action(async (opts: { apiKey?: string; printUrl?: boolean }) => {
    try {
      if (opts.apiKey) {
        await loginWithApiKey(opts.apiKey);
        return;
      }

      const session = await createCliAuthSession();
      const loginUrl = getLoginUrl(session.userCode);

      if (isJsonMode()) {
        json({
          status: 'browser_login_required',
          url: loginUrl,
          userCode: session.userCode,
          expiresIn: session.expiresIn,
          interval: session.interval,
        });
        return;
      }

      if (opts.printUrl) {
        console.log(loginUrl);
        return;
      }

      try {
        await openBrowser(loginUrl);
        success('Opened DotMock login in your browser.');
      } catch {
        info('Open this URL to continue login:');
        console.log(loginUrl);
      }

      info(`Waiting for approval code ${session.userCode}...`);

      const deadline = Date.now() + session.expiresIn * 1000;
      let interval = session.interval || 3;

      while (Date.now() < deadline) {
        await sleep(interval * 1000);
        const result = await pollCliAuthSession(session.deviceCode);

        if (result.status === 'pending') {
          interval = result.interval || interval;
          continue;
        }

        if (result.status === 'denied') {
          error('CLI login was denied in the browser.');
          process.exitCode = 1;
          return;
        }

        if (result.status === 'consumed') {
          error('CLI login session was already consumed. Run `dotmock login` again.');
          process.exitCode = 1;
          return;
        }

        if (result.status === 'authorized') {
          const existing = readConfig() || {};
          writeConfig({
            ...existing,
            apiKey: result.cliKey,
            teamId: result.teamId,
          });
          success('CLI login complete.');
          return;
        }
      }

      error('CLI login session expired. Run `dotmock login` again.');
      process.exitCode = 1;
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
