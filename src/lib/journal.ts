/** LLM request journal helpers shared by `dotmock llm journal` and `@dotmock/cli/testing`. */

export interface JournalEntry {
  id?: string;
  timestamp?: number | string;
  method?: string;
  path?: string;
  provider?: string;
  endpoint?: string;
  model?: string;
  session?: string;
  api?: string;
  response?: {
    status?: number;
    fixtureId?: string;
    fixtureName?: string;
    chaosAction?: string;
    vcrProxied?: boolean;
    vcrReplayed?: boolean;
    durationMs?: number;
    content?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface JournalFilter {
  session?: string;
  /** Fixture name or id. */
  fixture?: string;
}

export function normalizeJournal(payload: unknown): JournalEntry[] {
  let source = payload;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const record = source as Record<string, unknown>;
    source = record.entries ?? record.journal ?? record.data ?? record.items;
  }
  if (!Array.isArray(source)) return [];
  return source.filter((entry): entry is JournalEntry => !!entry && typeof entry === "object");
}

export function fixtureOf(entry: JournalEntry): string {
  return String(entry.response?.fixtureName ?? entry.response?.fixtureId ?? entry.fixtureName ?? entry.fixtureId ?? "");
}

export function filterJournal(entries: JournalEntry[], filter: JournalFilter): JournalEntry[] {
  return entries.filter((entry) => {
    if (filter.session && (entry.session || "default") !== filter.session) return false;
    if (filter.fixture) {
      const names = [entry.response?.fixtureName, entry.response?.fixtureId, entry.fixtureName, entry.fixtureId];
      if (!names.some((name) => name === filter.fixture)) return false;
    }
    return true;
  });
}

export function entryKey(entry: JournalEntry): string {
  return String(entry.id ?? `${entry.timestamp}:${entry.method}:${entry.path}:${fixtureOf(entry)}`);
}

export function formatTimestamp(value: unknown): string {
  if (typeof value === "number") return new Date(value).toISOString();
  return value === undefined || value === null ? "" : String(value);
}
