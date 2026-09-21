import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

// Regression guard: get_structure was defined and exported by
// src/tools/structures.ts, and index.ts imported registerStructureTools, but
// nothing ever called it — so the tool silently never reached clients (and a
// deploy from main dropped it from a server that had it locally).
//
// This test asks the *server* what it exposes over the MCP protocol and
// compares that with everything the tool modules can register, discovered
// automatically: a new src/tools/*.ts module whose register function isn't
// wired into createServer() fails here without anyone remembering to list it.

type Register = (server: McpServer) => void;

const toolModules = import.meta.glob<Record<string, unknown>>("../src/tools/*.ts", {
  eager: true,
});

const registrars = Object.entries(toolModules).flatMap(([path, mod]) =>
  Object.entries(mod)
    .filter(([name, fn]) => /^register[A-Z]/.test(name) && typeof fn === "function")
    .map(([name, fn]) => ({ name, file: path.replace("../", ""), register: fn as Register }))
);

/** Tool names a server advertises to a client, via a real tools/list round trip. */
async function listToolNames(server: McpServer): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "server-tools-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

describe("server tool surface", () => {
  let exposed: Set<string>;

  beforeAll(async () => {
    exposed = new Set(await listToolNames(createServer()));
  });

  it("discovers the tool modules (guards the discovery itself)", () => {
    expect(registrars.length).toBeGreaterThan(0);
    expect(exposed.size).toBeGreaterThan(0);
  });

  it.each(registrars)("createServer() exposes every tool from $name ($file)", async ({ name, file, register }) => {
    const solo = new McpServer({ name: "solo", version: "0.0.0" });
    register(solo);
    const provided = await listToolNames(solo);

    expect(provided.length, `${name} registers no tools`).toBeGreaterThan(0);
    const missing = provided.filter((tool) => !exposed.has(tool));
    expect(
      missing,
      `${name} (${file}) defines tools the server never exposes — call it from createServer() in src/server.ts`
    ).toEqual([]);
  });

  it("exposes get_structure (the original regression)", () => {
    expect(exposed.has("get_structure")).toBe(true);
  });

  it("the stdio entry point serves createServer() and registers nothing on the side", () => {
    // index.ts can't be imported (it connects stdio and starts the heartbeat),
    // so pin its wiring: tools must come only from the tested createServer().
    const entry = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(entry).toMatch(/\bcreateServer\(\)/);
    expect(entry).not.toMatch(/\bregister\w+Tools\(/);
  });
});
