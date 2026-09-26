import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { renderLlmDefinitionYaml, slugify, starterLlmDefinition } from "../lib/llm-definition.js";
import { error, info, isJsonMode, json, success } from "../output.js";

export const initCommand = new Command("init")
  .description("Scaffold a dotmock.yaml LLM mock definition to apply to DotMock with `dotmock config apply`")
  .option("--llm", "Starter LLM fixtures: greeting, tool-call round trip, structured output, refusal, rate limit (default)")
  .option("--name <name>", "API name", "Assistant")
  .option("--subdomain <subdomain>", "Subdomain to request when the API is created (default: slug of --name)")
  .option("-o, --output <file>", "Definition file", "dotmock.yaml")
  .option("--force", "Overwrite an existing file")
  .action((opts) => {
    try {
      const path = resolve(opts.output);
      if (existsSync(path) && !opts.force) throw new Error(`${path} already exists (use --force to overwrite).`);
      const subdomain = opts.subdomain || slugify(opts.name) || "assistant";
      const definition = starterLlmDefinition(opts.name, subdomain);
      writeFileSync(path, renderLlmDefinitionYaml(definition));
      const fileArg = opts.output === "dotmock.yaml" ? "" : ` -f ${opts.output}`;
      const nextSteps = [
        "dotmock login",
        `dotmock config apply${fileArg}`,
        `dotmock llm connect ${subdomain}`,
      ];
      if (isJsonMode()) { json({ file: path, name: opts.name, subdomain, kind: "llm", nextSteps }); return; }
      success(`Created ${path}`);
      info("Next steps:");
      for (const [index, step] of nextSteps.entries()) info(`  ${index + 1}. ${step}`);
    } catch (cause) {
      error(cause instanceof Error ? cause.message : String(cause));
      process.exitCode = 1;
    }
  });
