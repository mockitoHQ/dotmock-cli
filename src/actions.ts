import { api } from "./client.js";

export interface ActionEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  result?: T;
  error?: string;
  message?: string;
}

export async function executeAction<T>(
  action: string,
  params: Record<string, unknown>,
): Promise<T> {
  const response = await api<ActionEnvelope<T>>(
    "POST",
    "/internal/mcp/execute-action",
    { action, params, context: {} },
  );

  if (!response.success) {
    throw new Error(response.message || response.error || `${action} failed`);
  }

  return (response.result ?? response.data) as T;
}
