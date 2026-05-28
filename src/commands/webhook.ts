import { Command, Option } from 'commander';
import { readFileSync } from 'node:fs';
import { api, ApiError } from '../client.js';
import { error, info, isJsonMode, json, success, table } from '../output.js';
import {
  addWebhookSubscriber,
  findWebhookSubscribers,
  listWebhookSubscribers,
  removeWebhookSubscriber,
  WebhookSubscriber,
} from '../webhooks-config.js';

interface WebhookEvent {
  eventKey: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  contentType?: string;
  bodyTemplate?: unknown;
}

interface RenderedWebhookEvent {
  eventKey: string;
  deliveryId: string;
  timestamp: string;
  headers: Record<string, string>;
  body: unknown;
}

interface ActionResult<T> {
  success: boolean;
  data?: T;
  result?: T;
  error?: string;
  message?: string;
}

const eventCommand = new Command('event').description('Manage webhook events');
const urlCommand = new Command('url').description('Manage local webhook URLs');

eventCommand
  .command('create')
  .description('Create a webhook event definition')
  .requiredOption('--api <apiId>', 'API id')
  .requiredOption('--event <key>', 'Event key, for example invoice.created')
  .option('--name <name>', 'Display name')
  .option('--description <text>', 'Event description')
  .option('--from <file>', 'Read event body template or full definition JSON')
  .option('--content-type <type>', 'Payload content type', 'application/json')
  .option('--header <key:value>', 'Header to include when delivering', collect, [])
  .option('--disabled', 'Create event disabled')
  .action(async (opts) => {
    await run(async () => {
      const fileBody = opts.from ? readJsonFile(opts.from) : {};
      const fullDefinition = isPlainObject(fileBody) && hasEventDefinitionKeys(fileBody);
      const payload: Record<string, unknown> = fullDefinition
        ? { ...fileBody }
        : { bodyTemplate: opts.from ? fileBody : {} };

      payload.eventKey = opts.event;
      if (opts.name) payload.name = opts.name;
      if (opts.description) payload.description = opts.description;
      payload.contentType = opts.contentType;
      payload.headers = parseHeaders(opts.header);
      payload.enabled = opts.disabled ? false : payload.enabled ?? true;

      const event = await executeAction<WebhookEvent>(
        'mockito_create_webhook_event',
        {
          apiId: opts.api,
          event: payload,
        },
      );
      outputEvent(event, `Webhook event "${event.eventKey}" created.`);
    }, 'create webhook event');
  });

eventCommand
  .command('list')
  .alias('ls')
  .description('List webhook events')
  .requiredOption('--api <apiId>', 'API id')
  .action(async (opts) => {
    await run(async () => {
      const events = await executeAction<WebhookEvent[]>(
        'mockito_list_webhook_events',
        { apiId: opts.api },
      );
      if (isJsonMode()) {
        json(events);
        return;
      }
      if (events.length === 0) {
        success('No webhook events found.');
        return;
      }
      table(
        ['Event', 'Name', 'Enabled', 'Content Type'],
        events.map((event) => [
          event.eventKey,
          event.name || '',
          event.enabled === false ? 'no' : 'yes',
          event.contentType || 'application/json',
        ]),
      );
    }, 'list webhook events');
  });

eventCommand
  .command('get')
  .description('Get a webhook event definition')
  .requiredOption('--api <apiId>', 'API id')
  .requiredOption('--event <key>', 'Event key')
  .action(async (opts) => {
    await run(async () => {
      const event = await executeAction<WebhookEvent>(
        'mockito_get_webhook_event',
        {
          apiId: opts.api,
          eventKey: opts.event,
        },
      );
      outputEvent(event, `Webhook event "${event.eventKey}".`);
    }, 'get webhook event');
  });

eventCommand
  .command('update')
  .description('Update a webhook event definition')
  .requiredOption('--api <apiId>', 'API id')
  .requiredOption('--event <key>', 'Event key')
  .option('--name <name>', 'Display name')
  .option('--description <text>', 'Event description')
  .option('--from <file>', 'Read replacement body template JSON')
  .option('--content-type <type>', 'Payload content type')
  .option('--header <key:value>', 'Header to include when delivering', collect, [])
  .option('--enable', 'Enable event')
  .option('--disable', 'Disable event')
  .action(async (opts) => {
    await run(async () => {
      const payload: Record<string, unknown> = {};
      if (opts.name) payload.name = opts.name;
      if (opts.description) payload.description = opts.description;
      if (opts.from) payload.bodyTemplate = readJsonFile(opts.from);
      if (opts.contentType) payload.contentType = opts.contentType;
      if (opts.header.length > 0) payload.headers = parseHeaders(opts.header);
      if (opts.enable) payload.enabled = true;
      if (opts.disable) payload.enabled = false;

      const event = await executeAction<WebhookEvent>(
        'mockito_update_webhook_event',
        {
          apiId: opts.api,
          eventKey: opts.event,
          updates: payload,
        },
      );
      outputEvent(event, `Webhook event "${event.eventKey}" updated.`);
    }, 'update webhook event');
  });

eventCommand
  .command('delete')
  .alias('rm')
  .description('Delete a webhook event definition')
  .requiredOption('--api <apiId>', 'API id')
  .requiredOption('--event <key>', 'Event key')
  .action(async (opts) => {
    await run(async () => {
      await executeAction('mockito_delete_webhook_event', {
        apiId: opts.api,
        eventKey: opts.event,
      });
      if (isJsonMode()) {
        json({ deleted: true, api: opts.api, event: opts.event });
        return;
      }
      success(`Webhook event "${opts.event}" deleted.`);
    }, 'delete webhook event');
  });

urlCommand
  .command('add')
  .description('Attach a webhook mock to a local callback URL')
  .requiredOption('--api <apiId>', 'API id')
  .requiredOption('--name <name>', 'Local subscriber name')
  .requiredOption('--url <url>', 'Local callback URL')
  .addOption(
    new Option('--event <key>', 'Allowed event key')
      .argParser(collect)
      .default([]),
  )
  .option('--all', 'Subscribe this URL to every event')
  .action((opts) => {
    if (!isLocalUrl(opts.url)) {
      error('Webhook URLs must point to localhost, 127.0.0.1, or [::1].');
      process.exitCode = 1;
      return;
    }
    const eventKeys = opts.all ? ['*'] : opts.event;
    if (eventKeys.length === 0) {
      error('Provide at least one --event or use --all.');
      process.exitCode = 1;
      return;
    }

    const subscriber = addWebhookSubscriber({
      apiId: opts.api,
      name: opts.name,
      url: opts.url,
      eventKeys,
    });
    outputSubscriber(subscriber, `Webhook URL "${subscriber.name}" saved.`);
  });

urlCommand
  .command('list')
  .alias('ls')
  .description('List local webhook callback URLs')
  .option('--api <apiId>', 'Filter by API id')
  .action((opts) => {
    const subscribers = listWebhookSubscribers(opts.api);
    outputSubscribers(subscribers);
  });

urlCommand
  .command('remove')
  .alias('rm')
  .description('Remove a local webhook callback URL')
  .requiredOption('--api <apiId>', 'API id')
  .requiredOption('--name <name>', 'Subscriber name or id')
  .action((opts) => {
    const subscriber = removeWebhookSubscriber(opts.api, opts.name);
    if (!subscriber) {
      error(`Webhook URL "${opts.name}" not found.`);
      process.exitCode = 1;
      return;
    }
    if (isJsonMode()) {
      json({ deleted: true, subscriber });
      return;
    }
    success(`Webhook URL "${subscriber.name}" removed.`);
  });

urlCommand
  .command('test')
  .description('POST a ping payload to a local callback URL')
  .requiredOption('--api <apiId>', 'API id')
  .requiredOption('--name <name>', 'Subscriber name or id')
  .action(async (opts) => {
    const [subscriber] = findWebhookSubscribers({
      apiId: opts.api,
      name: opts.name,
      all: true,
    });
    if (!subscriber) {
      error(`Webhook URL "${opts.name}" not found.`);
      process.exitCode = 1;
      return;
    }
    await postToSubscriber(subscriber, {
      eventKey: 'dotmock.ping',
      deliveryId: 'local-test',
      timestamp: new Date().toISOString(),
      headers: { 'Content-Type': 'application/json' },
      body: { ping: true },
    }).then((result) => {
      if (isJsonMode()) {
        json(result);
        return;
      }
      if (result.ok) {
        success(`Webhook URL "${subscriber.name}" responded ${result.status}.`);
      } else {
        error(result.error || `Webhook URL responded ${result.status}.`);
        process.exitCode = 1;
      }
    });
  });

const triggerCommand = new Command('trigger')
  .description('Render an event from the cloud and POST it to local URLs')
  .requiredOption('--api <apiId>', 'API id')
  .requiredOption('--event <key>', 'Event key')
  .option('--url <name>', 'Only deliver to one local subscriber name or id')
  .option('--all', 'Deliver to every local subscriber for this API')
  .option('--data <json>', 'Inline JSON data to merge into the rendered body')
  .option('--from <file>', 'Read JSON data from a file')
  .option('--dry-run', 'Render and print without POSTing')
  .action(async (opts) => {
    await run(async () => {
      const data = opts.from
        ? readJsonFile(opts.from)
        : opts.data
          ? parseJson(opts.data, '--data')
          : {};

      if (!isPlainObject(data)) {
        error('Trigger data must be a JSON object.');
        process.exitCode = 1;
        return;
      }

      const rendered = await executeAction<RenderedWebhookEvent>(
        'mockito_render_webhook_event',
        {
          apiId: opts.api,
          eventKey: opts.event,
          data,
        },
      );
      const subscribers = findWebhookSubscribers({
        apiId: opts.api,
        eventKey: opts.event,
        name: opts.url,
        all: opts.all,
      });

      if (opts.dryRun) {
        json({ rendered, targets: subscribers });
        return;
      }

      if (subscribers.length === 0) {
        error('No matching local webhook URLs. Add one with `dotmock webhook url add`.');
        process.exitCode = 1;
        return;
      }

      const results = await Promise.all(
        subscribers.map((subscriber) => postToSubscriber(subscriber, rendered)),
      );
      if (isJsonMode()) {
        json(results);
        return;
      }
      table(
        ['Name', 'URL', 'Status'],
        results.map((result) => [
          result.name,
          result.url,
          result.ok ? String(result.status) : result.error || 'failed',
        ]),
      );
      if (results.some((result) => !result.ok)) {
        process.exitCode = 1;
      } else {
        success(`Delivered "${opts.event}" to ${results.length} URL(s).`);
      }
    }, 'trigger webhook');
  });

export const webhookCommand = new Command('webhook')
  .description('Manage webhook mocks and trigger local callback delivery')
  .addCommand(eventCommand)
  .addCommand(urlCommand)
  .addCommand(triggerCommand);

async function postToSubscriber(
  subscriber: WebhookSubscriber,
  rendered: RenderedWebhookEvent,
) {
  try {
    const response = await fetch(subscriber.url, {
      method: 'POST',
      headers: rendered.headers,
      body:
        typeof rendered.body === 'string'
          ? rendered.body
          : JSON.stringify(rendered.body),
    });
    return {
      name: subscriber.name,
      url: subscriber.url,
      status: response.status,
      ok: response.ok,
    };
  } catch (err) {
    return {
      name: subscriber.name,
      url: subscriber.url,
      status: 0,
      ok: false,
      error: (err as Error).message,
    };
  }
}

async function executeAction<T = unknown>(
  action: string,
  params: Record<string, unknown>,
): Promise<T> {
  const response = await api<ActionResult<T>>('POST', '/internal/mcp/execute-action', {
    action,
    params,
    context: {},
  });

  if (!response.success) {
    throw new Error(response.message || response.error || 'Action failed.');
  }

  return (response.data ?? response.result) as T;
}

function outputEvent(event: WebhookEvent, message: string): void {
  if (isJsonMode()) {
    json(event);
    return;
  }
  success(message);
  info(`Event: ${event.eventKey}`);
  info(`Enabled: ${event.enabled === false ? 'no' : 'yes'}`);
}

function outputSubscriber(subscriber: WebhookSubscriber, message: string): void {
  if (isJsonMode()) {
    json(subscriber);
    return;
  }
  success(message);
  info(`URL: ${subscriber.url}`);
  info(`Events: ${subscriber.eventKeys.join(', ')}`);
}

function outputSubscribers(subscribers: WebhookSubscriber[]): void {
  if (isJsonMode()) {
    json(subscribers);
    return;
  }
  if (subscribers.length === 0) {
    success('No local webhook URLs found.');
    return;
  }
  table(
    ['Name', 'API', 'Events', 'URL'],
    subscribers.map((subscriber) => [
      subscriber.name,
      subscriber.apiId,
      subscriber.eventKeys.join(', '),
      subscriber.url,
    ]),
  );
}

async function run(action: () => Promise<void>, label: string): Promise<void> {
  try {
    await action();
  } catch (err) {
    if (err instanceof ApiError) {
      error(`Failed to ${label} (HTTP ${err.status}): ${err.message}`);
    } else {
      error(`Failed to ${label}: ${(err as Error).message}`);
    }
    process.exitCode = 1;
  }
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

function parseHeaders(values: string[]): Record<string, string> {
  return Object.fromEntries(
    values.map((value) => {
      const separator = value.indexOf(':');
      if (separator === -1) {
        throw new Error(`Invalid header "${value}". Use key:value.`);
      }
      return [
        value.slice(0, separator).trim(),
        value.slice(separator + 1).trim(),
      ];
    }),
  );
}

function readJsonFile(path: string): unknown {
  return parseJson(readFileSync(path, 'utf-8'), path);
}

function parseJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse JSON from ${source}.`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasEventDefinitionKeys(value: Record<string, unknown>): boolean {
  return (
    'eventKey' in value ||
    'bodyTemplate' in value ||
    'headers' in value ||
    'contentType' in value
  );
}

function isLocalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
