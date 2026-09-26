import { Command } from "commander";
import { ApiError } from "../client.js";
import { fetchMockBaseUrl } from "../lib/mock-url.js";
import { error, isJsonMode, json } from "../output.js";

const urlCommand = new Command("url")
  .description("Print the mock base URL an app or test should call")
  .argument("<api>", "API ID or slug")
  .action(async (apiId: string) => {
    try {
      const baseUrl = await fetchMockBaseUrl(apiId);
      if (isJsonMode()) json({ apiId, baseUrl });
      else console.log(baseUrl);
    } catch (cause) {
      if (cause instanceof ApiError) error(`Failed to resolve mock URL (HTTP ${cause.status}): ${cause.message}`);
      else error(cause instanceof Error ? cause.message : String(cause));
      process.exitCode = 1;
    }
  });

export const mockCommand = new Command("mock")
  .description("Resolve mock runtime details")
  .addCommand(urlCommand);
