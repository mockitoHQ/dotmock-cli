import { createServer } from "node:http";

export const API_ID = "0b6c1c9e-5d4f-4f0e-9c1a-2b3c4d5e6f70";

/**
 * Write tools the backend gates behind `approved: true`
 * (capability-registry `approval: 'interactive'`). The fake rejects them the
 * same way so CLI regressions that drop the flag fail in tests.
 */
export const INTERACTIVE_ACTIONS = new Set([
  "dotmock_delete_api",
  "dotmock_delete_llm_fixture",
  "dotmock_update_llm_runtime_settings",
  "dotmock_reset_llm_runtime",
  "dotmock_publish_definition",
  "dotmock_rollback_definition",
  "dotmock_delete_webhook_event",
  "dotmock_delete_realtime_target",
  "dotmock_delete_realtime_scenario",
  "dotmock_delete_state_entry",
  "dotmock_delete_state_resource",
  "dotmock_reset_state",
  "dotmock_restore_state_snapshot",
  "dotmock_delete_grpc_upstream",
]);

/** Minimal stand-in for the backend's API-key action endpoint. */
export function fakeBackend() {
  const state = {
    apis: [] as Array<Record<string, unknown>>,
    fixtures: [] as Array<Record<string, any>>,
    journal: [] as Array<Record<string, unknown>>,
    settings: {} as Record<string, unknown>,
    calls: [] as Array<{ action: string; params: Record<string, any> }>,
    /** Fail the next call to this action (with this fixture name, if set) with HTTP 400. */
    failOn: undefined as undefined | { action: string; name?: string; message?: string },
    /** validate-key response `plan`; current backend shape by default. */
    plan: {
      name: "free",
      limits: { usageBalanceMicrodollars: 1_000_000, activeWorkspaces: 1, collaborators: 0, realtimeConcurrentConnections: 0, providerBackedAuthoring: false, dryRuns: true },
      current: { apis: 0, requestsThisMonth: 0, teamMembers: 0 },
    } as unknown,
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.headers["x-api-key"] !== "mck_test") return send(401, { message: "bad key" });
    if (request.url === "/agent/actions/validate-key") {
      return send(200, { valid: true, teamId: "team-1", userId: "user-1", permissions: [], plan: state.plan });
    }
    if (request.url !== "/agent/actions/execute") return send(404, { message: "not found" });
    const { action, params } = body;
    state.calls.push({ action, params });
    const ok = (data: unknown) => send(200, { success: true, data });
    // Mirrors McpInternalController: errors come back as HTTP 4xx with a message.
    if (INTERACTIVE_ACTIONS.has(action) && params?.approved !== true) {
      return send(403, { message: `${action.replace(/^dotmock_/, "")} requires explicit confirmation from the current user turn.` });
    }
    if (state.failOn && state.failOn.action === action && (!state.failOn.name || state.failOn.name === params?.name)) {
      const message = state.failOn.message ?? `injected failure for ${action}`;
      state.failOn = undefined;
      return send(400, { message });
    }
    switch (action) {
      case "dotmock_list_apis": return ok(state.apis);
      case "dotmock_create_api": {
        // Like the backend, the stored subdomain gets uniqueness + team suffixes.
        const subdomain = `${params.subdomain}-x1y2-t1a2b3c4`;
        const api = { id: API_ID, name: params.name, subdomain, fullUrl: `https://${subdomain}.mock.rest` };
        state.apis.push(api);
        return ok(api);
      }
      case "dotmock_get_api": return ok(state.apis.find((api) => api.id === params.apiId) ?? {});
      case "dotmock_delete_api":
        state.apis = state.apis.filter((api) => api.id !== params.apiId);
        return ok({ deleted: true });
      case "dotmock_list_llm_fixtures": return ok(state.fixtures);
      case "dotmock_create_llm_fixture": {
        const { apiId: _apiId, ...fixture } = params;
        state.fixtures.push({ id: `fx-${state.fixtures.length + 1}-${Math.random().toString(36).slice(2, 6)}`, ...fixture });
        return ok(state.fixtures.at(-1));
      }
      case "dotmock_update_llm_fixture": {
        const { apiId: _apiId, fixtureId, ...patch } = params;
        const fixture = state.fixtures.find((f) => f.id === fixtureId);
        if (!fixture) return send(404, { message: "fixture not found" });
        // Backend deep-merges; explicit nulls clear a field.
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete fixture[key];
          else fixture[key] = value;
        }
        return ok(fixture);
      }
      case "dotmock_delete_llm_fixture":
        state.fixtures = state.fixtures.filter((f) => f.id !== params.fixtureId);
        return ok({ deleted: true });
      case "dotmock_get_llm_runtime_settings": return ok(state.settings);
      case "dotmock_update_llm_runtime_settings":
        state.settings = { ...state.settings, ...params.settings };
        return ok(state.settings);
      case "dotmock_reset_llm_sequences": return ok({ reset: true, apiId: params.apiId, session: params.session ?? null });
      case "dotmock_get_llm_journal":
        return ok(state.journal.filter((e) => !params.session || (e.session ?? "default") === params.session).reverse());
      default: return send(400, { message: `unexpected action ${action}` });
    }
  });
  return { state, server };
}
