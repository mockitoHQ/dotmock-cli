import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contractInput, grpcCommand } from "../src/commands/grpc.js";

test("gRPC CLI exposes the complete management lifecycle", () => {
  assert.deepEqual(
    grpcCommand.commands.map((command) => command.name()).sort(),
    ["configure", "import", "promote", "services", "settings", "test", "traffic", "upstream"],
  );
  const promote = grpcCommand.commands.find((command) => command.name() === "promote");
  assert.ok(promote?.options.some((option) => option.long === "--yes"));
  const upstream = grpcCommand.commands.find((command) => command.name() === "upstream");
  assert.deepEqual(upstream?.commands.map((command) => command.name()).sort(), ["delete", "get", "set"]);
});

test("gRPC contract input preserves a multi-file protobuf source tree", () => {
  const directory = mkdtempSync(join(tmpdir(), "dotmock-grpc-cli-"));
  try {
    mkdirSync(join(directory, "users"));
    writeFileSync(join(directory, "common.proto"), 'syntax = "proto3"; package demo;');
    writeFileSync(join(directory, "users", "users.proto"), 'syntax = "proto3"; package demo; service Users {}');
    writeFileSync(join(directory, "ignored.txt"), "not protobuf");

    assert.deepEqual(contractInput(directory), {
      sources: {
        "common.proto": 'syntax = "proto3"; package demo;',
        "users/users.proto": 'syntax = "proto3"; package demo; service Users {}',
      },
      roots: ["common.proto", "users/users.proto"],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
