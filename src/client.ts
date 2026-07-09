import { getApiKey, getBaseUrl } from './config.js';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? String((body as Record<string, unknown>).message)
        : `API request failed with status ${status}`;
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      'No API key found. Run `dotmock login` or set DOTMOCK_API_KEY.',
    );
  }

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
  };

  const requestInit: RequestInit = {
    method: method.toUpperCase(),
    headers,
  };

  if (body !== undefined) {
    requestInit.body = JSON.stringify(body);
  }

  if (options?.signal) {
    requestInit.signal = options.signal;
  }

  const response = await fetch(url, requestInit);

  if (!response.ok) {
    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = await response.text();
    }
    throw new ApiError(response.status, errorBody);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
