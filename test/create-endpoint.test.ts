import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEndpointUpdate } from "../src/commands/create-endpoint.js";

describe("buildEndpointUpdate", () => {
  it("creates one OpenAPI operation with success, latency, conditional, and fault behavior", () => {
    const update = buildEndpointUpdate(
      {
        openApiSpec: {
          openapi: "3.0.0",
          info: { title: "Test", version: "1.0.0" },
          paths: {},
        },
      },
      {
        api: "api",
        method: "get",
        path: "/users/{id}",
        body: '{"id":"{{param \\"id\\"}}","name":"Ada"}',
        header: [],
        delay: 1200,
        case: [
          '{"when":"query.state == \\"empty\\"","response":{"status":200,"body":[]}}',
        ],
        fault: [
          '{"probability":0.1,"response":{"status":502,"body":{"error":"Bad gateway"}}}',
        ],
        responseHook: ["11111111-1111-4111-8111-111111111111:invoice.created"],
      },
    );

    const operation = (update.openApiSpec.paths as any)["/users/{id}"].get;
    assert.equal(update.openApiSpec.openapi, "3.2.0");
    assert.equal(
      operation.responses["200"].content["application/json"].example.name,
      "Ada",
    );
    assert.equal(operation.parameters[0].name, "id");
    assert.equal(operation["x-dotmock"].delay, 1200);
    assert.equal(operation["x-dotmock"].cases.length, 1);
    assert.equal(operation["x-dotmock"].faults[0].response.status, 502);
    assert.deepEqual(operation["x-dotmock"].responseHooks, [
      {
        webhookApiId: "11111111-1111-4111-8111-111111111111",
        eventKey: "invoice.created",
      },
    ]);
  });

  it("creates native QUERY with a required JSON request body", () => {
    const update = buildEndpointUpdate(
      {
        openApiSpec: {
          openapi: "3.0.0",
          info: { title: "Test", version: "1.0.0" },
          paths: { "/search": { parameters: [] } },
        },
      },
      {
        api: "api",
        method: "query",
        path: "/search",
        requestExample: '{"filters":["active"]}',
        header: [],
        case: [],
        fault: [],
        responseHook: [],
      },
    );

    const operation = (update.openApiSpec.paths as any)["/search"].query;
    assert.equal(update.openApiSpec.openapi, "3.2.0");
    assert.equal(operation.requestBody.required, true);
    assert.deepEqual(operation.requestBody.content["application/json"], {
      schema: { type: "object" },
      example: { filters: ["active"] },
    });
    assert.deepEqual(
      (update.openApiSpec.paths as any)["/search"].parameters,
      [],
    );
  });

  it("does not overwrite an existing operation unless replacement is explicit", () => {
    const api = {
      openApiSpec: {
        openapi: "3.0.0",
        info: { title: "Test", version: "1.0.0" },
        paths: { "/users": { get: { responses: {} } } },
      },
    };
    assert.throws(
      () =>
        buildEndpointUpdate(api, {
          api: "api",
          method: "GET",
          path: "/users",
          header: [],
          case: [],
          fault: [],
          responseHook: [],
        }),
      /already exists/,
    );
  });
});
