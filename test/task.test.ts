import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRuntime, findInstalledOmp } from "../src/runtime";
import { installMemoryBridge } from "../src/memory";
import { findNativeToolSession, installTaskTool, mcpStartupWait, prepareTaskScope, syncTaskAnchor } from "../src/task";
import { WorkspaceBridge } from "../src/host";
import type { ExtensionApiLike, ExtensionContextLike, HostNamespace, SessionLike, SettingsLike, ToolDefinitionLike } from "../src/types";

const runtime = createRuntime({} as HostNamespace, findInstalledOmp());
const registryModule = await runtime.importModule<HostNamespace>("registry/agent-registry.ts");
runtime.host.AgentRegistry = registryModule.AgentRegistry;
const memory = await installMemoryBridge(runtime);
const { Settings } = await runtime.importModule<{ Settings: { loadIsolated(options: Record<string, unknown>): Promise<SettingsLike & { getCwd(): string; getStorage(): { close(): Promise<void> } | null }> } }>("config/settings.ts");
const { createAgentSession } = await runtime.importModule<{ createAgentSession(options: Record<string, unknown>): Promise<{ session: NativeSession }> }>("sdk.ts");
const { SessionManager } = await runtime.importModule<{ SessionManager: { inMemory(cwd: string): unknown; create(cwd: string, sessionDir: string): unknown } }>("session/session-manager.ts");
const { AgentStorage } = await runtime.importModule<{ AgentStorage: { close(): void } }>("session/agent-storage.ts");
const { ModelRegistry } = await runtime.importModule<{ ModelRegistry: new(auth: unknown, modelsPath: string, options: Record<string, unknown>) => Record<string, unknown> }>("config/model-registry.ts");
const { AuthStorage } = await runtime.importModule<{ AuthStorage: { create(file: string): Promise<{ close(): Promise<void> }> } }>("@oh-my-pi/pi-ai");
const { createMockModel, registerMockApi } = await runtime.importModule<{ createMockModel(options: Record<string, unknown>): { model: Record<string, unknown>; calls: Array<{ context: { systemPrompt: string[]; messages: unknown[] } }> }; registerMockApi(): void }>("@oh-my-pi/pi-ai/providers/mock");
const { AgentLifecycleManager } = await runtime.importModule<{ AgentLifecycleManager: { global(): { park(id: string): Promise<void>; ensureLive(id: string): Promise<NativeSession>; release(id: string): Promise<boolean> } } }>("registry/agent-lifecycle.ts");
const dirs = await runtime.importModule<{ getAgentDir(): string; setAgentDir(dir: string): void; setProjectDir(dir: string): void }>("@oh-my-pi/pi-utils");
const originalAgentDir = dirs.getAgentDir();
const originalCwd = process.cwd();
registerMockApi();
interface NativeSession extends SessionLike { prompt(text: string): Promise<unknown>; dispose(): Promise<void>; getToolByName(name: string): unknown; }
const temporary: string[] = [];
const sessions: NativeSession[] = [];
const auths: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const ref of runtime.host.AgentRegistry.global().list()) {
    if (ref.session && !sessions.includes(ref.session as NativeSession)) await (ref.session as NativeSession).dispose();
  }
  for (const session of sessions.splice(0)) await session.dispose();
  for (const auth of auths.splice(0)) await auth.close();
  AgentStorage.close();
  dirs.setAgentDir(originalAgentDir);
  dirs.setProjectDir(originalCwd);
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function fixture(persist = false, batch: boolean | null = true, defaultMemoryPath = false) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "omp-nav-task-")));
  temporary.push(root);
  const a = join(root, "A"); const b = join(root, "B"); const c = join(root, "C"); const agentDir = join(root, "agent");
  for (const dir of [a, b, c, agentDir]) await fs.mkdir(dir);
  dirs.setAgentDir(agentDir);
  for (const [dir, marker] of [[a, "A"], [b, "B"], [c, "C"]]) {
    await fs.writeFile(join(dir, "AGENTS.md"), `Project ${marker} unique instructions.`);
    await fs.mkdir(join(dir, ".omp", "agents"), { recursive: true });
    await fs.writeFile(join(dir, ".omp", "agents", "target.md"), `---\nname: target\ndescription: Destination agent ${marker}\nmodel: mock/mock-model\nthinking-level: off\nspawns: '*'\n---\nDestination ${marker} agent instructions.\n`);
    await fs.mkdir(join(dir, ".omp", "skills", `scope-${marker}`), { recursive: true });
    await fs.writeFile(join(dir, ".omp", "skills", `scope-${marker}`, "SKILL.md"), `---\nname: scope-${marker}\ndescription: Project ${marker} scoped skill\n---\nSkill body ${marker}.\n`);
    await fs.writeFile(join(dir, ".omp", "RULES.md"), `Project ${marker} always rule.`);
    await fs.mkdir(join(dir, ".omp", "tools"), { recursive: true });
    await fs.writeFile(join(dir, ".omp", "tools", "scope.ts"), `export default () => ({ name: "project_tool_${marker}", label: "Project ${marker}", description: "Project tool ${marker}", parameters: {type:"object",properties:{}}, execute: async () => ({ content: [{type:"text",text:"${marker}"}] }) });\n`);
    await fs.mkdir(join(dir, ".omp", "extensions"), { recursive: true });
    await fs.writeFile(join(dir, ".omp", "extensions", "scope.ts"), `export default pi => pi.registerTool({ name:"extension_tool_${marker}", label:"Extension ${marker}", description:"Extension ${marker}", parameters:{type:"object",properties:{}}, execute:async()=>({content:[{type:"text",text:"${marker}"}]}) });\n`);
    await fs.mkdir(join(dir, ".omp", "prompts"), { recursive: true });
    await fs.writeFile(join(dir, ".omp", "prompts", `prompt-${marker}.md`), `Prompt from project ${marker}.`);
    await fs.mkdir(join(dir, ".omp", "commands"), { recursive: true });
    await fs.writeFile(join(dir, ".omp", "commands", `command-${marker}.md`), `Command from project ${marker}.`);
  }
  if (batch === null) await fs.writeFile(join(a, ".omp", "config.yml"), "task:\n  batch: false\n");
  const settings = await Settings.loadIsolated({ cwd: a, agentDir, overrides: {
    "memory.backend": "mnemopi", ...(!defaultMemoryPath ? { "mnemopi.dbPath": join(root, "memory", "mnemopi.db") } : {}), "mnemopi.noEmbeddings": true,
    "mnemopi.llmMode": "none", "mnemopi.autoRecall": false, "mnemopi.autoRetain": false,
    "skills.enableAgentsUser": false, "skills.enableCodexUser": false, "skills.enableClaudeUser": false, "skills.enablePiUser": false,
    "async.enabled": false, "task.structured": false, ...(batch !== null ? { "task.batch": batch } : {}),
    "task.enableLsp": false, "lsp.enabled": false, "autolearn.enabled": false,
    "task.isolation.enabled": true, "worktree.base": join(root, "worktrees"), "modelRoles": { default: "mock/mock-model", task: "mock/mock-model" },
  } });
  const auth = await AuthStorage.create(join(root, "auth.db")); auths.push(auth);
  const mock = createMockModel({ handler: () => {
    for (const ref of runtime.host.AgentRegistry.global().list()) {
      if (ref.kind === "sub" && ref.session) {
        const state = memory.getState(ref.session);
        expect(state).toBeDefined();
        expect(state!.aliasOf).toBeUndefined();
        expect(state!.config.autoRetain).toBe(false);
      }
    }
    return { content: ["completed"] };
  } });
  const modelRegistry = new ModelRegistry(auth, join(root, "models.yml"), { cacheDbPath: join(root, "models-cache.db"), settings });
  Object.assign(modelRegistry, { refresh: async () => {}, getAll: () => [mock.model], getAvailable: () => [mock.model], find: () => mock.model, getApiKey: async () => "test-key" });
  const manager = persist ? SessionManager.create(a, join(root, "sessions", "A")) : SessionManager.inMemory(a);
  if (persist) {
    const storage = manager as { moveTo(cwd: string, sessionDir?: string): Promise<void> };
    const move = storage.moveTo.bind(storage);
    storage.moveTo = (cwd, sessionDir) => move(cwd, sessionDir ?? join(root, "sessions", basename(cwd)));
  }
  const { session } = await createAgentSession({ cwd: a, agentDir, settings, modelRegistry, authStorage: auth, model: mock.model, getApiKey: async () => "test-key", sessionManager: manager,
    toolNames: ["read", "task"], enableMCP: false, enableLsp: false, hasUI: false, skipPythonPreflight: true, disableExtensionDiscovery: true,
  });
  sessions.push(session);
  let tool!: ToolDefinitionLike;
  const hooks: Array<(session: SessionLike) => Promise<void>> = [];
  const bridge = {
    currentSession: () => session,
    assertAllowedPath: async (_ctx: ExtensionContextLike, target: string) => fs.realpath(resolve(a, target)),
    addAfterRelocationHook: (hook: (session: SessionLike) => Promise<void>) => { hooks.push(hook); return () => {}; },
  } as unknown as WorkspaceBridge;
  const startHandlers: Array<(event: { type: string }, ctx: ExtensionContextLike) => Promise<void> | void> = [];
  const pi = { registerTool: (definition: ToolDefinitionLike) => { tool = definition; }, on: (event: string, handler: typeof startHandlers[number]) => { if (event === "session_start") startHandlers.push(handler); } } as ExtensionApiLike;
  await installTaskTool(pi, runtime, bridge, memory);
  const ctx = { agent: { id: "Main", kind: "main" } } as ExtensionContextLike;
  for (const handler of startHandlers) await handler({ type: "session_start" }, ctx);
  return { root, a, b, c, session, tool, mock, ctx, hooks };
}

async function localMcp(root: string, project: string, name: string, mode: "ready" | "delayed" | "pending" | "failed" = "ready") {
  const server = join(root, `${name}-mcp.ts`); const pidFile = `${server}.pid`;
  await fs.writeFile(server, `import {createInterface} from "node:readline"; import {writeFileSync} from "node:fs";
writeFileSync(process.argv[2],String(process.pid));
createInterface({input:process.stdin}).on("line",line=>{
  const request=JSON.parse(line); if(request.id===undefined)return;
  const send=result=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
  if(request.method==="initialize"){
    if(${JSON.stringify(mode)}==="failed")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,error:{code:-32603,message:"fixture initialization failed"}})+"\\n");
    else send({protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"local-fixture",version:"1"}});
  } else if(request.method==="tools/list"){
    if(${JSON.stringify(mode)}==="pending")return;
    const result={tools:[{name:"marker_B",description:"Target MCP",inputSchema:{type:"object",properties:{}}}]};
    if(${JSON.stringify(mode)}==="delayed")setTimeout(()=>send(result),1500);else send(result);
  } else send({});
});\n`);
  await fs.writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { [name]: { command: process.execPath, args: [server, pidFile] } } }));
  return pidFile;
}

async function expectServerClosed(pidFile: string) {
  // Real process lifecycle: the server is spawned by code under test (no child handle); with a tiny
  // startup budget it may be killed before writing its pid file — await both events by polling.
  const started = Date.now();
  let pid = 0;
  while (Date.now() - started < 5000) {
    try { pid = Number(await fs.readFile(pidFile, "utf8")); break; } catch { await Bun.sleep(25); }
  }
  if (!pid) return;
  expect(pid).toBeGreaterThan(0);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await Bun.sleep(50);
  }
  expect(() => process.kill(pid, 0)).toThrow();
}

async function configureSourceTaskExtension(root: string, project: string) {
  const extension = join(root, "source-task-extension.ts");
  await fs.writeFile(extension, `
import {createRuntime} from ${JSON.stringify(join(import.meta.dir, "..", "src", "runtime.ts"))};
import {installHostBridge} from ${JSON.stringify(join(import.meta.dir, "..", "src", "host.ts"))};
import {installMemoryBridge} from ${JSON.stringify(join(import.meta.dir, "..", "src", "memory.ts"))};
import {installTaskTool} from ${JSON.stringify(join(import.meta.dir, "..", "src", "task.ts"))};
export default async function(pi) {
  const runtime=createRuntime(pi.pi,${JSON.stringify(runtime.packageRoot)});
  const bridge=await installHostBridge(runtime), memory=await installMemoryBridge(runtime);
  bridge.setMemoryBridge(memory);
  await installTaskTool(pi,runtime,bridge,memory);
  pi.on("session_start",async(_event,ctx)=>memory.ensure(bridge.currentSession(ctx)));
}
`);
  await fs.writeFile(join(project, ".omp", "config.yml"), `extensions:\n  - ${JSON.stringify(extension)}\n`);
}

describe("native task destination scope", () => {
  test("registration accepts cwd for single and each batch item, with native executor semantics", async () => {
    const f = await fixture();
    const result = await f.tool.execute("target-single", { cwd: f.b, name: "target-B", agent: "target", task: "Report project", solutionSpace: "mechanical" }, undefined, undefined, f.ctx) as { content: unknown; details: { results: Array<{ exitCode: number; error?: string }> } };
    expect(result.details.results[0]?.error).toBeUndefined();
    expect(result.details.results[0]?.exitCode).toBe(0);
    const prompt = JSON.stringify(f.mock.calls.at(-1)?.context.systemPrompt);
    expect(prompt).toContain("Project B unique instructions");
    expect(prompt).toContain("Destination B agent instructions");
    expect(prompt).toContain("scope-B");
    expect(prompt).toContain("Project B always rule");
    expect(prompt).not.toContain("Project A unique instructions");
    expect(prompt).not.toContain("scope-A");
    const child = runtime.host.AgentRegistry.global().get("target-B")!.session! as NativeSession;
    expect(child.getToolByName("project_tool_B")).toBeDefined();
    expect(child.getToolByName("extension_tool_B")).toBeDefined();
    expect(child.getToolByName("project_tool_A")).toBeUndefined();
    expect(child.getToolByName("extension_tool_A")).toBeUndefined();
    expect((child as NativeSession & { promptTemplates: Array<{ name: string }> }).promptTemplates.some(value => value.name === "prompt-B")).toBe(true);
    expect((child as NativeSession & { promptTemplates: Array<{ name: string }> }).promptTemplates.some(value => value.name === "prompt-A")).toBe(false);
    expect((child as NativeSession & { slashCommands: Array<{ name: string }> }).slashCommands.some(value => value.name === "command-B")).toBe(true);
    expect((child as NativeSession & { slashCommands: Array<{ name: string }> }).slashCommands.some(value => value.name === "command-A")).toBe(false);
    const batch = await f.tool.execute("target-batch", { context: "Shared coordination", tasks: [
      { cwd: f.a, name: "batch-A", agent: "target", task: "A", solutionSpace: "mechanical" },
      { cwd: f.b, name: "batch-B", agent: "target", task: "B", solutionSpace: "mechanical" },
    ] }, undefined, undefined, f.ctx) as { details: { results: Array<{ index: number; exitCode: number }> } };
    expect(batch.details.results.map(result => result.index)).toEqual([0, 1]);
    expect(batch.details.results.every(result => result.exitCode === 0)).toBe(true);
    expect(f.mock.calls.slice(-2).map(call => JSON.stringify(call.context.systemPrompt))).toEqual(expect.arrayContaining([
      expect.stringContaining("Project A unique instructions"), expect.stringContaining("Project B unique instructions"),
    ]));
  }, 30000);

  test("default destination snapshots settings and drops parent project bundles/additional roots", async () => {
    const f = await fixture();
    const scoped = await prepareTaskScope(runtime, f.session, f.b, false);
    expect(scoped.cwd).toBe(f.b);
    expect(scoped.contextFiles).toBeUndefined();
    expect(scoped.additionalDirectories).toEqual([]);
    await f.session.settings.reloadForCwd(f.c);
    expect(scoped.cwd).toBe(f.b);
    expect(scoped.settings.getCwd()).toBe(f.b);
  }, 30000);

  test("stable task artifact anchor follows main storage relocation", async () => {
    const f = await fixture(true);
    await f.session.prompt("persist main");
    await syncTaskAnchor(runtime, f.session);
    const native = findNativeToolSession(f.session);
    const anchor = (native.getSessionFile as () => string)();
    const result = await f.tool.execute("persistent-B", { cwd: f.b, name: "persist-B", agent: "target", task: "B", solutionSpace: "mechanical" }, undefined, undefined, f.ctx) as { details: { results: Array<{ id: string; exitCode: number }> } };
    expect(result.details.results[0].exitCode).toBe(0);
    const childRef = runtime.host.AgentRegistry.global().get(result.details.results[0].id) as { sessionFile?: string; session?: NativeSession } | undefined;
    expect(childRef?.sessionFile).toBe(`${anchor.slice(0, -6)}/${result.details.results[0].id}.jsonl`);
    await f.session.moveSession(f.c);
    for (const hook of f.hooks) await hook(f.session);
    expect((native.getSessionFile as () => string)()).toBe(anchor);
    expect(await fs.realpath(anchor)).toContain("sessions");
    expect(await fs.stat(childRef!.sessionFile!)).toBeDefined();
    expect(childRef?.session?.sessionManager.getCwd()).toBe(f.b);
    const bank = memory.getState(childRef!.session!)!.config.bank;
    await AgentLifecycleManager.global().park(result.details.results[0].id);
    expect(runtime.host.AgentRegistry.global().get(result.details.results[0].id)?.session).toBeNull();
    const revived = await AgentLifecycleManager.global().ensureLive(result.details.results[0].id);
    await revived.prompt("continue after parent move");
    expect(revived.sessionManager.getCwd()).toBe(f.b);
    expect(memory.getState(revived)!.config.bank).toBe(bank);
    expect(memory.getState(revived)!.aliasOf).toBeUndefined();
    expect(JSON.stringify(f.mock.calls.at(-1)?.context.systemPrompt)).toContain("Project B unique instructions");
    expect(await fs.readFile(childRef!.sessionFile!, "utf8")).toContain("continue after parent move");
  }, 30000);

  test("native isolation starts from target B and keeps B's bank", async () => {
    const f = await fixture(true);
    await fs.writeFile(join(f.b, "target-only.txt"), "B");
    const git = promisify(execFile);
    await git("git", ["init", f.b]);
    await git("git", ["-C", f.b, "add", "."]);
    await git("git", ["-C", f.b, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);
    await f.session.prompt("persist main");
    const result = await f.tool.execute("isolated-B", { cwd: f.b, isolated: true, name: "isolated-B", agent: "target", task: "Confirm target", solutionSpace: "mechanical" }, undefined, undefined, f.ctx) as { details: { results: Array<{ id: string; exitCode: number; error?: string }> } };
    if (!result.details.results.length) throw new Error(JSON.stringify(result));
    expect(result.details.results[0].error).toBeUndefined();
    expect(result.details.results[0].exitCode).toBe(0);
    const child = runtime.host.AgentRegistry.global().get(result.details.results[0].id)!.session!;
    expect(child.sessionManager.getCwd()).not.toBe(f.b);
    expect(await fs.readFile(join(child.sessionManager.getCwd(), "target-only.txt"), "utf8")).toBe("B");
    const scoped = await prepareTaskScope(runtime, f.session, f.b, false);
    const { computeMnemopiBankScope } = await runtime.importModule<{ computeMnemopiBankScope(prefix: string | undefined, cwd: string, mode: string): { bank: string } }>("mnemopi/config.ts");
    expect(memory.getState(child)!.config.bank).toBe(computeMnemopiBankScope(undefined, scoped.settings.getCwd(), "per-project").bank);
    expect(memory.getState(child)!.aliasOf).toBeUndefined();
    await AgentLifecycleManager.global().release(result.details.results[0].id);
  }, 30000);

  test("a running B child writes its journal after the main session moves A to C", async () => {
    const f = await fixture(true);
    await f.session.prompt("persist main");
    const started = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
    f.mock.model.fallback = async () => { started.resolve(); await finish.promise; return { content: ["child finished after relocation"] }; };
    const execution = f.tool.execute("active-B", { cwd: f.b, name: "active-B", agent: "target", task: "B", solutionSpace: "mechanical" }, undefined, undefined, f.ctx);
    await started.promise;
    const child = runtime.host.AgentRegistry.global().get("active-B") as { sessionFile: string; session: NativeSession };
    const originalChildFile = child.sessionFile;
    await f.session.moveSession(f.c);
    for (const hook of f.hooks) await hook(f.session);
    finish.resolve();
    const result = await execution as { details: { results: Array<{ exitCode: number }> } };
    expect(result.details.results[0].exitCode).toBe(0);
    expect(child.session.sessionManager.getCwd()).toBe(f.b);
    expect(child.sessionFile).toBe(originalChildFile);
    expect(await fs.readFile(originalChildFile, "utf8")).toContain("child finished after relocation");
    expect(JSON.stringify(f.mock.calls.at(-1)?.context.systemPrompt)).toContain("Project B unique instructions");
  }, 30000);

  test("destination owns MCP manager and discovers B's tools before launching", async () => {
    const f = await fixture();
    const server = join(f.root, "mcp-server.ts");
    await fs.writeFile(server, `import {createInterface} from "node:readline";\nconst lines=createInterface({input:process.stdin});\nlines.on("line",line=>{const request=JSON.parse(line);if(request.id===undefined)return;let result={};if(request.method==="initialize")result={protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"scoped-test",version:"1"}};if(request.method==="tools/list")result={tools:[{name:"marker_B",description:"Destination B MCP",inputSchema:{type:"object",properties:{}}}]};if(request.method==="tools/call")result={content:[{type:"text",text:"B"}]};process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");});\n`);
    await fs.writeFile(join(f.b, ".mcp.json"), JSON.stringify({ mcpServers: { destinationB: { command: process.execPath, args: [server] } } }));
    const native = findNativeToolSession(f.session);
    native.enableMCP = true;
    const scoped = await prepareTaskScope(runtime, f.session, f.b, false);
    expect(scoped.mcpManager).toBeDefined();
    expect(scoped.mcpManager).not.toBe(native.mcpManager);
    const manager = scoped.mcpManager as { getTools(): Array<{ name: string; mcpToolName?: string }> };
    expect(manager.getTools().some(tool => tool.mcpToolName === "marker_B")).toBe(true);
    const result = await f.tool.execute("mcp-B", { cwd: f.b, name: "mcp-B", agent: "target", task: "B", solutionSpace: "mechanical" }, undefined, undefined, f.ctx) as { details: { results: Array<{ exitCode: number }> } };
    expect(result.details.results[0].exitCode).toBe(0);
    const child = runtime.host.AgentRegistry.global().get("mcp-B")!.session! as NativeSession;
    expect(child.getToolByName(manager.getTools().find(tool => tool.mcpToolName === "marker_B")!.name)).toBeDefined();
  }, 30000);

  test("a bad destination agent rejects all batch children before the provider runs", async () => {
    const f = await fixture();
    const before = f.mock.calls.length;
    await expect(f.tool.execute("bad-batch", { context: "Shared", tasks: [
      { cwd: f.a, name: "should-not-start", agent: "target", task: "A", solutionSpace: "mechanical" },
      { cwd: f.b, name: "bad-target", agent: "missing-agent", task: "B", solutionSpace: "mechanical" },
    ] }, undefined, undefined, f.ctx)).rejects.toThrow("Unknown agent");
    expect(f.mock.calls.length).toBe(before);
    expect(runtime.host.AgentRegistry.global().get("should-not-start")).toBeUndefined();
  }, 30000);

  test("no-session output IDs stay unique across projects and repeated calls", async () => {
    const f = await fixture();
    const invoke = (cwd: string, id: string) => f.tool.execute(id, { cwd, name: "same-name", agent: "target", task: "Done", solutionSpace: "mechanical" }, undefined, undefined, f.ctx) as Promise<{ details: { results: Array<{ id: string; exitCode: number }> } }>;
    const first = await invoke(f.a, "first"); const second = await invoke(f.b, "second");
    expect(first.details.results[0].id).toBe("same-name");
    expect(second.details.results[0].id).toBe("same-name-2");
    expect(second.details.results[0].exitCode).toBe(0);
  }, 30000);

  test("child mandatory memory failure prevents its first provider request", async () => {
    const f = await fixture();
    const block = join(f.root, "blocked"); await fs.writeFile(block, "file");
    const { lookup } = await runtime.importModule<{ lookup(id: string): { override(settings: SettingsLike, value: unknown): void } }>("config/registry.ts");
    lookup("mnemopi.dbPath").override(f.session.settings, join(block, "mnemopi.db"));
    await f.session.settleMemoryBackend();
    const before = f.mock.calls.length;
    const outcome = await f.tool.execute("failed-memory", { cwd: f.b, name: "failed-memory", agent: "target", task: "B", solutionSpace: "mechanical" }, undefined, undefined, f.ctx) as { details: { results: Array<{ exitCode: number; error?: string }> } };
    expect(outcome.details.results[0].exitCode).toBe(1);
    expect(outcome.details.results[0].error).toContain("Mnemopi startup failed");
    expect(f.mock.calls.length).toBe(before);
  }, 30000);

  test("native background jobs across A/B share the root concurrency limit and aggregate progress", async () => {
    const f = await fixture();
    const { lookup } = await runtime.importModule<{ lookup(id: string): { override(settings: SettingsLike, value: unknown): void } }>("config/registry.ts");
    lookup("async.enabled").override(f.session.settings, true);
    lookup("task.maxConcurrency").override(f.session.settings, 1);
    const started = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
    let active = 0; let maximum = 0; let childCalls = 0;
    f.mock.model.fallback = async (context: { systemPrompt: string[] }) => {
      if (!context.systemPrompt.some(value => /Destination [AB] agent instructions/.test(value))) return { content: ["main received result"] };
      active++; childCalls++; maximum = Math.max(maximum, active); started.resolve();
      await finish.promise;
      active--;
      return { content: ["child job completed"] };
    };
    let latest: { details: { async?: { state: string }; progress?: Array<{ index: number }> } } | undefined;
    const result = await f.tool.execute("background-batch", { context: "Shared", tasks: [
      { cwd: f.a, name: "async-A", agent: "target", task: "A", solutionSpace: "mechanical" },
      { cwd: f.b, name: "async-B", agent: "target", task: "B", solutionSpace: "mechanical" },
    ] }, undefined, (update: typeof latest) => { latest = update; }, f.ctx) as typeof latest;
    expect(result?.details.async?.state).toBe("running");
    expect(result?.details.progress?.map(value => value.index)).toEqual([0, 1]);
    await started.promise;
    expect(childCalls).toBe(1);
    const manager = findNativeToolSession(f.session).asyncJobManager as { getAllJobs(): Array<{ status: string; promise: Promise<void> }> };
    const jobs = manager.getAllJobs(); expect(jobs.length).toBe(2);
    finish.resolve();
    await Promise.all(jobs.map(job => job.promise));
    expect(maximum).toBe(1);
    expect(childCalls).toBe(2);
    expect(jobs.every(job => job.status === "completed")).toBe(true);
    expect(latest?.details.async?.state).toBe("completed");
    expect(latest?.details.progress?.map(value => value.index)).toEqual([0, 1]);
  }, 30000);

  test("omitted cwd snapshots main A, then subsequent default task starts in C", async () => {
    const f = await fixture();
    const first = await f.tool.execute("default-A", { name: "default-A", agent: "target", task: "A", solutionSpace: "mechanical" }, undefined, undefined, f.ctx) as { details: { results: Array<{ exitCode: number }> } };
    expect(first.details.results[0].exitCode).toBe(0);
    const childA = runtime.host.AgentRegistry.global().get("default-A")!.session!;
    const bankA = memory.getState(childA)!.config.bank;
    await f.session.moveSession(f.c);
    for (const hook of f.hooks) await hook(f.session);
    expect(childA.sessionManager.getCwd()).toBe(f.a);
    expect(memory.getState(childA)!.config.bank).toBe(bankA);
    const second = await f.tool.execute("default-C", { name: "default-C", agent: "target", task: "C", solutionSpace: "mechanical" }, undefined, undefined, f.ctx) as { details: { results: Array<{ exitCode: number }> } };
    expect(second.details.results[0].exitCode).toBe(0);
    const childC = runtime.host.AgentRegistry.global().get("default-C")!.session!;
    expect(childC.sessionManager.getCwd()).toBe(f.c);
    expect(memory.getState(childC)!.config.bank).not.toBe(bankA);
  }, 30000);

  test("advertised native single/batch schemas preserve cwd without broadening task mode", async () => {
    const f = await fixture();
    const schema = f.tool.parameters as { assert(params: unknown): { tasks?: Array<{ cwd?: string }>; cwd?: string }; toJsonSchema(): { properties: Record<string, unknown> } };
    const batch = schema.assert({ context: "Shared", tasks: [{ cwd: f.b, agent: "target", task: "B", solutionSpace: "mechanical" }] });
    expect(batch.tasks?.[0].cwd).toBe(f.b);
    expect(schema.toJsonSchema().properties.cwd).toBeUndefined();
    const { lookup } = await runtime.importModule<{ lookup(id: string): { override(settings: SettingsLike, value: unknown): void } }>("config/registry.ts");
    lookup("task.batch").override(f.session.settings, false);
    const single = f.tool.parameters as typeof schema;
    expect(single.assert({ cwd: f.b, agent: "target", task: "B", solutionSpace: "mechanical" }).cwd).toBe(f.b);
    expect(single.toJsonSchema().properties.tasks).toBeUndefined();
  }, 30000);

  test("native session_switch creates a new main anchor without retargeting the old B child", async () => {
    const f = await fixture(true);
    await f.session.prompt("persist first parent");
    await f.tool.execute("old-parent-B", { cwd: f.b, name: "old-parent-B", agent: "target", task: "B", solutionSpace: "mechanical" }, undefined, undefined, f.ctx);
    const native = findNativeToolSession(f.session);
    const oldAnchor = (native.getSessionFile as () => string)();
    const oldActualFile = await fs.realpath(oldAnchor);
    const oldId = f.session.sessionId;
    const childRef = runtime.host.AgentRegistry.global().get("old-parent-B") as { sessionFile: string; session: NativeSession };
    const oldChildFile = childRef.sessionFile;
    const oldBank = memory.getState(childRef.session)!.config.bank;
    const main = f.session as NativeSession & { newSession(): Promise<boolean> };
    expect(await main.newSession()).toBe(true);
    for (const hook of f.hooks) await hook(f.session);
    expect(f.session.sessionId).not.toBe(oldId);
    expect((native.getSessionFile as () => string)()).not.toBe(oldAnchor);
    expect(await fs.realpath(oldAnchor)).toBe(oldActualFile);
    expect(childRef.sessionFile).toBe(oldChildFile);
    expect(childRef.session.sessionManager.getCwd()).toBe(f.b);
    expect(memory.getState(childRef.session)!.config.bank).toBe(oldBank);
    await AgentLifecycleManager.global().park("old-parent-B");
    const revived = await AgentLifecycleManager.global().ensureLive("old-parent-B");
    await revived.prompt("continue in the old parent family");
    expect(memory.getState(revived)!.config.bank).toBe(oldBank);
    expect(await fs.readFile(oldChildFile, "utf8")).toContain("continue in the old parent family");
  }, 30000);

  test("main move refreshes advertised task mode and destination agent descriptions", async () => {
    const f = await fixture(false, null);
    await fs.writeFile(join(f.b, ".omp", "config.yml"), "task:\n  batch: true\n");
    const shape = () => (f.tool.parameters as { toJsonSchema(): { properties: Record<string, unknown> } }).toJsonSchema().properties;
    expect(shape().tasks).toBeUndefined();
    const bridge = new WorkspaceBridge(runtime); bridge.setMemoryBridge(memory);
    await bridge.relocate(f.session, f.b);
    for (const hook of f.hooks) await hook(f.session);
    expect(shape().tasks).toBeDefined();
    expect(f.tool.description).toContain("Destination agent B");
    expect(f.tool.description).not.toContain("Destination agent A");
  }, 30000);

  test("failed main B memory startup rolls back cwd, storage, settings, and bank A before another provider call", async () => {
    const f = await fixture(true, true, true);
    await f.session.prompt("persist main A");
    const bankA = memory.getState(f.session)!.config.bank;
    const manager = f.session.sessionManager as SessionLike["sessionManager"] & { getSessionFile(): string };
    const originalFile = manager.getSessionFile();
    const block = join(f.root, "blocked"); await fs.writeFile(block, "file");
    await fs.writeFile(join(f.b, ".omp", "config.yml"), `mnemopi:\n  dbPath: ${JSON.stringify(join(block, "mnemopi.db"))}\n`);
    const bridge = new WorkspaceBridge(runtime); bridge.setMemoryBridge(memory);
    await expect(bridge.relocate(f.session, f.b)).rejects.toThrow("Mnemopi");
    expect(f.session.sessionManager.getCwd()).toBe(f.a);
    expect(manager.getSessionFile()).toBe(originalFile);
    expect(await fs.stat(originalFile)).toBeDefined();
    expect((f.session.settings as SettingsLike & { getCwd(): string }).getCwd()).toBe(f.a);
    expect(memory.getState(f.session)!.config.bank).toBe(bankA);
    await f.session.prompt("continued in A after rollback");
    expect(f.mock.calls.length).toBe(2);
    expect(JSON.stringify(f.mock.calls[1].context.systemPrompt)).toContain("Project A unique instructions");
    expect(JSON.stringify(f.mock.calls[1].context.systemPrompt)).not.toContain("Project B unique instructions");
  }, 30000);

  test("plan mode preserves omitted isolation while explicitly supplied controls are rejected", async () => {
    const f = await fixture();
    const main = f.session as NativeSession & { setPlanModeState(state: Record<string, unknown>): void };
    main.setPlanModeState({ enabled: true, planFilePath: join(f.a, "PLAN.md") });
    const result = await f.tool.execute("plan-without-isolation", { cwd: f.b, name: "plan-B", agent: "target", task: "Inspect B", solutionSpace: "mechanical" }, undefined, undefined, f.ctx) as { details: { results: Array<{ exitCode: number }> } };
    expect(result.details.results[0].exitCode).toBe(0);
    const child = runtime.host.AgentRegistry.global().get("plan-B")!.session! as NativeSession & { getActiveToolNames(): string[] };
    expect(child.sessionManager.getCwd()).toBe(f.b);
    expect(child.getActiveToolNames()).not.toContain("write");
    expect(child.getActiveToolNames()).not.toContain("edit");
    const calls = f.mock.calls.length;
    await expect(f.tool.execute("plan-explicit-isolation", { cwd: f.b, name: "plan-invalid", agent: "target", task: "Inspect B", solutionSpace: "mechanical", isolated: false }, undefined, undefined, f.ctx)).rejects.toThrow("unavailable in plan mode");
    expect(f.mock.calls.length).toBe(calls);
  }, 30000);

  test("case and whitespace equivalent batch names reject every item before artifacts or provider calls", async () => {
    const f = await fixture(true);
    for (const [one, two] of [["Same", "same"], [" Same ", "Same"], [" foo", "FOO "]]) {
      await expect(f.tool.execute("duplicate-names", { context: "Shared", tasks: [
        { cwd: f.a, name: one, agent: "target", task: "A", solutionSpace: "mechanical" },
        { cwd: f.b, name: two, agent: "target", task: "B", solutionSpace: "mechanical" },
      ] }, undefined, undefined, f.ctx)).rejects.toThrow("unique");
    }
    expect(f.mock.calls.length).toBe(0);
    expect(runtime.host.AgentRegistry.global().list().some(ref => ref.kind === "sub")).toBe(false);
    expect(await fs.access(join(f.root, "sessions", ".omp-agent-nav")).then(() => true, () => false)).toBe(false);
  }, 30000);

  test("slow target MCP catalog is present at the first provider request", async () => {
    const f = await fixture();
    await localMcp(f.root, f.b, "slowB", "delayed");
    const { lookup } = await runtime.importModule<{ lookup(id: string): { override(settings: SettingsLike, value: unknown): void } }>("config/registry.ts");
    lookup("mcp.startupTimeoutMs").override(f.session.settings, 10);
    findNativeToolSession(f.session).enableMCP = true;
    let observed: string[] = [];
    f.mock.model.fallback = () => {
      const child = runtime.host.AgentRegistry.global().get("slow-B")!.session! as NativeSession & { getAllToolNames(): string[] };
      observed = child.getAllToolNames();
      return { content: ["ready"] };
    };
    const result = await f.tool.execute("slow-MCP", { cwd: f.b, name: "slow-B", agent: "target", task: "B", solutionSpace: "mechanical" }, undefined, undefined, f.ctx) as { details: { results: Array<{ exitCode: number }> } };
    expect(result.details.results[0].exitCode).toBe(0);
    expect(f.mock.calls.length).toBe(1);
    expect(observed.some(name => name.includes("marker_b"))).toBe(true);
  }, 30000);

  test("failed or still-pending target MCP blocks the provider and closes its process", async () => {
    const previousWait = mcpStartupWait.ms;
    mcpStartupWait.ms = 10;
    try {
      for (const mode of ["failed", "pending"] as const) {
        const f = await fixture();
        const pidFile = await localMcp(f.root, f.b, `unready-${mode}`, mode);
        const { lookup } = await runtime.importModule<{ lookup(id: string): { override(settings: SettingsLike, value: unknown): void } }>("config/registry.ts");
        lookup("mcp.startupTimeoutMs").override(f.session.settings, 10);
        findNativeToolSession(f.session).enableMCP = true;
        await expect(f.tool.execute("unready-MCP", { cwd: f.b, name: `blocked-${mode}`, agent: "target", task: "B", solutionSpace: "mechanical" }, undefined, undefined, f.ctx)).rejects.toThrow("MCP startup failed");
        expect(f.mock.calls.length).toBe(0);
        await expectServerClosed(pidFile);
      }
    } finally {
      mcpStartupWait.ms = previousWait;
    }
  }, 30000);

  test("configured source task extension leaves ordinary child task native and scope assignment main-only", async () => {
    const f = await fixture();
    await configureSourceTaskExtension(f.root, f.b);
    const result = await f.tool.execute("configured-child", { cwd: f.b, name: "configured-B", agent: "target", task: "B", solutionSpace: "mechanical" }, undefined, undefined, f.ctx) as { details: { results: Array<{ exitCode: number }> } };
    expect(result.details.results[0].exitCode).toBe(0);
    const child = runtime.host.AgentRegistry.global().get("configured-B")!.session! as NativeSession;
    const task = child.getToolByName("task") as { tool: { constructor: { name: string } }; parameters: { toJsonSchema(): { properties: Record<string, unknown> } }; execute(id: string, params: Record<string, unknown>): Promise<{ details: { results: Array<{ exitCode: number; id: string }> } }> };
    expect(task.tool.constructor.name).toBe("RegisteredToolAdapter");
    expect(task.parameters.toJsonSchema().properties.cwd).toBeUndefined();
    const nested = await task.execute("ordinary-nested", { name: "nested-B", agent: "task", task: "Inspect B", solutionSpace: "mechanical" });
    expect(nested.details.results[0].exitCode).toBe(0);
    const grandchild = runtime.host.AgentRegistry.global().get(nested.details.results[0].id)!.session!;
    expect(grandchild.sessionManager.getCwd()).toBe(f.b);
    expect(memory.getState(grandchild)!.config.bank).toBe(memory.getState(child)!.config.bank);
    await expect(task.execute("forbidden-nested-cwd", { cwd: f.a, agent: "task", task: "A", solutionSpace: "mechanical" })).rejects.toThrow("Only the main session");
  }, 30000);

  test("failed batch preflight closes all prepared sibling MCP processes", async () => {
    const f = await fixture();
    const pidA = await localMcp(f.root, f.a, "ownedA"); const pidB = await localMcp(f.root, f.b, "ownedB");
    findNativeToolSession(f.session).enableMCP = true;
    await expect(f.tool.execute("failed-preflight", { context: "Shared", tasks: [
      { cwd: f.a, name: "good-A", agent: "target", task: "A", solutionSpace: "mechanical" },
      { cwd: f.b, name: "bad-B", agent: "missing-agent", task: "B", solutionSpace: "mechanical" },
    ] }, undefined, undefined, f.ctx)).rejects.toThrow("Unknown agent");
    expect(f.mock.calls.length).toBe(0);
    await expectServerClosed(pidA); await expectServerClosed(pidB);
  }, 30000);

  test("one target startup failure closes already-prepared sibling MCP processes", async () => {
    const f = await fixture();
    const pidA = await localMcp(f.root, f.a, "preparedA"); const pidB = await localMcp(f.root, f.b, "failedB", "failed");
    findNativeToolSession(f.session).enableMCP = true;
    await expect(f.tool.execute("failed-preparation", { context: "Shared", tasks: [
      { cwd: f.a, name: "not-started-A", agent: "target", task: "A", solutionSpace: "mechanical" },
      { cwd: f.b, name: "not-started-B", agent: "target", task: "B", solutionSpace: "mechanical" },
    ] }, undefined, undefined, f.ctx)).rejects.toThrow("MCP startup failed");
    expect(f.mock.calls.length).toBe(0);
    await expectServerClosed(pidA); await expectServerClosed(pidB);
  }, 30000);

  test("browser MCP remains available when the destination agent has no eval", async () => {
    const f = await fixture();
    const agent = join(f.b, ".omp", "agents", "target.md");
    await fs.writeFile(agent, (await fs.readFile(agent, "utf8")).replace("spawns: '*'", "tools: read,task\nspawns: '*'"));
    await localMcp(f.root, f.b, "playwright");
    findNativeToolSession(f.session).enableMCP = true;
    const result = await f.tool.execute("browser-MCP", { cwd: f.b, name: "browser-B", agent: "target", task: "B", solutionSpace: "mechanical" }, undefined, undefined, f.ctx) as { details: { results: Array<{ exitCode: number }> } };
    expect(result.details.results[0].exitCode).toBe(0);
    const child = runtime.host.AgentRegistry.global().get("browser-B")!.session! as NativeSession & { getAllToolNames(): string[] };
    expect(child.getToolByName("eval")).toBeUndefined();
    expect(child.getAllToolNames().some(name => name.includes("marker_b"))).toBe(true);
  }, 30000);

  test("ordinary nested async task uses the child's concurrency while a blocking parent holds the main limit", async () => {
    const f = await fixture();
    const { lookup } = await runtime.importModule<{ lookup(id: string): { override(settings: SettingsLike, value: unknown): void } }>("config/registry.ts");
    lookup("async.enabled").override(f.session.settings, true);
    lookup("task.maxConcurrency").override(f.session.settings, 1);
    await configureSourceTaskExtension(f.root, f.b);
    const agent = join(f.b, ".omp", "agents", "target.md");
    await fs.writeFile(agent, (await fs.readFile(agent, "utf8")).replace("spawns: '*'", "blocking: true\nspawns: '*'"));
    let nestedCompleted = false; let submitted = false;
    f.mock.model.fallback = async () => {
      const child = runtime.host.AgentRegistry.global().get("blocking-B")?.session as NativeSession | undefined;
      if (child && !submitted) {
        submitted = true;
        const task = child.getToolByName("task") as { execute(id: string, params: Record<string, unknown>): Promise<{ details: { async: { jobId: string } } }> };
        const nested = await task.execute("nested-async", { name: "grandchild-B", agent: "task", task: "Inspect B", solutionSpace: "mechanical" });
        const manager = findNativeToolSession(child).asyncJobManager as { getJob(id: string): { promise: Promise<void>; status: string } };
        const job = manager.getJob(nested.details.async.jobId);
        await job.promise;
        nestedCompleted = job.status === "completed";
      }
      return { content: ["complete"] };
    };
    const result = await f.tool.execute("blocking-parent", { cwd: f.b, name: "blocking-B", agent: "target", task: "B", solutionSpace: "mechanical" }, undefined, undefined, f.ctx) as { details: { results: Array<{ exitCode: number }> } };
    expect(result.details.results[0].exitCode).toBe(0);
    expect(nestedCompleted).toBe(true);
  }, 30000);
});
