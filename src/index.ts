import { installHostBridge, NAVIGATION_TOOLS, type WorkspaceBridge } from "./host";
import { installMemoryBridge } from "./memory";
import { createRuntime } from "./runtime";
import { installTaskTool } from "./task";
import { type ExtensionApiLike, type ExtensionContextLike, type WorkspaceRequest } from "./types";

interface SchemaBuilder {
  Array(items: unknown, options?: { minItems?: number }): unknown;
  Object(
    properties: Record<string, unknown>,
    options?: { additionalProperties?: boolean },
  ): unknown;
  Optional(schema: unknown): unknown;
  String(options?: { description?: string; minLength?: number }): unknown;
}

export default async function navigationExtension(pi: ExtensionApiLike): Promise<void> {
  const runtime = createRuntime(pi.pi);
  const bridge = await installHostBridge(runtime);
  const memory = await installMemoryBridge(runtime);
  bridge.setMemoryBridge(memory);
  await installTaskTool(pi, runtime, bridge);
  const Type = pi.typebox.Type as SchemaBuilder;
  const path = (description: string) => Type.String({ description, minLength: 1 });
  const tools: Array<{
    name: string;
    description: string;
    properties: Record<string, unknown>;
    request(params: Record<string, unknown>): WorkspaceRequest;
  }> = [
    {
      name: "worktree_create",
      description:
        "Queue a clean worktree from ref or HEAD, preserving source changes. Optional path is exact and primary-relative. Run alone; this does not enter the worktree.",
      properties: {
        branch: path("New branch name."),
        path: Type.Optional(
          path("Exact destination path; relative paths start at primary checkout."),
        ),
        ref: Type.Optional(path("Starting Git ref; defaults to current HEAD.")),
      },
      request: (params) => ({
        action: "create",
        branch: params.branch as string,
        path: params.path as string | undefined,
        ref: params.ref as string | undefined,
      }),
    },
    {
      name: "worktree_enter",
      description: "Queue entering a registered worktree of an allowed project. Run alone.",
      properties: { path: path("Registered worktree directory.") },
      request: (params) => ({ action: "enter", path: params.path as string }),
    },
    {
      name: "worktree_exit",
      description:
        "Queue returning to the primary checkout while retaining the worktree. Run alone.",
      properties: {},
      request: () => ({ action: "exit" }),
    },
    {
      name: "worktree_remove",
      description:
        "Queue removal of an inactive clean registered worktree while retaining its branch. Run alone; force removal is unavailable.",
      properties: { path: path("Worktree to remove.") },
      request: (params) => ({ action: "remove", path: params.path as string }),
    },
  ];
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: Type.Object(tool.properties, { additionalProperties: false }),
      approval: "write",
      loadMode: "essential",
      execute: async (id, params, signal, _update, ctx) => {
        if (ctx.agent.kind !== "main") {
          throw new Error("Workspace navigation is available only to the main session.");
        }
        signal?.throwIfAborted();
        const coordinator = bridge.coordinator(ctx);
        coordinator.assertDirectToolCall(id);
        const result = await coordinator.request(tool.request(params), signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });
  }
  registerSessionMoveTool(pi, bridge, Type);
  pi.registerTool({
    name: "worktree_list",
    label: "worktree_list",
    description:
      "List registered worktrees and their safety state for the current allowed project.",
    parameters: Type.Object({}, { additionalProperties: false }),
    approval: "read",
    loadMode: "essential",
    execute: async (_id, _params, _signal, _update, ctx) => {
      const result = await bridge.coordinator(ctx).navigation.listWorktrees();
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
  registerWorkspaceGrantTool(pi, bridge, Type);
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind === "main") {
      await bridge.settleGrants(ctx);
      await memory.ensure(bridge.currentSession(ctx));
    } else {
      const api = pi as ExtensionApiLike & {
        getActiveTools(): string[];
        setActiveTools(names: string[]): Promise<void>;
      };
      await api.setActiveTools(
        api
          .getActiveTools()
          .filter((name) => !NAVIGATION_TOOLS.has(name) && name !== "worktree_list"),
      );
    }
  });
  pi.on("session_before_switch", async (_event, ctx) => {
    if (ctx.agent.kind === "main") {
      await bridge.coordinator(ctx).cancel("The session is switching.");
    }
  });
  pi.on("session_switch", async (event, ctx) => {
    if (ctx.agent.kind === "main") {
      await bridge.settleGrants(ctx, event.reason as "new" | "resume" | "fork");
      await memory.ensure(bridge.currentSession(ctx));
      await bridge.notifyAfterRelocation(bridge.currentSession(ctx));
    }
  });
  // /branch, a fork from an entry and a promoted /btw all copy a path into a new session.
  pi.on("session_branch", async (_event, ctx) => {
    if (ctx.agent.kind === "main") {
      await bridge.settleGrants(ctx, "fork");
    }
  });
  // The user's own /add-dir and /remove-dir decide navigation roots; the host runs them right after.
  pi.on("input", async (event, ctx) => await bridge.onUserInput(ctx, event));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.agent.kind === "main") {
      bridge.coordinator(ctx).dispose();
    }
  });
  registerCommands(pi, bridge);
}

/** Command output; a no-op in print/json modes, as for every extension command. */
function commandUi(ctx: ExtensionContextLike) {
  return ctx.ui as { notify(message: string, type?: "info" | "warning" | "error"): void };
}

export function registerCommands(pi: ExtensionApiLike, bridge: WorkspaceBridge): void {
  pi.registerCommand("nav-move", {
    description: "Move this idle main session into an allowed project directory.",
    handler: async (args, ctx) => {
      const isIdle = ctx.isIdle as () => boolean;
      if (!isIdle()) {
        throw new Error("Wait for the current response to finish before /nav-move.");
      }
      const coordinator = bridge.coordinator(ctx);
      await coordinator.request({ action: "move", dir: args });
      const result = await coordinator.applyPending();
      if (result?.status === "failed") {
        throw new Error(result.error);
      }
      if (result?.warning) {
        commandUi(ctx).notify(result.warning, "warning");
      }
    },
  });
  pi.registerCommand("nav-roots", {
    description: "List workspace roots, or revoke a granted one: /nav-roots revoke <dir>.",
    handler: async (args, ctx) => {
      const ui = commandUi(ctx);
      const revoke = /^revoke\s+(.+)$/.exec(args.trim());
      if (!args.trim()) {
        const roots = await bridge.listRoots(ctx);
        ui.notify(
          roots
            .map(({ root, source, missing }) => `${source}: ${root}${missing ? " (missing)" : ""}`)
            .join("\n"),
          "info",
        );
        return;
      }
      if (!revoke) {
        throw new Error("Usage: /nav-roots [revoke <dir>]");
      }
      if (!(ctx.isIdle as () => boolean)()) {
        throw new Error("Wait for the current response to finish before /nav-roots revoke.");
      }
      const { revoked, coveredBy } = await bridge.revokeRoot(ctx, revoke[1]);
      ui.notify(
        `Revoked ${revoked.join(", ")}.${coveredBy ? ` ${revoke[1]} stays reachable through ${coveredBy}.` : ""}`,
        "info",
      );
    },
  });
}

export function registerWorkspaceGrantTool(
  pi: ExtensionApiLike,
  bridge: WorkspaceBridge,
  type: SchemaBuilder,
): void {
  pi.registerTool({
    name: "workspace_grant",
    label: "workspace_grant",
    description:
      "Accept existing project directories into the workspace roots for session_move and task.cwd after explicit user approval. A worktree path resolves to its primary checkout. Pass all needed dirs in one call for a single approval.",
    parameters: type.Object(
      {
        dirs: type.Array(
          type.String({
            description:
              "Existing directory to accept; a worktree resolves to its primary checkout.",
            minLength: 1,
          }),
          { minItems: 1 },
        ),
      },
      { additionalProperties: false },
    ),
    approval: {
      tier: "write",
      policy: "prompt",
      reason: "Expands workspace roots that session_move and task.cwd may target",
    },
    // The human approves the roots that are actually granted, not only the paths the model sent.
    formatApprovalDetails: (args) => {
      if (args && typeof args === "object" && "dirs" in args && Array.isArray(args.dirs)) {
        return args.dirs.map((dir) => bridge.describeGrant(dir, true));
      }
      return undefined;
    },
    loadMode: "essential",
    execute: async (id, params, signal, _update, ctx) => {
      if (ctx.agent.kind !== "main") {
        throw new Error("Workspace grants are available only to the main session.");
      }
      signal?.throwIfAborted();
      bridge.coordinator(ctx).assertDirectToolCall(id);
      const dirs = params.dirs as string[];
      // This tool always shows a dialog, so every dir must carry the root it showed. A path that
      // did not exist then showed none, and whatever it resolves to now was never approved.
      const shown = new Map([...new Set(dirs)].map((dir) => [dir, bridge.takeApprovedRoot(dir)]));
      const unbound = dirs.find((dir) => shown.get(dir) === undefined);
      if (unbound !== undefined) {
        throw new Error(
          `${unbound} showed no grant root in the approval dialog; nothing was granted. Retry once the directory exists.`,
        );
      }
      const result = await bridge.grantWorkspaceDirs(
        ctx,
        dirs,
        dirs.map((dir) => shown.get(dir)),
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}

export function registerSessionMoveTool(
  pi: ExtensionApiLike,
  bridge: WorkspaceBridge,
  type: SchemaBuilder,
): void {
  pi.registerTool({
    name: "session_move",
    label: "session_move",
    description:
      "Queue moving this session into an allowed project directory; run alone. Context and memory change before the next model request.",
    parameters: type.Object(
      {
        dir: type.String({
          description: "Existing destination directory, relative to current cwd or absolute.",
          minLength: 1,
        }),
      },
      { additionalProperties: false },
    ),
    approval: (args) => bridge.sessionMoveApproval(args),
    formatApprovalDetails: (args) => {
      const dir = (args as { dir?: unknown } | null | undefined)?.dir;
      return typeof dir === "string" ? [bridge.describeGrant(dir)] : undefined;
    },
    loadMode: "essential",
    execute: async (id, params, signal, _update, ctx) => {
      if (ctx.agent.kind !== "main") {
        throw new Error("Workspace navigation is available only to the main session.");
      }
      signal?.throwIfAborted();
      const coordinator = bridge.coordinator(ctx);
      coordinator.assertDirectToolCall(id);
      const dir = params.dir as string;
      // Only a root the approval dialog showed is granted; a target that changed since approval
      // gets no grant and fails validation with the usual workspace_grant hint.
      const approved = bridge.takeApprovedRoot(dir);
      if (approved !== undefined && bridge.moveNeedsGrant(dir)) {
        await bridge.grantWorkspaceDirs(ctx, [dir], [approved]);
      }
      const result = await coordinator.request({ action: "move", dir }, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
