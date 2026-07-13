import { Command } from "commander";
import { executeAction } from "../actions.js";
import { ApiError } from "../client.js";
import { error, isJsonMode, json, success } from "../output.js";
import { readStructuredFile } from "../structured-input.js";

const reorderFixturesCommand = new Command("fixtures")
  .description("Set the first-match-wins order of LLM fixtures")
  .requiredOption("--api <id>", "API ID or slug")
  .option("--ids <ids>", "Comma-separated fixture IDs")
  .option("--from <file>", "JSON or YAML array of fixture IDs")
  .action(async (opts) => {
    try {
      const fixtureIds = opts.from
        ? readStructuredFile(opts.from)
        : String(opts.ids || "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
      if (!Array.isArray(fixtureIds) || !fixtureIds.length) {
        throw new Error("Provide --ids or --from with at least one fixture ID.");
      }
      if (fixtureIds.some((value) => typeof value !== "string" || !value)) {
        throw new Error("Every fixture ID must be a non-empty string.");
      }
      const result = await executeAction<unknown>(
        "dotmock_reorder_llm_fixtures",
        { apiId: opts.api, fixtureIds },
      );
      if (isJsonMode()) json(result);
      else success(`Reordered ${fixtureIds.length} fixture(s).`);
    } catch (cause) {
      if (cause instanceof ApiError) {
        error(`Failed to reorder fixtures (HTTP ${cause.status}): ${cause.message}`);
      } else {
        error(`Failed to reorder fixtures: ${cause instanceof Error ? cause.message : "Unknown error"}`);
      }
      process.exitCode = 1;
    }
  });

export const reorderCommand = new Command("reorder")
  .description("Reorder ordered DotMock resources")
  .addCommand(reorderFixturesCommand);
