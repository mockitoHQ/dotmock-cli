// Shared types and delivery transport for webhook commands
// (webhook.ts, commands/webhook-listen.ts).

export interface WebhookDeliveryTarget {
  type: 'remote' | 'local';
  url?: string;
  listenerId?: string;
}

export interface WebhookDeliveryAttempt {
  url: string;
  status: number;
  ok: boolean;
  latencyMs: number;
  /** ISO timestamp captured when the attempt completed. */
  at: string;
  error?: string;
}

/** Attempt record shape required by the backend's delivery-result DTO. */
export interface WebhookDeliveryAttemptResult {
  attempt: number;
  statusCode?: number;
  ok: boolean;
  error?: string;
  at: string;
}

export interface WebhookDeliveryResultPayload {
  statusCode?: number;
  attempts: WebhookDeliveryAttemptResult[];
  latencyMs?: number;
  error?: string;
}

export interface WebhookDelivery {
  id: string;
  apiId: string;
  eventKey: string;
  provider?: string;
  source: string;
  retryOf?: string;
  status: 'queued' | 'delivering' | 'delivered' | 'failed';
  target: WebhookDeliveryTarget;
  request: {
    headers: Record<string, string>;
    body: unknown;
    signature?: string;
  };
  result?: WebhookDeliveryResultPayload;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookListener {
  listenerId: string;
  apiId: string;
  label?: string;
  forwardUrls: string[];
  lastSeenAt: string;
}

export interface WebhookQueuePayload {
  deliveryId: string;
  eventKey: string;
  headers: Record<string, string>;
  body: unknown;
}

export function isLocalUrl(value: string): boolean {
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

/**
 * POSTs a rendered webhook payload to a single URL and reports the outcome,
 * including wall-clock latency. Never throws — network failures are
 * captured in the returned result.
 */
const FORWARD_TIMEOUT_MS = 10_000;

export async function deliverWebhookPayload(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<WebhookDeliveryAttempt> {
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    return {
      url,
      status: response.status,
      ok: response.ok,
      latencyMs: Date.now() - start,
      at: new Date().toISOString(),
    };
  } catch (err) {
    const error =
      (err as Error).name === 'TimeoutError'
        ? `timeout after ${FORWARD_TIMEOUT_MS}ms`
        : (err as Error).message;
    return {
      url,
      status: 0,
      ok: false,
      latencyMs: Date.now() - start,
      at: new Date().toISOString(),
      error,
    };
  }
}
