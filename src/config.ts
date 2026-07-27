import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DotmockConfig {
  apiKey?: string;
  baseUrl?: string;
  appUrl?: string;
  teamId?: string;
}

const CONFIG_DIR = join(homedir(), '.dotmock');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export function getApiKey(): string | null {
  const envKey = process.env.DOTMOCK_API_KEY;
  if (envKey) return envKey;

  const config = readConfig();
  return config?.apiKey ?? null;
}

export function getBaseUrl(): string {
  const envUrl = process.env.DOTMOCK_API_URL;
  if (envUrl) return envUrl;

  const config = readConfig();
  return config?.baseUrl ?? 'https://dotmock.com/api';
}

export function getAppUrl(): string {
  const envUrl = process.env.DOTMOCK_APP_URL;
  if (envUrl) return envUrl;

  const config = readConfig();
  return config?.appUrl ?? 'https://dotmock.com';
}

export function readConfig(): DotmockConfig | null {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as DotmockConfig;
  } catch {
    return null;
  }
}

export function writeConfig(config: DotmockConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  });
}

export function deleteConfig(): void {
  try {
    if (existsSync(CONFIG_FILE)) {
      unlinkSync(CONFIG_FILE);
    }
  } catch {
    // Ignore errors when file doesn't exist
  }
}
