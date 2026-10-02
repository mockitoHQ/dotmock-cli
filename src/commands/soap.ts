import { Command } from "commander";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { executeAction } from "../actions.js";
import { isJsonMode, json, success, table } from "../output.js";
import { readStructuredFile } from "../structured-input.js";

export function soapContractInput(pathValue: string) {
  const path = resolve(pathValue);
  if (statSync(path).isDirectory()) {
    const files = readdirSync(path);
    const wsdlName = files.find((name) => name.toLowerCase().endsWith(".wsdl"));
    if (!wsdlName)
      throw new Error("The directory does not contain a .wsdl file.");
    const xsdSources = Object.fromEntries(
      files
        .filter((name) => name.toLowerCase().endsWith(".xsd"))
        .map((name) => [name, readFileSync(resolve(path, name), "utf8")]),
    );
    return { wsdl: readFileSync(resolve(path, wsdlName), "utf8"), xsdSources };
  }
  if (
    !basename(path).toLowerCase().endsWith(".wsdl") &&
    !basename(path).toLowerCase().endsWith(".xml")
  )
    throw new Error("SOAP contracts must be WSDL or XML files.");
  return { wsdl: readFileSync(path, "utf8") };
}
function onOff(value: string) {
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  throw new Error("Use on or off.");
}
const importContract = new Command("import")
  .description("Import a WSDL and adjacent XSD files")
  .requiredOption("--api <id>", "SOAP workspace ID")
  .requiredOption("--from <path>", "WSDL file or source directory")
  .action(async (options) => {
    const result = await executeAction<any>("dotmock_import_soap_contract", {
      apiId: options.api,
      contract: soapContractInput(options.from),
    });
    if (isJsonMode()) json(result);
    else
      success(
        `Imported ${(result.services || []).flatMap((service: any) => service.operations || []).length} SOAP operations with digest ${result.digest?.slice(0, 12)}.`,
      );
  });
const operations = new Command("operations")
  .description("List WSDL services and operations")
  .requiredOption("--api <id>", "SOAP workspace ID")
  .action(async (options) => {
    const result = await executeAction<any[]>("dotmock_list_soap_operations", {
      apiId: options.api,
    });
    if (isJsonMode()) json(result);
    else
      table(
        ["Service", "Port", "Operation", "Version", "Action", "Path", "ID"],
        result.map((operation) => [
          operation.service,
          operation.port,
          operation.name,
          operation.soapVersion,
          operation.soapAction,
          operation.path,
          operation.id,
        ]),
      );
  });
const configure = new Command("configure")
  .description("Replace one SOAP operation behavior")
  .requiredOption("--api <id>", "SOAP workspace ID")
  .requiredOption("--operation <id>", "Service/port/operation ID")
  .requiredOption("--from <file>", "JSON or YAML behavior file")
  .action(async (options) => {
    const result = await executeAction("dotmock_configure_soap_operation", {
      apiId: options.api,
      operationId: options.operation,
      behavior: readStructuredFile(options.from),
    });
    if (isJsonMode()) json(result);
    else success(`${options.operation} configured.`);
  });
const settings = new Command("settings")
  .description("Inspect or update SOAP validation and upstream settings")
  .requiredOption("--api <id>", "SOAP workspace ID")
  .option("--strict <on|off>", "Enable strict XML validation", onOff)
  .option("--upstream <file>", "JSON or YAML upstream configuration")
  .action(async (options) => {
    if (options.strict === undefined && !options.upstream) {
      const workspace = await executeAction<any>("dotmock_get_soap_workspace", {
        apiId: options.api,
      });
      const result = {
        strictXmlValidation: workspace?.strictXmlValidation ?? false,
        upstream: workspace?.upstream || null,
      };
      if (isJsonMode()) json(result);
      else
        table(
          ["Setting", "Value"],
          [
            ["Strict XML", result.strictXmlValidation ? "on" : "off"],
            ["Upstream", result.upstream?.targetUrl || "not configured"],
          ],
        );
      return;
    }
    const result = await executeAction("dotmock_update_soap_settings", {
      apiId: options.api,
      settings: {
        ...(options.strict !== undefined
          ? { strictXmlValidation: options.strict }
          : {}),
        ...(options.upstream
          ? { upstream: readStructuredFile(options.upstream) }
          : {}),
      },
    });
    if (isJsonMode()) json(result);
    else success("SOAP settings updated.");
  });
const test = new Command("test")
  .description("Run a safe or live SOAP envelope")
  .requiredOption("--api <id>", "SOAP workspace ID")
  .requiredOption("--operation <id>", "Service/port/operation ID")
  .requiredOption("--from <file>", "SOAP XML envelope")
  .option("--version <1.1|1.2>", "SOAP version")
  .option("--action <uri>", "SOAPAction override")
  .option("--path <path>", "Endpoint path override")
  .option("--headers <file>", "JSON or YAML headers map")
  .option("--live", "Persist state and capture traffic")
  .action(async (options) => {
    const result = await executeAction("dotmock_run_soap_test", {
      apiId: options.api,
      operationId: options.operation,
      envelope: readFileSync(resolve(options.from), "utf8"),
      soapVersion: options.version,
      soapAction: options.action,
      path: options.path,
      headers: options.headers ? readStructuredFile(options.headers) : {},
      mode: options.live ? "live" : "dryRun",
      ...(options.live ? { approved: true } : {}),
    });
    json(result);
  });
const traffic = new Command("traffic")
  .description("List decoded SOAP traffic")
  .requiredOption("--api <id>", "SOAP workspace ID")
  .option("--limit <n>", "Record count", Number, 50)
  .action(async (options) => {
    const result = await executeAction<any[]>("dotmock_list_soap_traffic", {
      apiId: options.api,
      limit: options.limit,
    });
    if (isJsonMode()) json(result);
    else
      table(
        ["Time", "Operation", "Version", "Status", "Source", "ID"],
        result.map((record) => [
          record.startedAt,
          record.operation,
          record.soapVersion,
          String(record.responseStatus),
          record.source,
          record.id,
        ]),
      );
  });
const promote = new Command("promote")
  .description("Promote recorded SOAP traffic into a conditional case")
  .requiredOption("--api <id>", "SOAP workspace ID")
  .requiredOption("--traffic <id>", "Traffic record ID")
  .requiredOption("--when <expression>", "XPath-aware DotMock expression")
  .option("--name <name>", "Case name")
  .option("--yes", "Approve the configuration mutation")
  .action(async (options) => {
    if (!options.yes)
      throw new Error(
        "Traffic promotion changes active mock behavior. Re-run with --yes.",
      );
    const result = await executeAction("dotmock_promote_soap_traffic", {
      apiId: options.api,
      trafficId: options.traffic,
      when: options.when,
      name: options.name,
      approved: true,
    });
    if (isJsonMode()) json(result);
    else success("Recorded SOAP response promoted.");
  });
export const soapCommand = new Command("soap")
  .description(
    "Manage WSDL contracts, SOAP operation behavior, tests, and traffic",
  )
  .addCommand(importContract)
  .addCommand(operations)
  .addCommand(configure)
  .addCommand(settings)
  .addCommand(test)
  .addCommand(traffic)
  .addCommand(promote);
