import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkspaceBridge, WorkspaceGrantState } from "../src/host";
import { NavigationError, WorkspaceNavigation } from "../src/navigation";
import { createRuntime, findInstalledOmp } from "../src/runtime";
import { type ExtensionContextLike, type HostNamespace, type SessionLike } from "../src/types";

const runtime = createRuntime({} as HostNamespace, findInstalledOmp());
const { SessionManager } = await runtime.importModule<{
  SessionManager: {
    inMemory(cwd: string): ConstructorParameters<typeof WorkspaceGrantState>[0] & {
      moveTo(cwd: string): Promise<void>;
      restoreState(state: unknown): void;
    };
  };
}>("session/session-manager.ts");
const { Settings } = await runtime.importModule<{
  Settings: {
    isolated(): { flush(): Promise<void> };
    loadReadOnly(options: Record<string, unknown>): Promise<SessionLike["settings"]>;
  };
}>("config/settings.ts");
const temporary: string[] = [];
afterEach(async () => {
  while (temporary.length) await fs.rm(temporary.pop()!, { force: true, recursive: true });
});
async function git(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code) throw new Error(stderr);
}

test("native manager preserves accepted B across A/B/worktree and revokes it without trusting visited paths", async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "omp-nav-grants-")));
  temporary.push(root);
  const a = join(root, "A");
  const b = join(root, "B");
  const wt = join(root, "B-worktree");
  await fs.mkdir(a);
  await fs.mkdir(b);
  await git(b, "init", "-b", "main");
  await git(
    b,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  await git(b, "worktree", "add", "-b", "fixture", wt);
  const manager = SessionManager.inMemory(a);
  await manager.addWorkspaceDirectory(b);
  const state = new WorkspaceGrantState(manager);
  const settings = Settings.isolated();
  const navigation = new WorkspaceNavigation(runtime, {
    initialCwd: state.initialCwd,
    getCwd: () => manager.getCwd(),
    getWorkspaceRoots: () => state.roots(),
    getSettings: () => settings,
    getLiveAgentCwds: () => [],
  });
  const move = async (target: string) =>
    state.withTransition(async () => {
      await navigation.validateMove(target);
      await manager.moveTo(target);
      await state.synchronize();
    });
  for (const target of [b, wt, b, a]) {
    await move(target);
    expect(state.roots()).toEqual([b]);
    expect(manager.getCwd()).toBe(target);
  }
  const resumed = SessionManager.inMemory(a);
  resumed.restoreState(manager.captureState());
  const restored = new WorkspaceGrantState(resumed);
  expect(restored.initialCwd).toBe(a);
  expect(restored.roots()).toEqual([b]);
  await move(b);
  expect(manager.getAdditionalDirectories()).toEqual([]);
  expect(await manager.removeWorkspaceDirectory(b)).toBe(b);
  expect(state.roots()).toEqual([]);
  await expect(navigation.validateEnter(wt)).rejects.toThrow("permission");
  await move(a);
  await expect(navigation.validateMove(b)).rejects.toThrow("permission");
  expect(state.roots()).not.toContain(wt);
});

test("an isolated child protects its source worktree even while its manager cwd is a sandbox", async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "omp-nav-child-owner-")));
  temporary.push(root);
  const main = join(root, "main");
  const source = join(root, "source-worktree");
  const sandbox = join(root, "sandbox");
  const agentDir = join(root, "agent");
  await fs.mkdir(main);
  await fs.mkdir(sandbox);
  await fs.mkdir(agentDir);
  await git(main, "init", "-b", "main");
  await git(
    main,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  await git(main, "worktree", "add", "-b", "fixture", source);
  const manager = SessionManager.inMemory(main);
  const rawChildSettings = await Settings.loadReadOnly({
    cwd: source,
    agentDir,
    overrides: { "memory.backend": "off" },
  });
  const session = {
    sessionManager: manager,
    settings: Settings.isolated(),
    agent: {
      addBeforeModelCallHook: () => () => {},
      addBeforeModelCall: () => () => {},
      state: { tools: [], systemPrompt: [], messages: [] },
    },
    addDisposer: () => {},
  } as unknown as SessionLike;
  const child = {
    sessionManager: SessionManager.inMemory(sandbox),
    settings: rawChildSettings,
  } as SessionLike;
  const refs = [
    { id: "main", kind: "main" as const, status: "running", session },
    { id: "isolated", kind: "sub" as const, status: "running", session: child },
  ];
  const host = {
    AgentRegistry: { global: () => ({ get: () => refs[0], list: () => refs }) },
  } as HostNamespace;
  const bridge = new WorkspaceBridge({ ...runtime, host });
  const ctx = {
    agent: { id: "main", kind: "main" },
    sessionManager: manager,
  } as ExtensionContextLike;
  const coordinator = bridge.coordinator(ctx);
  try {
    const worktrees = await coordinator.navigation.listWorktrees();
    expect(worktrees.find((item) => item.path === source)?.inUse).toBe(true);
    await expect(coordinator.navigation.removeWorktree(source)).rejects.toThrow("busy");
    expect(await fs.stat(source).then((stat) => stat.isDirectory())).toBe(true);
  } finally {
    coordinator.dispose();
  }
});

test("workspace_grant resolves a worktree to its primary, skips accepted roots, persists the grant and the permission failure suggests it", async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "omp-nav-grant-tool-")));
  temporary.push(root);
  const main = join(root, "main");
  const other = join(root, "other");
  const otherWt = join(root, "other-worktree");
  const agentDir = join(root, "agent");
  await fs.mkdir(main);
  await fs.mkdir(other);
  await fs.mkdir(agentDir);
  await git(other, "init", "-b", "main");
  await git(
    other,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  await git(other, "worktree", "add", "-b", "fixture", otherWt);
  const manager = SessionManager.inMemory(main);
  const session = {
    sessionManager: manager,
    settings: Settings.isolated(),
    agent: {
      addBeforeModelCallHook: () => () => {},
      addBeforeModelCall: () => () => {},
      state: { tools: [], systemPrompt: [], messages: [] },
    },
    addDisposer: () => {},
  } as unknown as SessionLike;
  const refs = [{ id: "main", kind: "main" as const, status: "running", session }];
  const host = {
    AgentRegistry: { global: () => ({ get: () => refs[0], list: () => refs }) },
  } as HostNamespace;
  const bridge = new WorkspaceBridge({ ...runtime, host });
  const ctx = {
    agent: { id: "main", kind: "main" },
    sessionManager: manager,
  } as ExtensionContextLike;
  const coordinator = bridge.coordinator(ctx);
  try {
    const failure = await coordinator.navigation.validateMove(otherWt).then(
      () => undefined,
      (error) => error,
    );
    if (!(failure instanceof NavigationError))
      throw new Error("validateMove outside roots must fail with NavigationError");
    expect(failure.code).toBe("permission");
    expect(failure.suggestedGrants).toEqual([other]);
    expect(failure.message).toContain("workspace_grant");
    const granted = await bridge.grantWorkspaceDirs(ctx, [otherWt]);
    expect(granted.granted).toEqual([other]);
    expect(granted.skipped).toEqual([]);
    expect(manager.getAdditionalDirectories()).toContain(other);
    const repeat = await bridge.grantWorkspaceDirs(ctx, [other]);
    expect(repeat.granted).toEqual([]);
    expect(repeat.skipped).toEqual([other]);
    expect(await coordinator.navigation.validateMove(otherWt)).toBe(otherWt);
    await expect(bridge.grantWorkspaceDirs(ctx, [join(other, ".git")])).rejects.toThrow(
      "Git metadata",
    );
    const resumed = SessionManager.inMemory(main);
    resumed.restoreState(manager.captureState());
    expect(new WorkspaceGrantState(resumed).roots()).toEqual([other]);
  } finally {
    coordinator.dispose();
  }
});
