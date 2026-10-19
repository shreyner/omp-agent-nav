import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkspaceBridge, WorkspaceCoordinator, WorkspaceRollbackError } from "../src/host";
import { WorkspaceNavigation } from "../src/navigation";
import { createRuntime, findInstalledOmp } from "../src/runtime";
import { type HostNamespace, type SessionLike, type SessionManagerLike } from "../src/types";

const runtime = createRuntime({} as HostNamespace, findInstalledOmp());
type TestAgent = SessionLike["agent"] & {
  prompt(text: string): Promise<void>;
  setSystemPrompt(prompt: string[]): void;
};
interface MockContext {
  messages: Array<{ role: string; content: unknown }>;
  systemPrompt: string[];
}
const { Agent } = await runtime.importModule<{
  Agent: new (options: Record<string, unknown>) => TestAgent;
}>("@oh-my-pi/pi-agent-core");
const { createMockModel } = await runtime.importModule<{
  createMockModel(options: Record<string, unknown>): {
    model: unknown;
    stream: unknown;
    calls: Array<{ context: MockContext }>;
  };
}>("@oh-my-pi/pi-ai/providers/mock");
const { SessionManager } = await runtime.importModule<{
  SessionManager: { inMemory(cwd: string): SessionManagerLike };
}>("session/session-manager.ts");
const { Type } = await runtime.importModule<{
  Type: { Object(value: Record<string, unknown>): unknown; String(): unknown };
}>("@oh-my-pi/omptype/typebox");
const temporary: string[] = [];
const coordinators: WorkspaceCoordinator[] = [];
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) {
    coordinator.dispose();
  }
  while (temporary.length) {
    await fs.rm(temporary.pop()!, { recursive: true, force: true });
  }
});

async function fixture(
  options: { fail?: boolean; fatal?: boolean; gateBusy?: boolean; mixed?: boolean } = {},
) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "omp-nav-host-")));
  temporary.push(root);
  const a = join(root, "A");
  const b = join(root, "B");
  await fs.mkdir(a);
  await fs.mkdir(b);
  const manager = SessionManager.inMemory(a);
  let coordinator: WorkspaceCoordinator;
  let writes = 0;
  let priorGateCalls = 0;
  const order: string[] = [];
  const mock = createMockModel({
    handler: (_context: MockContext) => {
      order.push("model");
      if (order.filter((item) => item === "model").length === 1) {
        return {
          content: [
            { type: "toolCall", name: "session_move", arguments: { dir: b } },
            ...(options.mixed ? [{ type: "toolCall", name: "write", arguments: {} }] : []),
          ],
        };
      }
      return { content: ["done"] };
    },
  });
  const agent = new Agent({
    initialState: {
      model: mock.model,
      systemPrompt: ["A-context"],
      tools: [
        {
          name: "session_move",
          label: "Move",
          description: "Move",
          parameters: Type.Object({ dir: Type.String() }),
          execute: async (id: string, params: { dir: string }) => {
            coordinator.assertDirectToolCall(id);
            order.push("tool");
            const result = await coordinator.request({ action: "move", dir: params.dir });
            expect(manager.getCwd()).toBe(a);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
          },
        },
        {
          name: "write",
          label: "Write",
          description: "Write",
          parameters: Type.Object({}),
          execute: async () => {
            writes++;
            return { content: [{ type: "text", text: "written" }] };
          },
        },
      ],
      messages: [],
    },
    streamFn: mock.stream,
    beforeToolCall: () => {
      priorGateCalls++;
      return undefined;
    },
  });
  const session = {
    agent,
    sessionManager: manager,
    sessionId: manager.getSessionId(),
    isCompacting: false,
    isStreaming: true,
    settings: { get: () => undefined, flush: async () => {}, reloadForCwd: async () => {} },
    refreshSkillsAndCommands: async () => {},
    refreshBaseSystemPrompt: async () => {},
    addDisposer: () => {},
  } as unknown as SessionLike;
  const navigation = new WorkspaceNavigation(runtime, {
    initialCwd: a,
    getCwd: () => manager.getCwd(),
    getWorkspaceRoots: () => [b],
    getLiveAgentCwds: () => [],
    getSettings: () => session.settings,
  });
  await navigation.validateMove(a);
  coordinator = new WorkspaceCoordinator({
    session,
    navigation,
    relocate: async (cwd) => {
      order.push("apply-start");
      await Promise.resolve();
      if (options.fatal) {
        throw new WorkspaceRollbackError("Restore failed; stop before another model request.");
      }
      if (options.fail) {
        throw new Error("prepare failed; original state intact");
      }
      manager.setCwdWithoutRelocation(cwd);
      agent.setSystemPrompt(["B-context"]);
      order.push("apply-end");
    },
    withGate: async (operation) => {
      if (options.gateBusy) {
        throw new Error("BTW busy");
      }
      return await operation();
    },
  });
  coordinators.push(coordinator);
  return {
    a,
    b,
    manager,
    session,
    coordinator,
    mock,
    agent,
    order,
    writes: () => writes,
    priorGateCalls: () => priorGateCalls,
  };
}

describe("real omp agent loop with fake provider", () => {
  test("applies after tool completion and before second model call, publishing actual result", async () => {
    const f = await fixture();
    const id = f.manager.getSessionId();
    await f.agent.prompt("move");
    expect(f.order).toEqual(["model", "tool", "apply-start", "apply-end", "model"]);
    expect(f.manager.getCwd()).toBe(f.b);
    expect(f.manager.getSessionId()).toBe(id);
    expect(f.mock.calls[1].context.systemPrompt).toEqual(["B-context"]);
    expect(JSON.stringify(f.mock.calls[1].context.messages)).toContain(
      '\\"status\\":\\"applied\\"',
    );
    expect(f.priorGateCalls()).toBe(1);
  });

  test("each model call carries the operation result exactly once, also in a later run (CR-1)", async () => {
    const f = await fixture();
    await f.agent.prompt("move");
    await f.agent.prompt("after");
    const notices = (call: { context: MockContext }) =>
      JSON.stringify(call.context.messages).split("Workspace operation result").length - 1;
    expect(f.mock.calls.map(notices)).toEqual([0, 1, 1]);
    expect(
      JSON.stringify(f.agent.state.messages).split("Workspace operation result").length - 1,
    ).toBe(1);
  });

  test("a second request during validation is refused instead of replacing the first (CR-8)", async () => {
    const f = await fixture();
    const [first, second] = await Promise.allSettled([
      f.coordinator.request({ action: "move", dir: f.b }),
      f.coordinator.request({ action: "move", dir: f.b }),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect(String((second as PromiseRejectedResult).reason)).toContain("pending");
    await f.coordinator.applyPending();
    expect(f.manager.getCwd()).toBe(f.b);
  });

  test("rejects the entire move + write batch before either tool has effects", async () => {
    const f = await fixture({ mixed: true });
    await f.agent.prompt("mixed");
    expect(f.manager.getCwd()).toBe(f.a);
    expect(f.writes()).toBe(0);
    expect(f.order).toEqual(["model", "model"]);
    expect(f.priorGateCalls()).toBe(0);
  });

  test("failed preparation and BTW denial are model-visible with unchanged cwd", async () => {
    for (const options of [{ fail: true }, { gateBusy: true }]) {
      const f = await fixture(options);
      await f.agent.prompt("move");
      expect(f.manager.getCwd()).toBe(f.a);
      expect(JSON.stringify(f.mock.calls[1].context.messages)).toContain(
        '\\"status\\":\\"failed\\"',
      );
    }
  });

  test("aborted queued request is cancelled and disposed hooks no longer apply it", async () => {
    const f = await fixture();
    const abort = new AbortController();
    await f.coordinator.request({ action: "move", dir: f.b }, abort.signal);
    abort.abort();
    await f.coordinator.applyPending();
    expect(f.manager.getCwd()).toBe(f.a);
    expect(JSON.stringify(f.agent.state.messages)).toContain('\\"status\\":\\"cancelled\\"');
    await f.coordinator.request({ action: "move", dir: f.b });
    f.coordinator.dispose();
    await f.agent.prompt("after dispose");
    expect(f.manager.getCwd()).toBe(f.a);
  });

  test("a nested eval-style tool id has no direct solo-batch admission", async () => {
    const f = await fixture();
    expect(() => f.coordinator.assertDirectToolCall("js-session_move-nested")).toThrow(
      "Nested navigation",
    );
    expect(f.manager.getCwd()).toBe(f.a);
  });

  test("an incomplete rollback persists its failure and stops before another model request", async () => {
    const f = await fixture({ fatal: true });
    await f.agent.prompt("move");
    expect(f.mock.calls).toHaveLength(1);
    expect(f.order).toEqual(["model", "tool", "apply-start"]);
    expect(JSON.stringify(f.agent.state.messages)).toContain("Restore failed");
  });
});

test("relocation rollback restores storage cwd and context after preparation fails", async () => {
  const f = await fixture();
  let calls = 0;
  const owner = {
    session: f.session,
    sessionManager: f.manager,
    applyCwdChange: async (cwd: string) => {
      calls++;
      return cwd === f.a;
    },
    updateEditorBorderColor: () => {},
    reloadTodos: async () => {},
    ui: { requestRender: () => {} },
  };
  f.session.moveSession = async (cwd) => {
    f.manager.setCwdWithoutRelocation(cwd);
  };
  const bridge = new WorkspaceBridge(runtime);
  bridge.captureOwner(owner as unknown as Parameters<typeof bridge.captureOwner>[0]);
  f.session.settleMemoryBackend = async () => {};
  await expect(bridge.relocate(f.session, f.b)).rejects.toThrow("restored");
  expect(f.manager.getCwd()).toBe(f.a);
  expect(calls).toBe(2);
});

test("restoring the previous project tolerates its broken MCP server but not lost memory (CR-5)", async () => {
  const f = await fixture();
  const owner = {
    session: f.session,
    sessionManager: f.manager,
    applyCwdChange: async (cwd: string) => cwd === f.a,
    updateEditorBorderColor: () => {},
    reloadTodos: async () => {},
    ui: { requestRender: () => {} },
  };
  f.session.moveSession = async (cwd) => {
    f.manager.setCwdWithoutRelocation(cwd);
  };
  f.session.settleMemoryBackend = async () => {};
  const { Settings } = await runtime.importModule<{
    Settings: { isolated(values: Record<string, unknown>): SessionLike["settings"] };
  }>("config/settings.ts");
  const { MCPManager } = await runtime.importModule<{
    MCPManager: new (
      cwd: string,
      cache: null,
      loader: () => Promise<unknown>,
    ) => { disconnectAll(): Promise<void> };
  }>("mcp/manager.ts");
  const broken = new MCPManager(f.a, null, async () => ({
    configs: { broken: { type: "stdio", command: join(f.a, "missing-binary"), timeout: 500 } },
    exaApiKeys: [],
    sources: {
      broken: { provider: "fixture", providerName: "Fixture", path: f.a, level: "project" },
    },
  }));
  const settings = Settings.isolated({ "mcp.startupTimeoutMs": 0 });
  const nativeScope = {
    settings,
    getSessionSpawns: () => "*",
    mcpManager: broken,
    enableMCP: true,
  };
  let published = 0;
  Object.assign(f.session, {
    settings,
    getToolByName: (name: string) => (name === "read" ? { session: nativeScope } : undefined),
    getActiveToolNames: () => ["read"],
    refreshMCPTools: async () => {
      published++;
    },
  });
  try {
    const bridge = new WorkspaceBridge(runtime);
    bridge.captureOwner(owner as unknown as Parameters<typeof bridge.captureOwner>[0]);
    const failure = await bridge.relocate(f.session, f.b).catch((error) => error);
    expect(failure).not.toBeInstanceOf(WorkspaceRollbackError);
    expect(String(failure)).toContain(`restored to ${f.a} (partially: MCP startup failed`);
    expect(published).toBe(1);
    expect(f.manager.getCwd()).toBe(f.a);
    // Mandatory memory that cannot come back stops the run instead.
    bridge.setMemoryBridge({
      ensure: async (_session, cwd) => {
        if (cwd === f.a) {
          throw new Error("memory A is down");
        }
      },
    });
    await expect(bridge.relocate(f.session, f.b)).rejects.toBeInstanceOf(WorkspaceRollbackError);
  } finally {
    await broken.disconnectAll();
  }
});
