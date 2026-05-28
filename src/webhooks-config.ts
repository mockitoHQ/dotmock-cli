import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface WebhookSubscriber {
  id: string;
  apiId: string;
  name: string;
  url: string;
  eventKeys: string[];
  createdAt: string;
}

export interface WebhooksConfig {
  subscribers: WebhookSubscriber[];
}

const CONFIG_DIR = join(homedir(), '.dotmock');
const WEBHOOKS_FILE = join(CONFIG_DIR, 'webhooks.json');

export function readWebhooksConfig(): WebhooksConfig {
  try {
    if (!existsSync(WEBHOOKS_FILE)) return { subscribers: [] };
    const raw = readFileSync(WEBHOOKS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<WebhooksConfig>;
    return {
      subscribers: Array.isArray(parsed.subscribers)
        ? parsed.subscribers
        : [],
    };
  } catch {
    return { subscribers: [] };
  }
}

export function writeWebhooksConfig(config: WebhooksConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(WEBHOOKS_FILE, JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  });
}

export function addWebhookSubscriber(input: {
  apiId: string;
  name: string;
  url: string;
  eventKeys: string[];
}): WebhookSubscriber {
  const config = readWebhooksConfig();
  const subscriber: WebhookSubscriber = {
    id: randomUUID(),
    apiId: input.apiId,
    name: input.name,
    url: input.url,
    eventKeys: input.eventKeys,
    createdAt: new Date().toISOString(),
  };

  config.subscribers = config.subscribers.filter(
    (existing) =>
      !(existing.apiId === input.apiId && existing.name === input.name),
  );
  config.subscribers.push(subscriber);
  writeWebhooksConfig(config);
  return subscriber;
}

export function removeWebhookSubscriber(
  apiId: string,
  nameOrId: string,
): WebhookSubscriber | null {
  const config = readWebhooksConfig();
  const subscriber = config.subscribers.find(
    (candidate) =>
      candidate.apiId === apiId &&
      (candidate.name === nameOrId || candidate.id === nameOrId),
  );

  if (!subscriber) return null;

  config.subscribers = config.subscribers.filter(
    (candidate) => candidate.id !== subscriber.id,
  );
  writeWebhooksConfig(config);
  return subscriber;
}

export function listWebhookSubscribers(apiId?: string): WebhookSubscriber[] {
  const config = readWebhooksConfig();
  return apiId
    ? config.subscribers.filter((subscriber) => subscriber.apiId === apiId)
    : config.subscribers;
}

export function findWebhookSubscribers(input: {
  apiId: string;
  eventKey?: string;
  name?: string;
  all?: boolean;
}): WebhookSubscriber[] {
  const subscribers = listWebhookSubscribers(input.apiId);
  return subscribers.filter((subscriber) => {
    if (input.name && subscriber.name !== input.name && subscriber.id !== input.name) {
      return false;
    }
    if (input.all || !input.eventKey) return true;
    return (
      subscriber.eventKeys.includes('*') ||
      subscriber.eventKeys.includes(input.eventKey)
    );
  });
}
