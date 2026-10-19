import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { WorkspaceBridge, type WorkspaceCoordinator, WorkspaceGrantState } from "../src/host";
import { registerSessionMoveTool, registerWorkspaceGrantTool } from "../src/index";
import { NavigationError } from "../src/navigation";
import { createRuntime, findInstalledOmp } from "../src/runtime";
import {
  type ExtensionApiLike,
  type ExtensionContextLike,
  type HostNamespace,
  type SessionLike,
  type ToolCallContext,
  type ToolDefinitionLike,
  type WorkspaceRequest,
} from "../src/types";

const runtime = createRuntime({} as HostNamespace, findInstalledOmp());
const { SessionManager } = await runtime.importModule<{
  SessionManager: {
    inMemory(cwd: string): ConstructorParameters<typeof WorkspaceGrantState>[0] & {
      restoreState(state: unknown): void;
      setCwdWithoutRelocation(cwd: string): void;
    };
  };
}>("session/session-manager.ts");
const { Settings } = await runtime.importModule<{
  Settings: { isolated(): SessionLike["settings"] };
}>("config/settings.ts");
const { Type } = await runtime.importModule<{ Type: unknown }>("@oh-my-pi/omptype/typebox");

async function git(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  if (await child.exited) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(child.stderr).text()}`);
  }
}

const temporary: string[] = [];
afterEach(async () => {
  while (temporary.length) {
    await fs.rm(temporary.pop()!, { force: true, recursive: true });
  }
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "omp-nav-move-approval-")));
  temporary.push(root);
  const a = join(root, "A");
  const b = join(root, "B");
  const c = join(root, "C");
  await fs.mkdir(a);
  await fs.mkdir(b);
  await fs.mkdir(c);
  const manager = SessionManager.inMemory(a);
  const messages: unknown[] = [];
  const session = {
    sessionManager: manager,
    settings: Settings.isolated(),
    isCompacting: false,
    agent: {
      addBeforeModelCallHook: () => () => {},
      addBeforeModelCall: () => () => {},
      state: { tools: [], systemPrompt: [], messages },
      appendMessage: (message: unknown) => {
        messages.push(message);
      },
    },
    addDisposer: () => {},
    settleMemoryBackend: async () => {},
    moveSession: async (cwd: string) => {
      manager.setCwdWithoutRelocation(cwd);
    },
    refreshBaseSystemPrompt: async () => {},
    refreshSkillsAndCommands: async () => {},
  } as unknown as SessionLike;
  const refs = [{ id: "main", kind: "main" as const, status: "running", session }];
  const host = {
    AgentRegistry: { global: () => ({ get: () => refs[0], list: () => refs }) },
  } as unknown as HostNamespace;
  const bridge = new WorkspaceBridge({ ...runtime, host });
  let coordinator!: WorkspaceCoordinator;
  const ctx = {
    agent: { id: "main", kind: "main" },
    sessionManager: manager,
    requestWorkspaceChange: (request: WorkspaceRequest) => coordinator.request(request),
  } as unknown as ExtensionContextLike;
  coordinator = bridge.coordinator(ctx);
  const tools = new Map<string, ToolDefinitionLike>();
  const pi = {
    registerTool: (tool: ToolDefinitionLike) => {
      tools.set(tool.name, tool);
    },
    on: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionApiLike;
  const schema = Type as unknown as Parameters<typeof registerSessionMoveTool>[2];
  registerSessionMoveTool(pi, bridge, schema);
  registerWorkspaceGrantTool(pi, bridge, schema);
  const definition = tools.get("session_move");
  const grantTool = tools.get("workspace_grant")!;
  const owner = {
    sessionManager: manager,
    applyCwdChange: async () => true,
    withBtwSessionMove: async (operation: () => Promise<boolean>) => operation(),
    updateEditorBorderColor: () => {},
    reloadTodos: async () => {},
    ui: { requestRender: () => {} },
  };
  const capture = () =>
    bridge.captureOwner(owner as unknown as Parameters<typeof bridge.captureOwner>[0]);
  const approval = (args: unknown) => (definition!.approval as (args: unknown) => unknown)(args);
  const admit = async (name: string, args: unknown) => {
    const id = `call-${Math.random().toString(36).slice(2)}`;
    const gate = session.agent.beforeToolCall as (context: ToolCallContext) => Promise<unknown>;
    await gate({
      assistantMessage: { content: [{ type: "toolCall", name }] },
      toolCall: { id, name, arguments: args },
    });
    return id;
  };
  /** Execute only, as when the target changes after the host evaluated approval. */
  const executeRaw = async (dir: string) =>
    await definition!.execute(
      await admit("session_move", { dir }),
      { dir },
      undefined,
      undefined,
      ctx,
    );
  /** Host order: approval decision, dialog details, then execute. */
  const execute = async (dir: string) => {
    approval({ dir });
    definition!.formatApprovalDetails?.({ dir });
    return await executeRaw(dir);
  };
  const grant = async (dirs: string[], swap?: () => Promise<void>) => {
    grantTool.formatApprovalDetails?.({ dirs });
    await swap?.();
    return await grantTool.execute(
      await admit("workspace_grant", { dirs }),
      { dirs },
      undefined,
      undefined,
      ctx,
    );
  };
  return {
    root,
    a,
    b,
    c,
    manager,
    bridge,
    coordinator,
    ctx,
    capture,
    approval,
    execute,
    executeRaw,
    grant,
    grantTool,
    definition,
    messages,
  };
}

test("session_move approval prompts only for out-of-roots targets in an interactive session", async () => {
  const f = await fixture();
  try {
    expect(typeof f.definition?.approval).toBe("function");
    expect(f.approval({ dir: f.b })).toBe("write"); // No interactive owner yet: headless keeps the fail-closed path.
    f.capture();
    expect(f.approval({ dir: f.b })).toEqual({
      tier: "write",
      policy: "prompt",
      reason: "Цель вне принятых workspace-корней",
    });
    expect(f.approval({ dir: join(f.a, "nested") })).toBe("write");
    expect(f.approval({})).toBe("write");
    expect(f.approval({ dir: join(f.c, ".git", "objects") })).toBe("write");
    expect(f.definition?.formatApprovalDetails?.({ dir: f.b })).toEqual([`dir: ${f.b}`]);
  } finally {
    f.coordinator.dispose();
  }
});

test("an approved session_move grants the destination root, records the ledger and applies the move", async () => {
  const f = await fixture();
  f.capture();
  try {
    const receipt = (await f.execute(f.b)) as {
      details: { status: string; action: string; target: string };
    };
    expect(receipt.details.status).toBe("queued");
    expect(receipt.details.action).toBe("move");
    expect(receipt.details.target).toBe(f.b);
    expect(f.manager.getAdditionalDirectories()).toContain(f.b); // The execute-time grant lands while the cwd is still A.
    await f.coordinator.applyPending();
    expect(f.manager.getCwd()).toBe(f.b);
    expect(f.manager.getAdditionalDirectories()).toEqual([]); // The native manager drops the now-current root; the permission survives in the ledger.
    expect(f.coordinator.navigation.options.getWorkspaceRoots()).toEqual([f.b]);
    const resumed = SessionManager.inMemory(f.a);
    resumed.restoreState(f.manager.captureState());
    expect(new WorkspaceGrantState(resumed).roots()).toEqual([f.b]);
    expect(JSON.stringify(f.messages)).toContain('\\"status\\":\\"applied\\"');
  } finally {
    f.coordinator.dispose();
  }
});

test("a repeat move into the confirmed root needs no new approval", async () => {
  const f = await fixture();
  f.capture();
  try {
    await f.execute(f.b);
    await f.coordinator.applyPending();
    expect(f.approval({ dir: f.b })).toBe("write");
    expect(f.approval({ dir: "." })).toBe("write");
    expect(f.bridge.moveNeedsGrant(f.b)).toBe(false);
  } finally {
    f.coordinator.dispose();
  }
});

test("git metadata destinations keep plain write approval and the metadata rejection", async () => {
  const f = await fixture();
  f.capture();
  try {
    expect(f.approval({ dir: join(f.c, ".git") })).toBe("write");
    await expect(f.coordinator.navigation.validateMove(join(f.c, ".git"))).rejects.toThrow(
      "Git metadata is not a workspace",
    );
  } finally {
    f.coordinator.dispose();
  }
});

test("task.cwd outside roots keeps the permission failure with the grant hint", async () => {
  const f = await fixture();
  try {
    const failure = await f.bridge.assertAllowedPath(f.ctx, f.c).then(
      () => undefined,
      (error) => error,
    );
    expect(failure).toBeInstanceOf(NavigationError);
    expect(failure.suggestedGrants).toEqual([f.c]);
    expect(failure.message).toContain("workspace_grant");
  } finally {
    f.coordinator.dispose();
  }
});

test("a granted root reached through a symlink alias needs no approval (M09-wg)", async () => {
  const f = await fixture();
  f.capture();
  try {
    // macOS /var → /private/var: the ledger holds realpaths, the model may send the alias.
    const alias = join(f.root, "C-alias");
    await fs.symlink(f.c, alias);
    expect(f.approval({ dir: alias })).toEqual(expect.objectContaining({ policy: "prompt" }));
    expect(f.definition?.formatApprovalDetails?.({ dir: alias })).toEqual([
      `dir: ${alias} → grant: ${f.c}`,
    ]);
    await f.bridge.grantWorkspaceDirs(f.ctx, [f.c]);
    expect(f.approval({ dir: alias })).toBe("write");
    expect(f.approval({ dir: f.c })).toBe("write");
    const receipt = (await f.execute(alias)) as { details: { status: string; target: string } };
    expect(receipt.details.status).toBe("queued");
    expect(receipt.details.target).toBe(f.c);
  } finally {
    f.coordinator.dispose();
  }
});

test("a missing target and a worktree of an accepted project need no approval", async () => {
  const f = await fixture();
  f.capture();
  try {
    expect(f.approval({ dir: join(f.root, "missing") })).toBe("write");
    await git(f.c, "init", "-b", "main");
    await git(
      f.c,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    );
    const worktree = join(f.root, "C-worktree");
    await git(f.c, "worktree", "add", "-b", "fixture", worktree);
    expect(f.approval({ dir: worktree })).toEqual(expect.objectContaining({ policy: "prompt" }));
    expect(f.definition?.formatApprovalDetails?.({ dir: worktree })).toEqual([
      `dir: ${worktree} → grant: ${f.c}`,
    ]);
    await f.bridge.grantWorkspaceDirs(f.ctx, [f.c]);
    expect(f.approval({ dir: worktree })).toBe("write");
  } finally {
    f.coordinator.dispose();
  }
});

test("a target swapped after approval is never granted without the dialog", async () => {
  const f = await fixture();
  f.capture();
  try {
    const sub = join(f.a, "sub");
    await fs.mkdir(sub);
    const link = join(f.a, "link");
    await fs.symlink(sub, link);
    // Approved as an in-root move (no dialog), then the link is swapped to an outside project.
    expect(f.approval({ dir: link })).toBe("write");
    await fs.rm(link);
    await fs.symlink(f.c, link);
    await expect(f.executeRaw(link)).rejects.toThrow("outside the accepted workspace roots");
    expect(f.coordinator.navigation.options.getWorkspaceRoots()).toEqual([]);
    // The dialog showed C; the link now leads to B: the shown root is not granted silently either.
    expect(f.approval({ dir: link })).toEqual(expect.objectContaining({ policy: "prompt" }));
    expect(f.definition?.formatApprovalDetails?.({ dir: link })).toEqual([
      `dir: ${link} → grant: ${f.c}`,
    ]);
    await fs.rm(link);
    await fs.symlink(f.b, link);
    await expect(f.executeRaw(link)).rejects.toThrow(`not the approved ${f.c}`);
    expect(f.coordinator.navigation.options.getWorkspaceRoots()).toEqual([]);
  } finally {
    f.coordinator.dispose();
  }
});

test("workspace_grant grants only the roots its dialog showed", async () => {
  const f = await fixture();
  f.capture();
  try {
    const link = join(f.root, "link");
    await fs.symlink(f.c, link);
    expect(f.grantTool.formatApprovalDetails?.({ dirs: [link] })).toEqual([
      `dir: ${link} → grant: ${f.c}`,
    ]);
    const swap = async () => {
      await fs.rm(link);
      await fs.symlink(f.b, link);
    };
    await expect(f.grant([link], swap)).rejects.toThrow(`not the approved ${f.c}`);
    expect(f.coordinator.navigation.options.getWorkspaceRoots()).toEqual([]);
    const granted = (await f.grant([link])) as { details: { granted: string[] } };
    expect(granted.details.granted).toEqual([f.b]);
  } finally {
    f.coordinator.dispose();
  }
});

test("workspace_grant refuses a path that had no root in its dialog; duplicates stay bound", async () => {
  const f = await fixture();
  f.capture();
  try {
    // The path does not exist while the dialog renders, then appears pointing at C.
    const later = join(f.root, "later");
    const appear = async () => {
      await fs.symlink(f.c, later);
    };
    await expect(f.grant([later], appear)).rejects.toThrow("showed no grant root");
    expect(f.coordinator.navigation.options.getWorkspaceRoots()).toEqual([]);
    const granted = (await f.grant([later, later])) as { details: { granted: string[] } };
    expect(granted.details.granted).toEqual([f.c]);
  } finally {
    f.coordinator.dispose();
  }
});

test("`~` resolves to the home directory in the dialog and in the grant", async () => {
  const f = await fixture();
  f.capture();
  try {
    // A decoy literal `~` directory in the cwd must not be what gets granted. The session is
    // in-memory: granting the real home touches nothing on disk. (Bun caches HOME at startup.)
    await fs.mkdir(join(f.a, "~"));
    const preview = f.bridge.grantPreview("~");
    expect(preview).toBeDefined();
    expect(f.grantTool.formatApprovalDetails?.({ dirs: ["~"] })).toEqual([
      `dir: ~ → grant: ${preview}`,
    ]);
    const granted = (await f.grant(["~"])) as { details: { granted: string[] } };
    expect(granted.details.granted).toEqual([preview!]);
    expect(preview).toBe(await fs.realpath(homedir()));
  } finally {
    f.coordinator.dispose();
  }
});

test("without an interactive owner the move fails closed without granting", async () => {
  const f = await fixture();
  try {
    await expect(f.execute(f.c)).rejects.toThrow("outside the accepted workspace roots");
    expect(f.manager.getAdditionalDirectories()).toEqual([]);
    expect(f.coordinator.navigation.options.getWorkspaceRoots()).toEqual([]);
  } finally {
    f.coordinator.dispose();
  }
});
