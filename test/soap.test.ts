import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { soapCommand, soapContractInput } from "../src/commands/soap.js";

test("SOAP CLI exposes contract, operation, tester, traffic, and settings workflows", () => {
  assert.deepEqual(
    soapCommand.commands.map((command) => command.name()).sort(),
    ["configure", "import", "operations", "promote", "settings", "test", "traffic"],
  );
  const promote = soapCommand.commands.find((command) => command.name() === "promote");
  assert.ok(promote?.options.some((option) => option.long === "--yes"));
});

test("SOAP contract input keeps a WSDL and adjacent named XSD sources", () => {
  const directory = mkdtempSync(join(tmpdir(), "dotmock-soap-cli-"));
  try {
    writeFileSync(join(directory, "users.wsdl"), '<definitions targetNamespace="urn:users"/>');
    writeFileSync(join(directory, "users.xsd"), '<schema targetNamespace="urn:users"/>');
    writeFileSync(join(directory, "ignored.txt"), "not a contract");
    assert.deepEqual(soapContractInput(directory), {
      wsdl: '<definitions targetNamespace="urn:users"/>',
      xsdSources: { "users.xsd": '<schema targetNamespace="urn:users"/>' },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
