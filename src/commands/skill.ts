import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { error, isJsonMode, json, success } from "../output.js";

const files = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/api-discovery.md",
  "references/project-integration.md",
  "references/authentication-and-environments.md",
  "references/resilience-scenarios.md",
  "references/cli-workflows.md",
  "references/rules-and-matching.md",
  "references/state-and-actions.md",
  "references/protocols.md",
  "references/testing-and-debugging.md",
  "references/typescript-openapi.md",
  "references/tool-contracts.md",
  "references/fixtures-webhooks-and-approvals.md",
  "references/generated-v2-schema.md",
] as const;

type Agent = "codex" | "claude" | "cursor";
type Scope = "project" | "global";

const agentFolder: Record<Agent, string> = { codex: ".codex", claude: ".claude", cursor: ".cursor" };

function targets(agent: Agent | "auto", scope: Scope): Agent[] {
  if (agent !== "auto") return [agent];
  const base = scope === "global" ? homedir() : process.cwd();
  const detected = (Object.keys(agentFolder) as Agent[]).filter((item) => existsSync(join(base, agentFolder[item])));
  return detected.length ? detected : ["codex"];
}

async function install(agent: Agent, scope: Scope): Promise<string> {
  const base = scope === "global" ? homedir() : process.cwd();
  const destination = resolve(base, agentFolder[agent], "skills", "dotmock");
  const source = (process.env.DOTMOCK_SKILL_URL || "https://dotmock.com/api/skills/dotmock").replace(/\/$/, "");
  const localSource = process.env.DOTMOCK_SKILL_PATH;
  const content = await Promise.all(files.map(async (file) => {
    if (localSource) return [file, readFileSync(join(localSource, file), "utf8")] as const;
    const response = await fetch(`${source}/${file}`);
    if (!response.ok) throw new Error(`Could not download ${file} (HTTP ${response.status})`);
    return [file, await response.text()] as const;
  }));
  for (const [file, body] of content) {
    const output = join(destination, file);
    mkdirSync(resolve(output, ".."), { recursive: true });
    writeFileSync(output, body, { mode: 0o600 });
  }
  return destination;
}

const installCommand = new Command("install")
  .description("Install the DotMock authoring skill for a coding agent")
  .option("--agent <agent>", "auto, codex, claude, or cursor", "auto")
  .option("--scope <scope>", "project or global", "project")
  .action(async ({ agent, scope }) => {
    if (!["auto", "codex", "claude", "cursor"].includes(agent)) { error("Agent must be auto, codex, claude, or cursor."); process.exitCode = 1; return; }
    if (!["project", "global"].includes(scope)) { error("Scope must be project or global."); process.exitCode = 1; return; }
    try {
      const selected = targets(agent, scope);
      const installed = await Promise.all(selected.map((item) => install(item, scope)));
      if (isJsonMode()) json({ installed, agents: selected, scope });
      else for (const path of installed) success(`Installed DotMock skill at ${path}`);
    } catch (cause) {
      error(cause instanceof Error ? cause.message : "Skill installation failed");
      process.exitCode = 1;
    }
  });

export const skillCommand = new Command("skill")
  .alias("skills")
  .description("Install DotMock coding-agent skills")
  .addCommand(installCommand);
