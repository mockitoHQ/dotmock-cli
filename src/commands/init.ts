import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { PROJECT_SCHEMA_VERSION, renderProjectYaml, starterLlmProject, type ProjectConfig } from "../lib/project-config.js";
import { error, info, isJsonMode, json, success } from "../output.js";

export const initCommand = new Command("init")
  .description("Scaffold a local dotmock.yaml project for `dotmock serve`")
  .option("--llm", "Starter LLM fixtures: greeting, tool-call round trip, structured output, refusal, rate limit (default)")
  .option("--openapi <spec>", "Add an OpenAPI mock backed by this spec file (path relative to the project file)")
  .option("--name <name>", "API name", "Assistant")
  .option("--subdomain <subdomain>", "API subdomain / path prefix", "assistant")
  .option("-o, --output <file>", "Project file", "dotmock.yaml")
  .option("--force", "Overwrite an existing file")
  .action((opts) => {
    try {
      const path = resolve(opts.output);
      if (existsSync(path) && !opts.force) throw new Error(`${path} already exists (use --force to overwrite).`);
      const wantLlm = opts.llm || !opts.openapi;
      const config: ProjectConfig = wantLlm
        ? starterLlmProject(opts.name, opts.subdomain)
        : { schemaVersion: PROJECT_SCHEMA_VERSION, apis: [] };
      if (opts.openapi) {
        const subdomain = wantLlm ? "api" : opts.subdomain;
        config.apis.push({ name: wantLlm ? "REST API" : opts.name, subdomain, type: "openapi", spec: opts.openapi });
      }
      writeFileSync(path, renderProjectYaml(config));
      if (isJsonMode()) { json({ file: path, apis: config.apis.map((api) => ({ name: api.name, subdomain: api.subdomain, type: api.type })) }); return; }
      success(`Created ${path}`);
      info("Start it with: dotmock serve --config " + opts.output);
      if (wantLlm) info(`Then: export OPENAI_BASE_URL=http://127.0.0.1:8080/${opts.subdomain}/v1`);
    } catch (cause) {
      error(cause instanceof Error ? cause.message : String(cause));
      process.exitCode = 1;
    }
  });
