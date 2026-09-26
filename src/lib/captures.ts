/** Capture helpers ported from the Go CLI (`captures list|assert`). */

export interface CaptureFilter {
  method?: string;
  path?: string;
  bodyContains?: string;
}

export type Capture = Record<string, unknown>;

export function extractLogs(payload: unknown): Capture[] {
  let source: unknown = payload;
  if (source && typeof source === "object" && !Array.isArray(source) && "logs" in source) {
    source = (source as Record<string, unknown>).logs;
  }
  if (!Array.isArray(source)) throw new Error("capture payload did not include a logs array");
  return source.filter((item): item is Capture => !!item && typeof item === "object" && !Array.isArray(item));
}

function stringField(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
}

export function captureMethod(capture: Capture): string {
  const method = stringField(capture.method);
  if (method) return method;
  const request = capture.request as Capture | undefined;
  return request && typeof request === "object" ? stringField(request.method) : "";
}

export function capturePath(capture: Capture): string {
  for (const key of ["path", "url", "pathname"]) {
    const value = stringField(capture[key]);
    if (value) return value;
  }
  const request = capture.request as Capture | undefined;
  if (request && typeof request === "object") {
    for (const key of ["path", "url", "pathname"]) {
      const value = stringField(request[key]);
      if (value) return value;
    }
  }
  return "";
}

export function captureText(capture: Capture): string {
  try {
    return JSON.stringify(capture);
  } catch {
    return "";
  }
}

/** First capture matching all provided filters (method is case-insensitive, path exact, body substring). */
export function findCapture(logs: Capture[], filter: CaptureFilter): Capture | undefined {
  const method = filter.method?.toUpperCase();
  return logs.find((capture) => {
    if (method && captureMethod(capture).toUpperCase() !== method) return false;
    if (filter.path && capturePath(capture) !== filter.path) return false;
    if (filter.bodyContains && !captureText(capture).includes(filter.bodyContains)) return false;
    return true;
  });
}
