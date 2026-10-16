import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rescopeProjectMcp } from "../src/host";
import { createRuntime, findInstalledOmp, readSetting } from "../src/runtime";
import { type HostNamespace, type SessionLike, type SettingsLike } from "../src/types";

const runtime = createRuntime({} as HostNamespace, findInstalledOmp());
const { Settings } = await runtime.importModule<{
  Settings: { isolated(values?: Record<string, unknown>): SettingsLike };
}>("config/settings.ts");
interface FixtureTool {
  name: string;
  description: string;
}
interface FixtureManager {
  cwd: string;
  getTools(): FixtureTool[];
  discoverAndConnect(options: Record<string, unknown>): Promise<unknown>;
  disconnectAll(): Promise<void>;
}
const { MCPManager } = await runtime.importModule<{
  MCPManager: new (
    cwd: string,
    cache: unknown,
    loader: (cwd: string, options?: Record<string, unknown>) => Promise<unknown>,
  ) => FixtureManager;
}>("mcp/manager.ts");
const temporary: string[] = [];
const managers: FixtureManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.disconnectAll();
  while (temporary.length) await fs.rm(temporary.pop()!, { recursive: true, force: true });
});

test("reads real native Settings through registry handles", async () => {
  const settings = Settings.isolated({ "mcp.startupTimeoutMs": 0, "compaction.enabled": false });
  expect(await readSetting(runtime, settings, "mcp.startupTimeoutMs")).toBe(0);
  expect(await readSetting(runtime, settings, "compaction.enabled")).toBe(false);
  await expect(readSetting(runtime, settings, "not.a.setting")).rejects.toThrow(
    "Unknown omp setting",
  );
});

test("the same native MCP manager replaces A project tools with B and can restore A", async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "omp-nav-mcp-")));
  temporary.push(root);
  const a = join(root, "A");
  const b = join(root, "B");
  await fs.mkdir(a);
  await fs.mkdir(b);
  const server = join(root, "mcp-fixture.ts");
  await fs.writeFile(
    server,
    `import { createInterface } from "node:readline";
const scope = process.argv[2];
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: scope, version: "1" } };
  else if (request.method === "tools/list") result = { tools: [{ name: "identify", description: "project:" + scope, inputSchema: { type: "object", properties: {} } }] };
  else if (request.method === "tools/call") result = { content: [{ type: "text", text: scope }] };
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}`,
  );
  for (const [cwd, scope] of [
    [a, "A"],
    [b, "B"],
  ])
    await fs.writeFile(
      join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          fixture: {
            type: "stdio",
            command: process.execPath,
            args: [server, scope],
            timeout: 2_000,
          },
        },
      }),
    );
  const loadedPaths: string[] = [];
  const manager = new MCPManager(a, null, async (cwd, options) => {
    loadedPaths.push(cwd);
    const { mcpServers } = JSON.parse(await fs.readFile(join(cwd, ".mcp.json"), "utf8"));
    return {
      configs: options?.enableProjectConfig === false ? {} : mcpServers,
      exaApiKeys: [],
      sources: {
        fixture: {
          provider: "fixture",
          providerName: "Fixture",
          path: join(cwd, ".mcp.json"),
          level: "project",
        },
      },
    };
  });
  managers.push(manager);
  const settings = Settings.isolated({
    "mcp.startupTimeoutMs": 0,
    "mcp.enableProjectConfig": true,
  });
  const nativeScope = {
    settings,
    getSessionSpawns: () => "*",
    mcpManager: manager,
    enableMCP: true,
    effectiveExtensionRoots: () => ({
      explicit: [],
      mode: "explicit-only",
      configured: [],
      configuredLevel: "user",
    }),
  };
  let visible: FixtureTool[] = [];
  const session = {
    settings,
    getToolByName: (name: string) => (name === "read" ? { session: nativeScope } : undefined),
    getActiveToolNames: () => ["read"],
    refreshMCPTools: async (tools: FixtureTool[]) => {
      visible = tools;
    },
  } as unknown as SessionLike;
  await rescopeProjectMcp(runtime, session, a);
  expect(manager.cwd).toBe(a);
  expect(visible[0]?.description).toContain("project:A");
  await rescopeProjectMcp(runtime, session, b);
  expect(manager.cwd).toBe(b);
  expect(visible[0]?.description).toContain("project:B");
  expect(visible.some((tool) => tool.description.includes("project:A"))).toBe(false);
  await rescopeProjectMcp(runtime, session, a);
  expect(visible[0]?.description).toContain("project:A");
  expect(loadedPaths).toEqual([a, b, a]);
});
