import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  assertInstalledOmp,
  createRuntime,
  findInstalledOmp,
  SUPPORTED_OMP_VERSIONS,
} from "../src/runtime";
import { type HostNamespace } from "../src/types";

const temporary: string[] = [];
afterEach(async () => {
  while (temporary.length) {
    await fs.rm(temporary.pop()!, { force: true, recursive: true });
  }
});

test("discovers the installed npm package and imports its native/source modules without copies", async () => {
  const root = findInstalledOmp();
  const runtime = createRuntime({} as HostNamespace, root);
  const registry = await runtime.importModule<{ AgentRegistry: { global(): unknown } }>(
    "registry/agent-registry.ts",
  );
  const vcs = await runtime.importModule<{ git: unknown }>("@oh-my-pi/pi-natives/vcs");
  expect(typeof registry.AgentRegistry.global).toBe("function");
  expect(typeof vcs.git).toBe("function");
  expect(runtime.mode).toBe("source-test");
});

test("accepts verified and newer same-major hosts, rejects older, next-major and non-semver", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "omp-nav-runtime-"));
  temporary.push(directory);
  const manifest = async (version: string) => {
    await fs.writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version }),
    );
  };
  await manifest("19.0.0");
  expect(() => assertInstalledOmp(directory)).toThrow(
    `omp-agent-nav supports @oh-my-pi/pi-coding-agent >= ${SUPPORTED_OMP_VERSIONS[0]} and below 19.0.0 (verified: ${SUPPORTED_OMP_VERSIONS.join(", ")}); found @oh-my-pi/pi-coding-agent 19.0.0.`,
  );
  for (const version of ["18.10.9", "18.13.0-dev", "garbage"]) {
    await manifest(version);
    expect(() => assertInstalledOmp(directory)).toThrow(
      `found @oh-my-pi/pi-coding-agent ${version}.`,
    );
  }
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (message: unknown) => warnings.push(message);
  try {
    for (const version of [...SUPPORTED_OMP_VERSIONS, "18.99.0", "18.99.0"]) {
      await manifest(version);
      expect(() => assertInstalledOmp(directory)).not.toThrow();
    }
  } finally {
    console.warn = originalWarn;
  }
  // Verified versions load silently; an unverified one warns once per version.
  expect(warnings).toHaveLength(1);
  expect(String(warnings[0])).toContain("host 18.99.0 is newer than the verified matrix");
});

test("library modules must come from the running omp, not another one on PATH (EXT-16)", async () => {
  const installed = (await Bun.file(join(findInstalledOmp(), "package.json")).json()) as {
    version: string;
  };
  const other = installed.version === "18.11.0" ? "18.11.1" : "18.11.0";
  expect(() => createRuntime({ VERSION: other } as unknown as HostNamespace)).toThrow(
    `differs from the running omp ${other}`,
  );
});

test("ordinary installed CLI passes its version smoke check", async () => {
  const child = Bun.spawn([Bun.which("omp")!, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code) {
    throw new Error(`Configured extension fixture failed: ${stderr}`);
  }
  expect(code).toBe(0);
  // findInstalledOmp rejects hosts outside the accepted range; unverified same-major hosts pass.
  const installed = (await Bun.file(join(findInstalledOmp(), "package.json")).json()) as {
    version: string;
  };
  expect(stdout.trim().endsWith(installed.version)).toBe(true);
  expect(stderr).toBe("");
});

test("ordinary CLI loads the configured extension and relocates native headless state with a fake provider", async () => {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "omp-nav-startup-")));
  temporary.push(directory);
  const cwd = join(directory, "project");
  const destination = join(directory, "destination");
  const agentDir = join(directory, "agent");
  await fs.mkdir(cwd);
  await fs.mkdir(destination);
  await fs.mkdir(agentDir);
  await fs.writeFile(join(cwd, "AGENTS.md"), "Source PROJECT_A_UNIQUE instructions.");
  await fs.writeFile(join(destination, "AGENTS.md"), "Destination PROJECT_B_UNIQUE instructions.");
  await fs.mkdir(join(cwd, ".omp"));
  await fs.mkdir(join(destination, ".omp"));
  await fs.writeFile(join(cwd, ".omp", "SYSTEM.md"), "Source SYSTEM_A_UNIQUE instructions.");
  await fs.writeFile(
    join(destination, ".omp", "SYSTEM.md"),
    "Destination SYSTEM_B_UNIQUE instructions.",
  );
  await fs.mkdir(join(destination, ".omp", "agents"));
  await fs.writeFile(
    join(destination, ".omp", "agents", "scope-check.md"),
    "---\nname: scope-check\ndescription: Scope fixture\nmodel: nav-fixture/fixture\nthinking-level: off\nspawns: '*'\n---\nSCOPE_CHILD_B_UNIQUE instructions.\n",
  );
  const config = join(directory, "config.yml");
  await fs.writeFile(
    config,
    "memory:\n  backend: off\nasync:\n  enabled: false\ntask:\n  structured: false\n  enableLsp: false\nlsp:\n  enabled: false\nmodelRoles:\n  default: nav-fixture/fixture\n  task: nav-fixture/fixture\nsetupVersion: 2\nstartup:\n  quiet: true\n  setupWizard: false\n  showSplash: false\n  checkUpdate: false\nmarketplace:\n  autoUpdate: false\n",
  );
  const fixture = join(directory, "fixture.ts");
  const report = join(directory, "report.json");
  const used = join(directory, "provider-used");
  const callsPath = join(directory, "calls.jsonl");
  await fs.writeFile(
    fixture,
    `import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
export default async function(pi) {
  const { createRuntime } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "runtime.ts"))});
  const { installHostBridge } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "host.ts"))});
  const bridge = await installHostBridge(createRuntime(pi.pi));
  const calls = () => fsSync.existsSync(${JSON.stringify(callsPath)}) ? fsSync.readFileSync(${JSON.stringify(callsPath)}, "utf8").trim().split("\\n").map(JSON.parse) : [];
  const mainCalls = () => calls().filter(context => !JSON.stringify(context.systemPrompt).includes("SCOPE_CHILD_B_UNIQUE"));
  const lastCall = () => mainCalls().at(-1);
  const mock = createMockModel({ id: "fixture", provider: "nav-fixture", handler: context => {
    void fs.writeFile(${JSON.stringify(used)}, "called");
    fsSync.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(context) + "\\n");
    if (JSON.stringify(context.systemPrompt).includes("SCOPE_CHILD_B_UNIQUE")) return { content: ["child completed"] };
    if (mainCalls().length === 1) return { content: [{ type: "toolCall", name: "session_move", arguments: { dir: ${JSON.stringify(destination)}, i: "Move to the accepted destination project." } }] };
    return { content: ["FAKE_PROVIDER_RESPONSE"] };
  } });
  pi.registerProvider("nav-fixture", { api: "nav-fixture-api", apiKey: "test-unused", baseUrl: "mock://", streamSimple: (_model, context, options) => mock.stream(mock, context, options), models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32000 }] });
  pi.on("session_start", async () => {
    registerCustomApi("nav-fixture-api", (_model, context, options) => mock.stream(mock, context, options), "nav-fixture-test", (_model, context, options) => mock.stream(mock, context, options));
  });
  pi.registerCommand("nav-fixture-probe", { description: "Check startup", handler: async (_args, ctx) => {
    const ref = pi.pi.AgentRegistry.global().get(ctx.agent.id);
    const session = ref.session;
    const before = { id: ctx.sessionManager.getSessionId(), cwd: ctx.sessionManager.getCwd(), file: ctx.sessionManager.getSessionFile() };
    before.prompt = ctx.getSystemPrompt();
    const targetTask = session.getToolByName("task");
    const taskResult = await targetTask.execute("startup-target-B", { cwd: ${JSON.stringify(destination)}, agent: "scope-check", name: "scope-B", task: "Report project scope", solutionSpace: "mechanical" });
    await session.prompt("Use the registered navigation tool to move to B, then check its context.");
    if (!lastCall()) throw new Error("Fake provider was not reached: " + JSON.stringify({ taskResult, model: session.model, messages: session.agent.state.messages }));
    const after = { id: ctx.sessionManager.getSessionId(), cwd: ctx.sessionManager.getCwd(), file: ctx.sessionManager.getSessionFile(), prompt: lastCall().systemPrompt, messages: lastCall().messages };
    await bridge.coordinator(ctx).request({ action: "move", dir: ${JSON.stringify(cwd)} });
    await session.prompt("Check return with local fake provider.");
    const returned = { id: ctx.sessionManager.getSessionId(), cwd: ctx.sessionManager.getCwd(), file: ctx.sessionManager.getSessionFile(), prompt: lastCall().systemPrompt };
    await fs.mkdir(${JSON.stringify(join(destination, ".omp", "tools"))}, { recursive: true });
    await fs.writeFile(${JSON.stringify(join(destination, ".omp", "tools", "destination-tool.ts"))}, "export default () => ({ name: 'destination_only' });");
    await bridge.coordinator(ctx).request({ action: "move", dir: ${JSON.stringify(destination)} });
    await session.prompt("Check safe refusal with local fake provider.");
    const refused = { cwd: ctx.sessionManager.getCwd(), file: ctx.sessionManager.getSessionFile(), messages: lastCall().messages };
    await fs.writeFile(${JSON.stringify(report)}, JSON.stringify({ matched: ref?.session?.sessionManager === ctx.sessionManager, tools: pi.getActiveTools(), before, after, returned, refused, fakeCalls: mainCalls().length, childContexts: calls().filter(context => JSON.stringify(context.systemPrompt).includes("SCOPE_CHILD_B_UNIQUE")).map(context => context.systemPrompt), taskResult }));
  } });
}`,
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CONFIG_DIR: relative(homedir(), join(directory, "configuration")),
  };
  delete env.OMP_PROFILE;
  delete env.PI_PROFILE;
  delete env.PI_CONFIG_FILES;
  for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
    const target = join(directory, key.toLowerCase());
    await fs.mkdir(join(target, "omp"), { recursive: true });
    env[key] = target;
  }
  await fs.appendFile(
    config,
    `extensions:\n  - ${JSON.stringify(join(import.meta.dir, "..", "src", "index.ts"))}\n  - ${JSON.stringify(fixture)}\n`,
  );
  const invocation = [
    Bun.which("omp")!,
    "-p",
    "--model",
    "nav-fixture/fixture",
    "--api-key",
    "test-unused",
    "--add-dir",
    destination,
    "--no-skills",
    "--config",
    config,
  ];
  const child = Bun.spawn([...invocation, "/nav-fixture-probe"], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code || !(await fs.exists(report))) {
    throw new Error(`Configured extension fixture failed: ${stderr}`);
  }
  expect(code).toBe(0);
  expect(stderr).not.toContain("Failed to load extension");
  expect(stdout).not.toContain("FAKE_PROVIDER_FALLBACK");
  const result = JSON.parse(await fs.readFile(report, "utf8"));
  expect(result.matched).toBe(true);
  expect(result.tools).toContain("session_move");
  expect(result.tools).toContain("task");
  expect(result.before.id).toBe(result.after.id);
  expect(JSON.stringify(result.before.prompt)).toContain("PROJECT_A_UNIQUE");
  expect(JSON.stringify(result.before.prompt)).not.toContain("PROJECT_B_UNIQUE");
  expect(result.after.id).toBe(result.returned.id);
  expect(result.after.cwd).toBe(destination);
  expect(result.returned.cwd).toBe(cwd);
  expect(result.after.file).not.toBe(result.before.file);
  expect(result.returned.file).toBe(result.before.file);
  expect(JSON.stringify(result.after.prompt)).toContain("PROJECT_B_UNIQUE");
  expect(JSON.stringify(result.after.prompt)).not.toContain("PROJECT_A_UNIQUE");
  expect(JSON.stringify(result.returned.prompt)).toContain("PROJECT_A_UNIQUE");
  expect(JSON.stringify(result.returned.prompt)).not.toContain("PROJECT_B_UNIQUE");
  // SYSTEM.md is resolved once at omp startup; a move keeps the start project's (accepted boundary).
  expect(JSON.stringify(result.before.prompt)).toContain("SYSTEM_A_UNIQUE");
  expect(JSON.stringify(result.after.prompt)).toContain("SYSTEM_A_UNIQUE");
  expect(JSON.stringify(result.after.prompt)).not.toContain("SYSTEM_B_UNIQUE");
  expect(JSON.stringify(result.after.messages)).toContain('\\"status\\":\\"applied\\"');
  expect(result.refused.cwd).toBe(destination);
  expect(result.refused.file).toBe(result.after.file);
  expect(result.tools).not.toContain("destination_only");
  expect(result.fakeCalls).toBe(4);
  expect(result.taskResult.details.results[0].exitCode).toBe(0);
  expect(result.childContexts.length).toBeGreaterThan(0);
  expect(JSON.stringify(result.childContexts[0])).toContain("PROJECT_B_UNIQUE");
  expect(JSON.stringify(result.childContexts[0])).not.toContain("PROJECT_A_UNIQUE");
}, 30_000);

test("configured package extension creates managed and exact worktrees through hosted native modules", async () => {
  const directory = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "omp-nav-config-worktrees-")),
  );
  temporary.push(directory);
  const cwd = join(directory, "project");
  const managed = join(directory, "managed");
  const agentDir = join(directory, "agent");
  await fs.mkdir(cwd);
  await fs.mkdir(agentDir);
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code) {
      throw new Error(`Fixture git failed: ${stderr}`);
    }
    return stdout;
  };
  await git("init", "-b", "main");
  await fs.writeFile(join(cwd, "tracked.txt"), "committed\n");
  await git("add", "tracked.txt");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  await fs.writeFile(join(cwd, "tracked.txt"), "source changes\n");
  await fs.writeFile(join(cwd, "untracked.txt"), "source untracked\n");
  const initialStatus = await git("status", "--porcelain");
  const fixture = join(directory, "fixture.ts");
  const report = join(directory, "report.json");
  const config = join(directory, "config.yml");
  await fs.writeFile(
    config,
    `memory:\n  backend: off\nasync:\n  enabled: false\ntask:\n  structured: false\n  enableLsp: false\nlsp:\n  enabled: false\nworktree:\n  base: ${JSON.stringify(managed)}\n  clone: false\nmodelRoles:\n  default: nav-fixture/fixture\nsetupVersion: 2\nstartup:\n  quiet: true\n  setupWizard: false\n  showSplash: false\n  checkUpdate: false\nmarketplace:\n  autoUpdate: false\nextensions:\n  - ${JSON.stringify(join(import.meta.dir, ".."))}\n  - ${JSON.stringify(fixture)}\n`,
  );
  await fs.writeFile(
    fixture,
    `import * as fs from "node:fs/promises";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import * as Registry from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as Task from "@oh-my-pi/pi-coding-agent/task";
import * as Capability from "@oh-my-pi/pi-coding-agent/capability";
import * as Utils from "@oh-my-pi/pi-utils";
export default async function(pi) {
  const { createRuntime } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "runtime.ts"))});
  const { installHostBridge } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "host.ts"))});
  const bridge = await installHostBridge(createRuntime(pi.pi));
  const mock = createMockModel({ id: "fixture", provider: "nav-fixture", handler: () => ({ content: ["local fixture complete"] }) });
  pi.registerProvider("nav-fixture", { api: "nav-fixture-api", apiKey: "test-unused", baseUrl: "mock://", streamSimple: (_model, context, options) => mock.stream(mock, context, options), models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32000 }] });
  pi.on("session_start", () => { registerCustomApi("nav-fixture-api", (_model, context, options) => mock.stream(mock, context, options), "nav-fixture-test", (_model, context, options) => mock.stream(mock, context, options)); });
  pi.registerCommand("worktree-probe", { description: "Local worktree fixture", handler: async (_args, ctx) => {
    const session = pi.pi.AgentRegistry.global().get(ctx.agent.id).session;
    const identities = { registry: Registry.AgentRegistry === pi.pi.AgentRegistry, task: Task.TaskTool === pi.pi.TaskTool, settings: Capability.boundSettings() === session.settings, utils: Utils.getAgentDir === pi.pi.getAgentDir };
    const before = { id: ctx.sessionManager.getSessionId(), cwd: ctx.sessionManager.getCwd(), file: ctx.sessionManager.getSessionFile() };
    await bridge.coordinator(ctx).request({ action: "create", branch: "managed-fixture" });
    await session.prompt("Apply managed creation with local provider.");
    const first = (await bridge.coordinator(ctx).navigation.listWorktrees()).find(entry => entry.branch === "managed-fixture");
    const afterCreate = { cwd: ctx.sessionManager.getCwd(), file: ctx.sessionManager.getSessionFile() };
    await bridge.coordinator(ctx).request({ action: "create", branch: "exact-fixture", path: ".claude/worktree/exact-fixture" });
    await session.prompt("Apply exact creation with local provider.");
    const second = (await bridge.coordinator(ctx).navigation.listWorktrees()).find(entry => entry.branch === "exact-fixture");
    if (!first || !second) throw new Error("Expected both created worktrees: " + JSON.stringify(session.agent.state.messages));
    const cleanContents = await fs.readFile(second.path + "/tracked.txt", "utf8");
    await bridge.coordinator(ctx).request({ action: "enter", path: second.path });
    await session.prompt("Enter exact worktree.");
    const entered = ctx.sessionManager.getCwd();
    await bridge.coordinator(ctx).request({ action: "exit" });
    await session.prompt("Return primary.");
    const returned = ctx.sessionManager.getCwd();
    for (const entry of [first, second]) {
      await bridge.coordinator(ctx).request({ action: "remove", path: entry.path });
      await session.prompt("Remove clean inactive fixture.");
    }
    await fs.writeFile(${JSON.stringify(report)}, JSON.stringify({ before, afterCreate, first, second, cleanContents, entered, returned, remaining: await bridge.coordinator(ctx).navigation.listWorktrees(), identities, id: ctx.sessionManager.getSessionId(), messages: session.agent.state.messages }));
  }});
}`,
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CONFIG_DIR: relative(homedir(), join(directory, "configuration")),
  };
  delete env.OMP_PROFILE;
  delete env.PI_PROFILE;
  delete env.PI_CONFIG_FILES;
  for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
    const target = join(directory, key.toLowerCase());
    await fs.mkdir(join(target, "omp"), { recursive: true });
    env[key] = target;
  }
  const child = Bun.spawn(
    [
      Bun.which("omp")!,
      "-p",
      "--model",
      "nav-fixture/fixture",
      "--api-key",
      "test-unused",
      "--config",
      config,
      "/worktree-probe",
    ],
    { cwd, env, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code || !(await fs.exists(report))) {
    throw new Error(`Configured worktree fixture failed: ${stderr}\n${stdout}`);
  }
  expect(stderr).not.toContain("Failed to load extension");
  const result = JSON.parse(await fs.readFile(report, "utf8"));
  expect(Object.values(result.identities).every((value) => value === true)).toBe(true);
  expect(result.first.path.startsWith(`${managed}/`)).toBe(true);
  expect(result.second.path).toBe(join(cwd, ".claude/worktree/exact-fixture"));
  expect(result.afterCreate).toEqual({ cwd: result.before.cwd, file: result.before.file });
  expect(result.id).toBe(result.before.id);
  expect(result.cleanContents).toBe("committed\n");
  expect(result.entered).toBe(result.second.path);
  expect(result.returned).toBe(cwd);
  expect(result.remaining).toHaveLength(1);
  expect(result.remaining[0].primary).toBe(true);
  expect(await git("status", "--porcelain")).toBe(initialStatus);
  expect(await git("branch", "--list", "managed-fixture", "exact-fixture")).toContain(
    "managed-fixture",
  );
  expect(await git("branch", "--list", "managed-fixture", "exact-fixture")).toContain(
    "exact-fixture",
  );
  expect(await fs.readFile(join(cwd, ".git/info/exclude"), "utf8")).toContain(
    "/.claude/worktree/exact-fixture/",
  );
}, 30_000);
