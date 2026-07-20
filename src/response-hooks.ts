import { asRecord, readStructuredValue } from "./structured-input.js";

export interface ResponseHookInput {
  webhookApiId: string;
  eventKey: string;
}

export function parseResponseHook(value: string): ResponseHookInput {
  if (value.startsWith("@") || value.trim().startsWith("{")) {
    const record = asRecord(
      readStructuredValue(value, "--response-hook"),
      "Response hook",
    );
    const webhookApiId = String(record.webhookApiId ?? "").trim();
    const eventKey = String(record.eventKey ?? "").trim();
    if (!webhookApiId || !eventKey) {
      throw new Error(
        "Response hook requires webhookApiId and eventKey.",
      );
    }
    return { webhookApiId, eventKey };
  }

  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error(
      'Invalid response hook. Use "<webhook-api-id>:<event-key>" or JSON.',
    );
  }
  return {
    webhookApiId: value.slice(0, separator).trim(),
    eventKey: value.slice(separator + 1).trim(),
  };
}
