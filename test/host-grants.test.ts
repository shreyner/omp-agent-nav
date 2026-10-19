import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkspaceBridge, WorkspaceGrantState } from "../src/host";
import { NavigationError } from "../src/navigation";
import { createRuntime, findInstalledOmp } from "../src/runtime";
import { type ExtensionContextLike, type HostNamespace, type SessionLike } from "../src/types";

const runtime = createRuntime({} as HostNamespace, findInstalledOmp());
const { SessionManager } = await runtime.importModule<{
  SessionManager: {
    inMemory(cwd: string): ConstructorParameters<typeof WorkspaceGrantState>[0] & {
      addWorkspaceDirectory(directory: string): Promise<string | null>;
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
  while (temporary.length) {
    await fs.rm(temporary.pop()!, { force: true, recursive: true });
  }
});
async function git(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code) {
    throw new Error(stderr);
  }
}

async function commit(cwd: string): Promise<void> {
  await git(cwd, "init", "-b", "main");
  await git(
    cwd,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
}

/** A main session that relocates through the real native moveTo, like the TUI owner path. */
async function relocating(name: string) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), `omp-nav-${name}-`)));
  temporary.push(root);
  const a = join(root, "A");
  const b = join(root, "B");
  const wt = join(root, "B-worktree");
  await fs.mkdir(a);
  await fs.mkdir(b);
  await commit(b);
  await git(b, "worktree", "add", "-b", "fixture", wt);
  const manager = SessionManager.inMemory(a);
  const prompts = { refreshed: 0 };
  const session = {
    sessionManager: manager,
    settings: Settings.isolated(),
    isCompacting: false,
    agent: {
      addBeforeModelCallHook: () => () => {},
      state: { tools: [], messages: [] },
      appendMessage: () => {},
    },
    addDisposer: () => {},
    settleMemoryBackend: async () => {},
    moveSession: async (cwd: string) => await manager.moveTo(cwd),
    refreshBaseSystemPrompt: async () => {
      prompts.refreshed++;
    },
    refreshSkillsAndCommands: async () => {},
  } as unknown as SessionLike;
  const refs = [{ id: "main", kind: "main" as const, status: "running", session }];
  const host = {
    AgentRegistry: { global: () => ({ get: () => refs[0], list: () => refs }) },
  } as unknown as HostNamespace;
  const bridge = new WorkspaceBridge({ ...runtime, host });
  const owner = {
    sessionManager: manager,
    applyCwdChange: async (_cwd: string) => true,
    withBtwSessionMove: async (operation: () => Promise<boolean>) => operation(),
    updateEditorBorderColor: () => {},
    reloadTodos: async () => {},
    ui: { requestRender: () => {} },
  };
  bridge.captureOwner(owner as unknown as Parameters<typeof bridge.captureOwner>[0]);
  const ctx = {
    agent: { id: "main", kind: "main" },
    sessionManager: manager,
  } as unknown as ExtensionContextLike;
  const coordinator = bridge.coordinator(ctx);
  const move = async (dir: string) => {
    await coordinator.request({ action: "move", dir });
    await coordinator.applyPending();
  };
  const ledgerEntries = () =>
    manager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === "omp-agent-nav.workspace");
  return { root, a, b, wt, manager, bridge, owner, ctx, coordinator, move, prompts, ledgerEntries };
}

test("an --add-dir root moves into the ledger before native moveTo drops it, and stays out of grants' AGENTS path", async () => {
  const f = await relocating("adopt");
  try {
    await f.manager.addWorkspaceDirectory(f.b);
    expect(f.ledgerEntries()).toHaveLength(0); // Creating the coordinator writes nothing.
    for (const target of [f.b, f.wt, f.b, f.a]) {
      await f.move(target);
      expect(f.manager.getCwd()).toBe(target);
      expect(f.coordinator.navigation.options.getWorkspaceRoots()).toEqual([f.b]);
    }
    // Native moveTo dropped B from the native list; the ledger kept it with one entry (CR-10).
    expect(f.manager.getAdditionalDirectories()).toEqual([]);
    expect(f.ledgerEntries()).toHaveLength(1);
    const resumed = SessionManager.inMemory(f.a);
    resumed.restoreState(f.manager.captureState());
    const restored = new WorkspaceGrantState(resumed);
    expect(restored.initialCwd).toBe(f.a);
    expect(restored.ledger()).toEqual([f.b]);
  } finally {
    f.coordinator.dispose();
  }
});

test("a move outside any native root keeps the start root across resume", async () => {
  const f = await relocating("initial");
  try {
    await f.bridge.grantWorkspaceDirs(f.ctx, [f.b]);
    await f.move(f.b);
    const resumed = SessionManager.inMemory(f.b);
    resumed.restoreState(f.manager.captureState());
    expect(new WorkspaceGrantState(resumed).initialCwd).toBe(f.a);
  } finally {
    f.coordinator.dispose();
  }
});

test("a failed move rolls the adopted root back out of the ledger", async () => {
  const f = await relocating("rollback");
  try {
    await f.manager.addWorkspaceDirectory(f.b);
    f.owner.applyCwdChange = async (cwd) => cwd !== f.b;
    await f.move(f.b);
    expect(f.manager.getCwd()).toBe(f.a);
    expect(f.manager.getAdditionalDirectories()).toEqual([f.b]);
    expect(f.ledgerEntries()).toHaveLength(0);
    expect(await f.bridge.listRoots(f.ctx)).toEqual([
      { root: f.a, source: "start", missing: false },
      { root: f.b, source: "add-dir", missing: false },
    ]);
  } finally {
    f.coordinator.dispose();
  }
});

test("a native root dropped by the settings watcher during the move stays accepted", async () => {
  const f = await relocating("watcher");
  try {
    const nested = join(f.b, "nested");
    await fs.mkdir(nested);
    await f.manager.addWorkspaceDirectory(f.b);
    // Settings of the target drop B from workspace.additionalDirectories while the move applies.
    f.owner.applyCwdChange = async () => {
      await f.manager.removeWorkspaceDirectory(f.b);
      return true;
    };
    await f.move(nested);
    expect(f.manager.getCwd()).toBe(nested);
    expect(f.coordinator.navigation.options.getWorkspaceRoots()).toEqual([f.b]);
  } finally {
    f.coordinator.dispose();
  }
});

test("a native root added through a symlink alias needs no approval and revokes by its stored form", async () => {
  const f = await relocating("alias");
  try {
    const alias = join(f.root, "B-alias");
    await fs.symlink(f.b, alias);
    await f.manager.addWorkspaceDirectory(alias);
    expect(f.manager.getAdditionalDirectories()).toEqual([alias]);
    expect(f.bridge.moveNeedsGrant(f.b)).toBe(false);
    expect((await f.bridge.grantWorkspaceDirs(f.ctx, [f.b])).skipped).toEqual([f.b]);
    expect(await f.bridge.revokeRoot(f.ctx, f.b)).toEqual({ revoked: [f.b], coveredBy: undefined });
    expect(f.manager.getAdditionalDirectories()).toEqual([]);
    expect(f.prompts.refreshed).toBe(1);
  } finally {
    f.coordinator.dispose();
  }
});

test("/nav-roots revoke removes a grant from the ledger and the native list, with refusals", async () => {
  const f = await relocating("revoke");
  try {
    await f.bridge.grantWorkspaceDirs(f.ctx, [f.b]);
    await expect(f.bridge.revokeRoot(f.ctx, f.a)).rejects.toThrow("start project");
    await expect(f.bridge.revokeRoot(f.ctx, join(f.root, "unknown"))).rejects.toThrow(
      "not a granted workspace root",
    );
    await expect(f.bridge.revokeRoot(f.ctx, join(f.a, "inside"))).rejects.toThrow(`inside ${f.a}`);
    // The session stands in B's worktree, outside B's directory but authorized through it.
    await f.move(f.wt);
    await expect(f.bridge.revokeRoot(f.ctx, f.b)).rejects.toThrow("move out of it");
    await f.move(f.a);
    // An old session also kept the grant in the native list: revoke clears both.
    await f.manager.addWorkspaceDirectory(f.b);
    expect(await f.bridge.revokeRoot(f.ctx, f.wt)).toEqual({
      revoked: [f.b],
      coveredBy: undefined,
    });
    expect(f.manager.getAdditionalDirectories()).toEqual([]);
    expect(f.prompts.refreshed).toBeGreaterThan(0);
    await expect(f.coordinator.navigation.validateMove(f.wt)).rejects.toThrow("permission");
    await expect(f.coordinator.navigation.validateMove(f.b)).rejects.toThrow("permission");
    // A vanished grant is still revocable by its path.
    const gone = join(f.root, "gone");
    await fs.mkdir(gone);
    await f.bridge.grantWorkspaceDirs(f.ctx, [gone]);
    await fs.rm(gone, { recursive: true });
    expect(await f.bridge.listRoots(f.ctx)).toContainEqual({
      root: gone,
      source: "grant",
      missing: true,
    });
    expect((await f.bridge.revokeRoot(f.ctx, gone)).revoked).toEqual([gone]);
  } finally {
    f.coordinator.dispose();
  }
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
  } as unknown as SessionLike;
  const refs = [
    { id: "main", kind: "main" as const, status: "running", session },
    { id: "isolated", kind: "sub" as const, status: "running", session: child },
  ];
  const host = {
    AgentRegistry: { global: () => ({ get: () => refs[0], list: () => refs }) },
  } as unknown as HostNamespace;
  const bridge = new WorkspaceBridge({ ...runtime, host });
  const ctx = {
    agent: { id: "main", kind: "main" },
    sessionManager: manager,
  } as unknown as ExtensionContextLike;
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
  } as unknown as HostNamespace;
  const bridge = new WorkspaceBridge({ ...runtime, host });
  const ctx = {
    agent: { id: "main", kind: "main" },
    sessionManager: manager,
  } as unknown as ExtensionContextLike;
  const coordinator = bridge.coordinator(ctx);
  try {
    const failure = await coordinator.navigation.validateMove(otherWt).then(
      () => undefined,
      (error) => error,
    );
    if (!(failure instanceof NavigationError)) {
      throw new Error("validateMove outside roots must fail with NavigationError");
    }
    expect(failure.code).toBe("permission");
    expect(failure.suggestedGrants).toEqual([other]);
    expect(failure.message).toContain("workspace_grant");
    const granted = await bridge.grantWorkspaceDirs(ctx, [otherWt]);
    expect(granted.granted).toEqual([other]);
    expect(granted.skipped).toEqual([]);
    // Grants stay out of the native list, so the host does not load their AGENTS.
    expect(manager.getAdditionalDirectories()).not.toContain(other);
    const repeat = await bridge.grantWorkspaceDirs(ctx, [other]);
    expect(repeat.granted).toEqual([]);
    expect(repeat.skipped).toEqual([other]);
    expect(await coordinator.navigation.validateMove(otherWt)).toBe(otherWt);
    await expect(bridge.grantWorkspaceDirs(ctx, [join(other, ".git")])).rejects.toThrow(
      "Git metadata",
    );
    // The starting project is accepted already.
    const initial = await bridge.grantWorkspaceDirs(ctx, ["."]);
    expect(initial.granted).toEqual([]);
    expect(initial.skipped).toEqual([main]);
    // Every directory resolves before any grant: one bad path grants nothing.
    const third = join(root, "third");
    await fs.mkdir(third);
    await expect(bridge.grantWorkspaceDirs(ctx, [third, join(root, "missing")])).rejects.toThrow(
      "Cannot open directory",
    );
    expect(bridge.navigation(ctx).options.getWorkspaceRoots()).not.toContain(third);
    const resumed = SessionManager.inMemory(main);
    resumed.restoreState(manager.captureState());
    expect(new WorkspaceGrantState(resumed).roots()).toEqual([other]);
  } finally {
    coordinator.dispose();
  }
});
