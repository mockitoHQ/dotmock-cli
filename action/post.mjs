import { dotmockJson, getState, input, summary } from "./lib.mjs";

/** Journal summary for the run's session; never fails the job. */
export function summarize(entries) {
  const counts = new Map();
  let unmatched = 0;
  for (const entry of entries) {
    const response = entry.response ?? {};
    const name = response.fixtureName ?? response.fixtureId ?? entry.fixtureName ?? entry.fixtureId;
    if (!name) { unmatched += 1; continue; }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return { total: entries.length, unmatched, fixtures: [...counts.entries()].sort((a, b) => b[1] - a[1]) };
}

try {
  const bin = getState("bin");
  const apiId = getState("api_id");
  const session = getState("session");
  if (bin && apiId && input("journal-summary", "true") === "true") {
    const env = { ...process.env, DOTMOCK_API_KEY: input("api-key") || process.env.DOTMOCK_API_KEY };
    if (input("api-url")) env.DOTMOCK_API_URL = input("api-url");
    const entries = dotmockJson(bin, ["llm", "journal", apiId, "--session", session, "--limit", "1000"], env);
    const result = summarize(Array.isArray(entries) ? entries : []);
    console.log(`[dotmock] session ${session}: ${result.total} request(s), ${result.unmatched} unmatched`);
    for (const [name, count] of result.fixtures) console.log(`[dotmock]   ${name}: ${count}`);
    summary(
      [
        `### DotMock journal (session \`${session}\`)`,
        "",
        `${result.total} request(s), ${result.unmatched} without a matching fixture.`,
        "",
        "| Fixture | Requests |",
        "| --- | --- |",
        ...result.fixtures.map(([name, count]) => `| ${name} | ${count} |`),
        ...(result.unmatched ? [`| (no match) | ${result.unmatched} |`] : []),
        "",
      ].join("\n"),
    );
  }
} catch (error) {
  console.log(`::warning::DotMock journal summary unavailable: ${error instanceof Error ? error.message : String(error)}`);
}
