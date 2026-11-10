import { expect } from "bun:test";

// The SDK's HTTP client declarations do not compile under exactOptionalPropertyTypes,
// so tests speak JSON-RPC directly, as any stateless Streamable HTTP client would.
export async function rpc(
  url: URL,
  token: string,
  method: string,
  params: unknown,
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { result?: Record<string, unknown> };
}

export async function callTool(
  url: URL,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  const { result } = await rpc(url, token, "tools/call", {
    name,
    arguments: args,
  });
  return result as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
}
