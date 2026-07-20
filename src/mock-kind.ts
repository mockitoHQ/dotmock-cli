export const mockKinds = ["rest", "realtime", "graphql", "soap", "grpc", "llm", "webhook"] as const;

export type MockKind = (typeof mockKinds)[number];

export function parseMockKind(value: string): MockKind {
  if (mockKinds.includes(value as MockKind)) return value as MockKind;
  throw new Error("API type must be rest, realtime, graphql, soap, grpc, llm, or webhook.");
}

export function specificationTypeForKind(kind: MockKind) {
  if (kind === "rest") return "openapi";
  if (kind === "realtime") return "asyncapi";
  return kind;
}
