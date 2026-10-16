import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkspaceBridge, type WorkspaceCoordinator, WorkspaceGrantState } from "../src/host";
import { registerSessionMoveTool } from "../src/index";
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
const { Type } = await runtime.importModule<{
  Type: {
    Object(properties: Record<string, unknown>, options?: Record<string, unknown>): unknown;
    String(options?: Record<string, unknown>): unknown;
  };
}>("@oh-my-pi/omptype/typebox");

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
  } as HostNamespace;
  const bridge = new WorkspaceBridge({ ...runtime, host });
  let coordinator!: WorkspaceCoordinator;
  const ctx = {
    agent: { id: "main", kind: "main" },
    sessionManager: manager,
    requestWorkspaceChange: (request: WorkspaceRequest) => coordinator.request(request),
  } as ExtensionContextLike;
  coordinator = bridge.coordinator(ctx);
  let definition: ToolDefinitionLike | undefined;
  const pi = {
    registerTool: (tool: ToolDefinitionLike) => {
      if (tool.name === "session_move") {
        definition = tool;
      }
    },
    on: () => {},
    registerCommand: () => {},
  } as ExtensionApiLike;
  registerSessionMoveTool(
    pi,
    bridge,
    Type as unknown as Parameters<typeof registerSessionMoveTool>[2],
  );
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
  const execute = async (dir: string) => {
    const id = `call-${Math.random().toString(36).slice(2)}`;
    const gate = session.agent.beforeToolCall as (context: ToolCallContext) => Promise<unknown>;
    await gate({
      assistantMessage: { content: [{ type: "toolCall", id, name: "session_move" }] },
      toolCall: { id, name: "session_move" },
    });
    return await definition!.execute(id, { dir }, undefined, undefined, ctx);
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
