import { randomUUID } from "node:crypto";

import { type WorkspaceNavigation } from "../navigation";
import {
  type ModelCallContext,
  type SessionLike,
  type ToolCallContext,
  type WorkspaceRequest,
  type WorkspaceResult,
} from "../types";
import { WorkspaceRollbackError } from "./grants";

export const NAVIGATION_TOOLS = new Set([
  "session_move",
  "worktree_create",
  "worktree_enter",
  "worktree_exit",
  "worktree_remove",
  "workspace_grant",
]);

interface CoordinatorDependencies {
  navigation: WorkspaceNavigation;
  /** Resolves to a warning when the move applied with a degraded resource (project MCP). */
  relocate(cwd: string): Promise<string | undefined>;
  session: SessionLike;
  withGate<T>(operation: () => Promise<T>): Promise<T>;
}

/** Owns one pending request; the model hook is the only application boundary during a run. */
export class WorkspaceCoordinator {
  readonly navigation: WorkspaceNavigation;
  readonly session: SessionLike;
  readonly sessionId: string;
  #dependencies: CoordinatorDependencies;
  #pending?: {
    request: WorkspaceRequest;
    result: WorkspaceResult;
    sessionId: string;
    cwd: string;
    signal?: AbortSignal;
    detachAbort?: () => void;
  };
  #applying = false;
  #validating = false;
  #disposed = false;
  #removers: Array<() => void> = [];
  #admittedToolCalls = new Set<string>();

  constructor(dependencies: CoordinatorDependencies) {
    this.#dependencies = dependencies;
    this.session = dependencies.session;
    this.sessionId = this.session.sessionManager.getSessionId();
    this.navigation = dependencies.navigation;
    const originalGate = this.session.agent.beforeToolCall;
    const wrappedGate = async (context: ToolCallContext, signal?: AbortSignal) => {
      const calls = context.assistantMessage.content.filter((block) => block.type === "toolCall");
      if (calls.some((call) => NAVIGATION_TOOLS.has(call.name ?? "")) && calls.length !== 1) {
        return {
          block: true,
          reason:
            "Navigation requires a solo tool batch. No calls in this batch will execute; retry the navigation alone.",
        };
      }
      const result = await originalGate?.(context, signal);
      if (!result?.block && NAVIGATION_TOOLS.has(context.toolCall.name)) {
        this.#admittedToolCalls.add(context.toolCall.id);
      }
      return result;
    };
    this.session.agent.beforeToolCall = wrappedGate;
    this.#removers.push(() => {
      if (this.session.agent.beforeToolCall === wrappedGate) {
        this.session.agent.beforeToolCall = originalGate;
      }
    });
    this.#removers.push(
      this.session.agent.addBeforeModelCallHook(async (signal, context) => {
        this.#admittedToolCalls.clear();
        await this.applyPending(signal, context);
      }),
    );
    this.session.addDisposer(() => this.dispose());
  }

  assertDirectToolCall(id: string): void {
    if (!this.#admittedToolCalls.delete(id)) {
      throw new Error(
        "Nested navigation is not supported; call the navigation tool directly in a solo batch.",
      );
    }
  }

  async request(request: WorkspaceRequest, signal?: AbortSignal): Promise<WorkspaceResult> {
    if (this.#disposed) {
      throw new Error("The navigation session is closed.");
    }
    if (this.#pending || this.#applying || this.#validating) {
      throw new Error("Another workspace operation is pending.");
    }
    if (this.session.isCompacting) {
      throw new Error("Wait for context maintenance before changing workspace.");
    }
    signal?.throwIfAborted();
    const sourceCwd = this.session.sessionManager.getCwd();
    const sourceId = this.session.sessionManager.getSessionId();
    // Hold the single slot across validation: a concurrent request must not pass the check too.
    this.#validating = true;
    let target: string | undefined;
    try {
      target = await this.#validateRequest(request);
    } finally {
      this.#validating = false;
    }
    signal?.throwIfAborted();
    if (
      sourceCwd !== this.session.sessionManager.getCwd() ||
      sourceId !== this.session.sessionManager.getSessionId()
    ) {
      throw new Error("The session changed while validating the workspace request.");
    }
    const result: WorkspaceResult = {
      id: randomUUID(),
      status: "queued",
      action: request.action,
      target,
    };
    const abort = () => {
      void this.cancel("The tool call was aborted.").catch((error) =>
        process.stderr.write(`omp-nav cancellation: ${String(error)}\n`),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    this.#pending = {
      request: { ...request },
      result,
      signal,
      sessionId: sourceId,
      cwd: sourceCwd,
      detachAbort: () => signal?.removeEventListener("abort", abort),
    };
    return result;
  }

  async #validateRequest(request: WorkspaceRequest): Promise<string | undefined> {
    switch (request.action) {
      case "move":
        return await this.navigation.validateMove(request.dir);
      case "enter":
        return await this.navigation.validateEnter(request.path);
      case "exit":
        return await this.navigation.validateExit();
      case "create":
        if (!request.branch.trim()) {
          throw new Error("A non-empty worktree branch is required.");
        }
        return undefined;
      case "remove":
        if (!request.path.trim()) {
          throw new Error("A worktree path is required.");
        }
        return undefined;
      default:
        throw new Error("Unknown workspace operation.");
    }
  }

  /** `context` is the agent loop's live context when called from the model-call hook. */
  async applyPending(
    signal?: AbortSignal,
    context?: ModelCallContext,
  ): Promise<WorkspaceResult | undefined> {
    const pending = this.#pending;
    if (!pending) {
      return undefined;
    }
    if (
      signal?.aborted ||
      pending.signal?.aborted ||
      this.session.sessionManager.getSessionId() !== pending.sessionId ||
      this.session.sessionManager.getCwd() !== pending.cwd
    ) {
      await this.cancel("The session changed or the request was aborted.", context);
      return undefined;
    }
    this.#pending = undefined;
    pending.detachAbort?.();
    this.#applying = true;
    const result: WorkspaceResult = { ...pending.result, status: "applied" };
    let fatal: WorkspaceRollbackError | undefined;
    try {
      await this.#dependencies.withGate(async () => {
        signal?.throwIfAborted();
        if (
          pending.sessionId !== this.session.sessionManager.getSessionId() ||
          pending.cwd !== this.session.sessionManager.getCwd()
        ) {
          throw new Error("The session changed before applying the workspace operation.");
        }
        if (this.session.isCompacting) {
          throw new Error("Workspace operation is blocked by context maintenance.");
        }
        switch (pending.request.action) {
          case "move":
            result.target = await this.navigation.validateMove(pending.request.dir);
            result.warning = await this.#dependencies.relocate(result.target);
            break;
          case "enter":
            result.target = await this.navigation.validateEnter(pending.request.path);
            result.warning = await this.#dependencies.relocate(result.target);
            break;
          case "exit":
            result.target = await this.navigation.validateExit();
            result.warning = await this.#dependencies.relocate(result.target);
            break;
          case "create": {
            const created = await this.navigation.createWorktree(pending.request);
            result.result = created;
            result.target = created.path;
            break;
          }
          case "remove":
            result.result = await this.navigation.removeWorktree(pending.request.path);
            result.target = pending.request.path;
            break;
        }
      });
    } catch (error) {
      result.status = "failed";
      result.error = error instanceof Error ? error.message : String(error);
      if (error instanceof WorkspaceRollbackError) {
        fatal = error;
      }
    } finally {
      this.#applying = false;
    }
    result.cwd = this.session.sessionManager.getCwd();
    if (pending.sessionId !== this.session.sessionManager.getSessionId()) {
      return result;
    }
    await this.#notice(result, context);
    if (fatal) {
      throw fatal;
    }
    return result;
  }

  async cancel(reason: string, context?: ModelCallContext): Promise<void> {
    const pending = this.#pending;
    if (!pending) {
      return;
    }
    this.#pending = undefined;
    pending.detachAbort?.();
    if (this.session.sessionManager.getSessionId() === pending.sessionId) {
      await this.#notice(
        {
          ...pending.result,
          status: "cancelled",
          error: reason,
          cwd: this.session.sessionManager.getCwd(),
        },
        context,
      );
    }
  }

  /**
   * The loop sends a copy of the agent state, so a run in progress sees the result only through
   * its live context; state and JSONL carry it into later runs and compaction. Exactly once each.
   */
  async #notice(result: WorkspaceResult, context?: ModelCallContext): Promise<void> {
    const message = {
      role: "developer" as const,
      content: [
        { type: "text" as const, text: `Workspace operation result: ${JSON.stringify(result)}` },
      ],
      attribution: "agent" as const,
      timestamp: Date.now(),
    };
    context?.messages.push(message);
    this.session.agent.appendMessage(message);
    this.session.sessionManager.appendMessage(message);
    await this.session.sessionManager.flush();
  }

  dispose(): void {
    void this.cancel("The session closed.").catch((error) =>
      process.stderr.write(`omp-nav cancellation: ${String(error)}\n`),
    );
    this.#disposed = true;
    for (const remove of this.#removers.splice(0)) {
      remove();
    }
  }

  get disposed(): boolean {
    return this.#disposed;
  }
}
