import { createServer } from "node:http";

export const API_ID = "0b6c1c9e-5d4f-4f0e-9c1a-2b3c4d5e6f70";

/** Minimal stand-in for the backend's API-key action endpoint. */
export function fakeBackend() {
  const state = {
    apis: [] as Array<Record<string, unknown>>,
    fixtures: [] as Array<Record<string, any>>,
    journal: [] as Array<Record<string, unknown>>,
    calls: [] as Array<{ action: string; params: Record<string, any> }>,
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const { action, params } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.url !== "/agent/actions/execute" || request.headers["x-api-key"] !== "mck_test") return send(401, { message: "bad key" });
    state.calls.push({ action, params });
    const ok = (data: unknown) => send(200, { success: true, data });
    switch (action) {
      case "dotmock_list_apis": return ok(state.apis);
      case "dotmock_create_api": {
        const api = { id: API_ID, name: params.name, subdomain: params.subdomain, fullUrl: `https://${params.subdomain}-t1a2b3c4.mock.rest` };
        state.apis.push(api);
        return ok(api);
      }
      case "dotmock_get_api": return ok(state.apis.find((api) => api.id === params.apiId) ?? {});
      case "dotmock_list_llm_fixtures": return ok(state.fixtures);
      case "dotmock_create_llm_fixture": {
        const { apiId: _apiId, ...fixture } = params;
        state.fixtures.push({ id: `fx-${state.fixtures.length + 1}`, ...fixture });
        return ok(state.fixtures.at(-1));
      }
      case "dotmock_update_llm_fixture": {
        const { apiId: _apiId, fixtureId, ...patch } = params;
        const fixture = state.fixtures.find((f) => f.id === fixtureId);
        Object.assign(fixture!, patch);
        return ok(fixture);
      }
      case "dotmock_delete_llm_fixture":
        state.fixtures = state.fixtures.filter((f) => f.id !== params.fixtureId);
        return ok({ deleted: true });
      case "dotmock_update_llm_runtime_settings": return ok(params.settings);
      case "dotmock_reset_llm_sequences": return ok({ reset: true, apiId: params.apiId, session: params.session ?? null });
      case "dotmock_get_llm_journal":
        return ok(state.journal.filter((e) => !params.session || (e.session ?? "default") === params.session).reverse());
      default: return send(400, { message: `unexpected action ${action}` });
    }
  });
  return { state, server };
}

