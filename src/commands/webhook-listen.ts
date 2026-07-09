import { Command, Option } from 'commander';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { api, ApiError } from '../client.js';
import { error, info, isJsonMode } from '../output.js';
import { listWebhookSubscribers } from '../webhooks-config.js';
import {
  deliverWebhookPayload,
  isLocalUrl,
  WebhookDeliveryAttempt,
  WebhookQueuePayload,
} from '../webhook-transport.js';

interface ForwardTarget {
  url: string;
  eventKeys: string[];
}

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

export const webhookListenCommand = new Command('listen')
  .description(
    'Long-poll for webhook deliveries and forward them to local URLs',
  )
  .requiredOption('--api <apiId>', 'API id')
  .addOption(
    new Option(
      '--forward-to <url>',
      'Forward every event to this URL (repeatable)',
    )
      .argParser(collect)
      .default([]),
  )
  .option(
    '--label <name>',
    'Listener label shown to the backend (defaults to hostname)',
  )
  .option('--wait <seconds>', 'Long-poll wait time in seconds', '25')
  .action(async (opts) => {
    await listen({
      apiId: opts.api,
      forwardTo: opts.forwardTo as string[],
      label: opts.label as string | undefined,
      wait: opts.wait as string,
    });
  });

async function listen(opts: {
  apiId: string;
  forwardTo: string[];
  label?: string;
  wait: string;
}): Promise<void> {
  const json = isJsonMode();

  let targets: ForwardTarget[];
  try {
    targets = resolveForwardTargets(opts.apiId, opts.forwardTo);
  } catch (err) {
    error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  const waitSeconds = Number(opts.wait) > 0 ? Number(opts.wait) : 25;
  const listenerId = randomUUID();
  const label = opts.label || hostname();
  const uniqueUrls = [...new Set(targets.map((target) => target.url))];
  const forwardUrlsParam = uniqueUrls.join(',');

  let shuttingDown = false;
  let sessionDeliveryCount = 0;
  let currentController: AbortController | null = null;

  const handleSignal = () => {
    if (shuttingDown) {
      // Second signal: bail out immediately, skip cleanup.
      process.exit(1);
    }
    shuttingDown = true;
    currentController?.abort();
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  let spinner: Ora | undefined;

  if (json) {
    emitNdjson({
      type: 'ready',
      apiId: opts.apiId,
      listenerId,
      label,
      forwardUrls: uniqueUrls,
    });
  } else {
    console.log(
      chalk.bold(`Listening for webhooks on API ${chalk.cyan(opts.apiId)}`),
    );
    console.log(chalk.dim(`Listener ${listenerId.slice(0, 8)}`));
    console.log(chalk.dim('Forwarding to:'));
    for (const url of uniqueUrls) {
      console.log(chalk.dim(`  - ${url}`));
    }
    console.log('');
    spinner = ora('Waiting for webhooks…').start();
  }

  let backoffMs = INITIAL_BACKOFF_MS;
  let warnedOnce = false;
  let exitedForAuth = false;

  try {
    while (!shuttingDown) {
      const controller = new AbortController();
      currentController = controller;

      const query = new URLSearchParams({
        listenerId,
        wait: String(waitSeconds),
        label,
      });
      if (forwardUrlsParam) query.set('forwardUrls', forwardUrlsParam);

      let payload: WebhookQueuePayload | undefined;
      try {
        payload = await api<WebhookQueuePayload | undefined>(
          'GET',
          `/mock-apis/${opts.apiId}/webhook-queue/poll?${query.toString()}`,
          undefined,
          { signal: controller.signal },
        );
        backoffMs = INITIAL_BACKOFF_MS;
        warnedOnce = false;
      } catch (err) {
        currentController = null;
        if (shuttingDown) break;

        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          spinner?.stop();
          error(
            'Authentication failed while polling. Run `dotmock login` to re-authenticate.',
          );
          exitedForAuth = true;
          process.exitCode = 1;
          break;
        }

        if (!warnedOnce) {
          warnedOnce = true;
          const message = `Poll failed: ${(err as Error).message}. Retrying with backoff…`;
          if (json) {
            emitNdjson({ type: 'error', message });
          } else {
            spinner?.stop();
            console.error(chalk.yellow(`⚠ ${message}`));
            spinner?.start();
          }
        }

        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        continue;
      }

      currentController = null;
      if (shuttingDown) break;
      if (!payload) continue; // 204 No Content — loop immediately

      sessionDeliveryCount++;
      await handleDelivery(opts.apiId, payload, targets, json, spinner);
    }
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    spinner?.stop();

    if (!exitedForAuth) {
      await deleteListenerBestEffort(opts.apiId, listenerId);
    }

    if (json) {
      emitNdjson({ type: 'summary', deliveries: sessionDeliveryCount });
    } else {
      info(
        `Stopped. ${sessionDeliveryCount} deliver${sessionDeliveryCount === 1 ? 'y' : 'ies'} this session.`,
      );
    }
  }

  if (!exitedForAuth) {
    process.exit(0);
  }
}

async function handleDelivery(
  apiId: string,
  payload: WebhookQueuePayload,
  targets: ForwardTarget[],
  json: boolean,
  spinner: Ora | undefined,
): Promise<void> {
  const applicable = targets.filter((target) =>
    target.eventKeys.includes('*') || target.eventKeys.includes(payload.eventKey),
  );

  spinner?.stop();

  const attempts: WebhookDeliveryAttempt[] = [];
  for (const target of applicable) {
    const attempt = await deliverWebhookPayload(
      target.url,
      payload.headers,
      payload.body,
    );
    attempts.push(attempt);
    printFeedLine(payload.eventKey, attempt, json);
  }

  spinner?.start();

  const allOk = attempts.length > 0 && attempts.every((attempt) => attempt.ok);
  const reportBody = {
    status: allOk ? 'delivered' : 'failed',
    statusCode: attempts[0]?.status,
    attempts,
    latencyMs: attempts.length
      ? Math.max(...attempts.map((attempt) => attempt.latencyMs))
      : 0,
    url: attempts[0]?.url,
  };

  try {
    await api(
      'POST',
      `/mock-apis/${apiId}/webhook-deliveries/${payload.deliveryId}/result`,
      reportBody,
    );
  } catch (err) {
    const message = `Failed to report delivery result: ${(err as Error).message}`;
    if (json) {
      emitNdjson({ type: 'error', message });
    } else {
      spinner?.stop();
      console.error(chalk.yellow(`⚠ ${message}`));
      spinner?.start();
    }
  }
}

function printFeedLine(
  eventKey: string,
  attempt: WebhookDeliveryAttempt,
  json: boolean,
): void {
  if (json) {
    emitNdjson({ type: 'delivery', eventKey, ...attempt });
    return;
  }

  const time = chalk.dim(formatTime(new Date()));
  if (attempt.ok) {
    console.log(
      `${chalk.green('✓')} ${time} ${eventKey} → ${attempt.url} ${chalk.green(String(attempt.status))} ${attempt.latencyMs}ms`,
    );
  } else {
    const detail = attempt.error || String(attempt.status);
    console.log(
      `${chalk.red('✗')} ${time} ${eventKey} → ${attempt.url} ${chalk.red(detail)} ${attempt.latencyMs}ms`,
    );
  }
}

function resolveForwardTargets(
  apiId: string,
  forwardTo: string[],
): ForwardTarget[] {
  if (forwardTo.length > 0) {
    for (const url of forwardTo) {
      if (!isLocalUrl(url)) {
        throw new Error(
          `--forward-to URLs must point to localhost, 127.0.0.1, or [::1] (got "${url}").`,
        );
      }
    }
    return forwardTo.map((url) => ({ url, eventKeys: ['*'] }));
  }

  const subscribers = listWebhookSubscribers(apiId);
  if (subscribers.length === 0) {
    throw new Error(
      'No local webhook URLs configured for this API. Pass --forward-to <url> or run `dotmock webhook url add`.',
    );
  }
  return subscribers.map((subscriber) => ({
    url: subscriber.url,
    eventKeys: subscriber.eventKeys,
  }));
}

async function deleteListenerBestEffort(
  apiId: string,
  listenerId: string,
): Promise<void> {
  try {
    await api(
      'DELETE',
      `/mock-apis/${apiId}/webhook-listeners/${listenerId}`,
      undefined,
      { signal: AbortSignal.timeout(2000) },
    );
  } catch {
    // Best-effort cleanup only — the listener will expire via TTL anyway.
  }
}

function emitNdjson(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event));
}

function formatTime(date: Date): string {
  return date.toTimeString().slice(0, 8);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat(value);
}
