import { Command } from "commander";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { executeAction } from "../actions.js";
import { isJsonMode, json, success, table } from "../output.js";
import { readStructuredFile } from "../structured-input.js";

function walkProto(directory: string, root = directory): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) Object.assign(result, walkProto(path, root));
    else if (entry.endsWith(".proto")) result[relative(root, path).replaceAll("\\", "/")] = readFileSync(path, "utf8");
  }
  return result;
}

export function contractInput(pathValue: string) {
  const path = resolve(pathValue);
  if (statSync(path).isDirectory()) {
    const sources = walkProto(path);
    if (!Object.keys(sources).length) throw new Error("The directory does not contain .proto files.");
    return { sources, roots: Object.keys(sources) };
  }
  if (path.endsWith(".proto")) return { sources: { [basename(path)]: readFileSync(path, "utf8") }, roots: [basename(path)] };
  if (path.endsWith(".json")) return { descriptorSetJson: JSON.parse(readFileSync(path, "utf8")) };
  return { descriptorSetBase64: readFileSync(path).toString("base64") };
}

function onOff(value: string): boolean {
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  throw new Error("Use on or off.");
}

const importContract = new Command("import")
  .description("Compile a .proto file/directory or import a FileDescriptorSet")
  .requiredOption("--api <id>", "gRPC workspace ID")
  .requiredOption("--from <path>", ".proto file, source directory, or descriptor set")
  .action(async (options) => {
    const result = await executeAction<any>("dotmock_import_grpc_contract", { apiId: options.api, contract: contractInput(options.from) });
    if (isJsonMode()) json(result); else success(`Imported ${result.services?.length || 0} services with digest ${result.digest?.slice(0, 12)}.`);
  });

const services = new Command("services")
  .description("List protobuf services and RPC modes")
  .requiredOption("--api <id>", "gRPC workspace ID")
  .action(async (options) => {
    const result = await executeAction<any[]>("dotmock_list_grpc_services", { apiId: options.api });
    const rows = result.flatMap((service) => (service.methods || []).map((method: any) => [service.name, method.name, method.clientStreaming && method.serverStreaming ? "bidi" : method.clientStreaming ? "client-stream" : method.serverStreaming ? "server-stream" : "unary", method.inputType, method.outputType]));
    if (isJsonMode()) json(result); else table(["Service", "Method", "Mode", "Input", "Output"], rows);
  });

const configure = new Command("configure")
  .description("Replace one RPC's deterministic behavior")
  .requiredOption("--api <id>", "gRPC workspace ID")
  .requiredOption("--method <full-name>", "Fully qualified /package.Service/Method")
  .requiredOption("--from <file>", "JSON or YAML behavior file")
  .action(async (options) => {
    const result = await executeAction("dotmock_configure_grpc_method", { apiId: options.api, methodId: options.method, behavior: readStructuredFile(options.from) });
    if (isJsonMode()) json(result); else success(`${options.method} configured.`);
  });

const settings = new Command("settings")
  .description("Inspect or update reflection and health services")
  .requiredOption("--api <id>", "gRPC workspace ID")
  .option("--reflection <on|off>", "Enable or disable server reflection", onOff)
  .option("--health <on|off>", "Enable or disable grpc.health.v1", onOff)
  .action(async (options) => {
    if (options.reflection === undefined && options.health === undefined) {
      const workspace = await executeAction<any>("dotmock_get_grpc_workspace", { apiId: options.api });
      const result = { reflectionEnabled: workspace?.reflectionEnabled ?? false, healthEnabled: workspace?.healthEnabled ?? false };
      if (isJsonMode()) json(result);
      else table(["Service", "Status"], [["Reflection", result.reflectionEnabled ? "on" : "off"], ["Health", result.healthEnabled ? "on" : "off"]]);
      return;
    }
    const result = await executeAction<any>("dotmock_update_grpc_settings", {
      apiId: options.api,
      settings: {
        ...(options.reflection !== undefined ? { reflectionEnabled: options.reflection } : {}),
        ...(options.health !== undefined ? { healthEnabled: options.health } : {}),
      },
    });
    if (isJsonMode()) json(result); else success("gRPC service settings updated.");
  });

const test = new Command("test")
  .description("Run a safe or live unary/streaming RPC transcript")
  .requiredOption("--api <id>", "gRPC workspace ID")
  .requiredOption("--service <name>", "Fully qualified service")
  .requiredOption("--method <name>", "RPC method")
  .requiredOption("--from <file>", "ProtoJSON message or message array")
  .option("--metadata <file>", "JSON or YAML metadata map")
  .option("--live", "Persist state and capture traffic")
  .action(async (options) => {
    const input = readStructuredFile(options.from);
    const result = await executeAction<any>("dotmock_run_grpc_test", { apiId: options.api, service: options.service, method: options.method, ...(Array.isArray(input) ? { messages: input } : { message: input }), metadata: options.metadata ? readStructuredFile(options.metadata) : {}, mode: options.live ? "live" : "dryRun", ...(options.live ? { approved: true } : {}) });
    json(result);
  });

const traffic = new Command("traffic")
  .description("List decoded gRPC traffic")
  .requiredOption("--api <id>", "gRPC workspace ID")
  .option("--limit <n>", "Record count", Number, 50)
  .action(async (options) => {
    const result = await executeAction<any[]>("dotmock_list_grpc_traffic", { apiId: options.api, limit: options.limit });
    if (isJsonMode()) json(result); else table(["Time", "Service", "Method", "Status", "Source", "ID"], result.map((record) => [record.startedAt, record.service, record.method, String(record.status?.code ?? 0), record.source, record.id]));
  });

const promote = new Command("promote")
  .description("Promote a recorded call into an active conditional case")
  .requiredOption("--api <id>", "gRPC workspace ID")
  .requiredOption("--traffic <id>", "Traffic record ID")
  .requiredOption("--when <expression>", "DotMock matching expression")
  .option("--name <name>", "Case name")
  .option("--yes", "Approve the configuration mutation")
  .action(async (options) => {
    if (!options.yes) throw new Error("Traffic promotion changes active mock behavior. Re-run with --yes after reviewing the capture and expression.");
    const result = await executeAction("dotmock_promote_grpc_traffic", { apiId: options.api, trafficId: options.traffic, when: options.when, name: options.name, approved: true });
    if (isJsonMode()) json(result); else success("Recorded call promoted.");
  });

const upstreamGet = new Command("get")
  .description("Show redacted managed upstream settings")
  .requiredOption("--api <id>", "gRPC workspace ID")
  .action(async (options) => {
    const result = await executeAction<any>("dotmock_get_grpc_upstream", { apiId: options.api });
    if (isJsonMode()) json(result);
    else if (!result) success("No managed upstream is configured.");
    else table(["Target", "TLS", "Custom CA", "mTLS", "Enabled"], [[result.target, result.tls ? "yes" : "no", result.hasCustomCA ? "yes" : "no", result.hasClientCertificate ? "yes" : "no", result.enabled ? "yes" : "no"]]);
  });

const upstreamSet = new Command("set")
  .description("Save an encrypted TLS or mTLS upstream configuration")
  .requiredOption("--api <id>", "gRPC workspace ID")
  .requiredOption("--from <file>", "JSON or YAML upstream configuration")
  .action(async (options) => {
    const result = await executeAction<any>("dotmock_save_grpc_upstream", { apiId: options.api, upstream: readStructuredFile(options.from) });
    if (isJsonMode()) json(result); else success("Managed gRPC upstream saved. Credentials remain write-only.");
  });

const upstreamDelete = new Command("delete")
  .description("Delete the managed upstream and encrypted credentials")
  .requiredOption("--api <id>", "gRPC workspace ID")
  .option("--yes", "Approve credential deletion")
  .action(async (options) => {
    if (!options.yes) throw new Error("Deleting the upstream is destructive. Re-run with --yes.");
    const result = await executeAction<any>("dotmock_delete_grpc_upstream", { apiId: options.api, approved: true });
    if (isJsonMode()) json(result); else success("Managed gRPC upstream deleted.");
  });

const upstream = new Command("upstream")
  .description("Manage TLS and mTLS upstream proxy settings")
  .addCommand(upstreamGet)
  .addCommand(upstreamSet)
  .addCommand(upstreamDelete);

export const grpcCommand = new Command("grpc")
  .description("Manage protobuf contracts, RPC behavior, tests, and traffic")
  .addCommand(importContract)
  .addCommand(services)
  .addCommand(configure)
  .addCommand(settings)
  .addCommand(test)
  .addCommand(traffic)
  .addCommand(promote)
  .addCommand(upstream);
