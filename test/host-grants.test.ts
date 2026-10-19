import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkspaceBridge, WorkspaceGrantState } from "../src/host";
import { registerCommands } from "../src/index";
import { NavigationError } from "../src/navigation";
import { createRuntime, findInstalledOmp } from "../src/runtime";
import {
  type ExtensionApiLike,
  type ExtensionContextLike,
  type HostNamespace,
  type SessionLike,
} from "../src/types";

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
    isolated(values?: Record<string, unknown>): SessionLike["settings"];
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

/**
 * A main session that relocates through the real native moveTo, like the TUI owner path.
 * `start` runs before the coordinator exists, i.e. while omp sets up the session.
 */
async function relocating(
  name: string,
  start?: (f: { root: string; manager: ReturnType<typeof SessionManager.inMemory> }) => unknown,
) {
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
  await bridge.loadSettingRegistry();
  await start?.({ root, manager });
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
  return {
    root,
    a,
    b,
    wt,
    manager,
    session,
    bridge,
    owner,
    ctx,
    coordinator,
    move,
    prompts,
    ledgerEntries,
  };
}

/** Settings whose `workspace.additionalDirectories` lists `dirs`, as a project config would. */
function configuring(dirs: string[]): SessionLike["settings"] {
  return Settings.isolated({ "workspace.additionalDirectories": dirs });
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

test("the first move records the start root, so a resume elsewhere keeps it", async () => {
  const f = await relocating("initial");
  try {
    const sub = join(f.a, "sub");
    await fs.mkdir(sub);
    expect(f.ledgerEntries()).toHaveLength(0);
    // No grant and no native root: only the move itself can record the start root.
    await f.move(sub);
    expect(f.ledgerEntries()).toHaveLength(1);
    const resumed = SessionManager.inMemory(sub);
    resumed.restoreState(f.manager.captureState());
    expect(new WorkspaceGrantState(resumed).initialCwd).toBe(f.a);
  } finally {
    f.coordinator.dispose();
  }
});

test("roots a move target's project settings configure are not accepted and not adopted", async () => {
  const f = await relocating("configured");
  try {
    const clone = join(f.b, "clone");
    const secret = join(f.root, "secret");
    await fs.mkdir(clone);
    await fs.mkdir(secret);
    await f.bridge.grantWorkspaceDirs(f.ctx, [f.b]);
    // Entering clone reloads its settings; the host watcher adds the configured root natively.
    f.owner.applyCwdChange = async (cwd) => {
      if (cwd === clone) {
        f.session.settings = configuring([f.root]);
        await f.manager.addWorkspaceDirectory(f.root);
      }
      return true;
    };
    await f.move(clone);
    expect(f.manager.getAdditionalDirectories()).toEqual([f.root]);
    expect(f.bridge.moveNeedsGrant(secret)).toBe(true);
    await expect(f.coordinator.navigation.validateMove(secret)).rejects.toThrow("permission");
    await f.move(f.b);
    expect(f.coordinator.navigation.options.getWorkspaceRoots()).toEqual([f.b]);
  } finally {
    f.coordinator.dispose();
  }
});

test("roots present when the session starts seed the ledger and survive the settings watcher", async () => {
  const shared = { dir: "" };
  const f = await relocating("seeded", async ({ root, manager }) => {
    shared.dir = join(root, "shared");
    await fs.mkdir(shared.dir);
    // omp merges the start project's workspace.additionalDirectories before the extension starts.
    await manager.addWorkspaceDirectory(shared.dir);
  });
  try {
    f.session.settings = configuring([shared.dir]);
    expect(f.coordinator.navigation.options.getWorkspaceRoots()).toEqual([shared.dir]);
    // Leaving A drops A's configured root natively; it stays accepted.
    f.owner.applyCwdChange = async () => {
      f.session.settings = configuring([]);
      await f.manager.removeWorkspaceDirectory(shared.dir);
      return true;
    };
    await f.bridge.grantWorkspaceDirs(f.ctx, [f.b]);
    await f.move(f.b);
    expect(f.coordinator.navigation.options.getWorkspaceRoots()).toEqual([shared.dir, f.b]);
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
    f.prompts.refreshed = 0;
    expect(await f.bridge.revokeRoot(f.ctx, f.wt)).toEqual({
      revoked: [f.b],
      coveredBy: undefined,
    });
    expect(f.manager.getAdditionalDirectories()).toEqual([]);
    expect(f.prompts.refreshed).toBe(1);
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

test("/nav-roots revoke names roots exactly: a subdirectory never takes its whole repository", async () => {
  const f = await relocating("revoke-exact");
  try {
    const docs = join(f.b, "docs");
    await fs.mkdir(docs);
    await f.bridge.grantWorkspaceDirs(f.ctx, [f.b]);
    await expect(f.bridge.revokeRoot(f.ctx, docs)).rejects.toThrow(`inside ${f.b}`);
    await f.manager.addWorkspaceDirectory(docs);
    expect(await f.bridge.revokeRoot(f.ctx, docs)).toEqual({ revoked: [docs], coveredBy: f.b });
    expect(f.coordinator.navigation.options.getWorkspaceRoots()).toEqual([f.b]);
  } finally {
    f.coordinator.dispose();
  }
});

test("a session already outside every root may still revoke, and a failed move keeps the start root", async () => {
  const f = await relocating("outside");
  try {
    const x = join(f.root, "X");
    await fs.mkdir(x);
    // Native /move bypasses the extension and leaves the session outside every root.
    await f.manager.moveTo(x);
    await f.bridge.grantWorkspaceDirs(f.ctx, [f.b]);
    expect((await f.bridge.revokeRoot(f.ctx, f.b)).revoked).toEqual([f.b]);
    // Grants and revokes so far wrote the ledger with the real start root.
    expect(new WorkspaceGrantState(f.manager).initialCwd).toBe(f.a);
  } finally {
    f.coordinator.dispose();
  }
});

test("a rolled-back first move keeps the start root even after a native /move", async () => {
  const f = await relocating("reload");
  try {
    const x = join(f.root, "X");
    const sub = join(f.a, "sub");
    await fs.mkdir(x);
    await fs.mkdir(sub);
    await f.manager.moveTo(x);
    f.owner.applyCwdChange = async (cwd) => cwd !== sub;
    await f.move(sub);
    expect(f.manager.getCwd()).toBe(x);
    expect(f.ledgerEntries()).toHaveLength(0);
    await f.bridge.grantWorkspaceDirs(f.ctx, [f.b]);
    expect(new WorkspaceGrantState(f.manager).initialCwd).toBe(f.a);
  } finally {
    f.coordinator.dispose();
  }
});

test("/nav-roots and /nav-move commands: idle gate, usage, listing, revoke and a failed move", async () => {
  const f = await relocating("commands");
  try {
    interface Command {
      handler(args: string, ctx: ExtensionContextLike): Promise<void>;
    }
    const commands = new Map<string, Command>();
    registerCommands(
      {
        registerCommand: (name: string, command: Command) => commands.set(name, command),
      } as unknown as ExtensionApiLike,
      f.bridge,
    );
    const notices: string[] = [];
    let idle = true;
    const ctx = {
      ...f.ctx,
      isIdle: () => idle,
      ui: { notify: (message: string) => notices.push(message) },
    } as unknown as ExtensionContextLike;
    const run = (name: string, args: string) => commands.get(name)!.handler(args, ctx);
    await f.bridge.grantWorkspaceDirs(f.ctx, [f.b]);
    await run("nav-roots", "");
    expect(notices.pop()).toBe(`start: ${f.a}\ngrant: ${f.b}`);
    await expect(run("nav-roots", "drop B")).rejects.toThrow("Usage");
    idle = false;
    await expect(run("nav-roots", `revoke ${f.b}`)).rejects.toThrow(
      "Wait for the current response",
    );
    await expect(run("nav-move", f.b)).rejects.toThrow("Wait for the current response");
    idle = true;
    f.owner.applyCwdChange = async (cwd) => cwd !== f.wt;
    await expect(run("nav-move", f.wt)).rejects.toThrow("Workspace transition failed");
    await run("nav-roots", `revoke ${f.b}`);
    expect(notices.pop()).toBe(`Revoked ${f.b}.`);
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
