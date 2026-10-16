import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import {
  expandPath,
  pathIsWithin,
  resolveProjectIdentity,
  WorkspaceNavigation,
} from "./navigation";
import { installInstructionScope, readSetting, SUPPORTED_OMP_VERSIONS } from "./runtime";
import { findNativeToolSession, mcpStartupWait } from "./task";
import {
  type ExtensionContextLike,
  type HostNamespace,
  type InteractiveOwner,
  type RuntimeModules,
  type SessionLike,
  type ToolCallContext,
  type WorkspaceRequest,
  type WorkspaceResult,
} from "./types";

export const NAVIGATION_TOOLS = new Set([
  "session_move",
  "worktree_create",
  "worktree_enter",
  "worktree_exit",
  "worktree_remove",
  "workspace_grant",
]);

interface MemoryBridgeLike {
  ensure(session: SessionLike, sourceCwd?: string): Promise<unknown>;
}

interface CoordinatorDependencies {
  session: SessionLike;
  navigation: WorkspaceNavigation;
  relocate(cwd: string): Promise<void>;
  withGate<T>(operation: () => Promise<T>): Promise<T>;
  beforeModelCall?(): Promise<void>;
}

interface ScopedMcp {
  cwd: string;
  disconnectAll(): Promise<void>;
  discoverAndConnect(
    options: Record<string, unknown>,
  ): Promise<{ tools: unknown[]; errors: Map<string, string> }>;
  waitForStartup(
    timeout: number,
  ): Promise<{ failed: Array<{ name: string; error: string }>; pending: string[] }>;
  getTools(): unknown[];
  setNotificationsEnabled(enabled: boolean): void;
}

interface RescopableSession extends SessionLike {
  getToolByName(name: string): unknown;
  getActiveToolNames(): string[];
  refreshMCPTools(tools: unknown[]): Promise<void>;
}

export async function rescopeProjectMcp(
  runtime: RuntimeModules,
  session: SessionLike,
  cwd: string,
): Promise<void> {
  const native = findNativeToolSession(session);
  if (native.enableMCP === false) return;
  const manager = native.mcpManager as ScopedMcp | undefined;
  if (
    !manager ||
    typeof manager.cwd !== "string" ||
    typeof manager.discoverAndConnect !== "function"
  ) {
    throw new Error("This omp session has no compatible owned MCP manager for project relocation.");
  }
  const active = session as RescopableSession;
  const config = await runtime.importModule<{
    shouldFilterBrowserMCPForPrelude(options: Record<string, unknown>): boolean;
  }>("mcp/config.ts");
  const capabilities = await runtime.importModule<{ reset(): void }>("capability/index.ts");
  capabilities.reset();
  await manager.disconnectAll();
  // The installed SDK's prompt/notification closures retain this same manager.
  manager.cwd = cwd;
  const [notifications, projectConfig, startupTimeout, browserEnabled] = await Promise.all([
    readSetting(runtime, session.settings, "mcp.notifications"),
    readSetting(runtime, session.settings, "mcp.enableProjectConfig"),
    readSetting(runtime, session.settings, "mcp.startupTimeoutMs"),
    readSetting(runtime, session.settings, "browser.enabled"),
  ]);
  manager.setNotificationsEnabled(notifications === true);
  const result = await manager.discoverAndConnect({
    enableProjectConfig: projectConfig,
    startupTimeoutMs: startupTimeout,
    filterExa: true,
    filterBrowser: config.shouldFilterBrowserMCPForPrelude({
      restrictToolNames: false,
      browserEnabled: browserEnabled === true,
      evalRegistered: !!active.getToolByName("eval"),
      evalActive: active.getActiveToolNames().includes("eval"),
    }),
    extensionRoots:
      typeof native.effectiveExtensionRoots === "function"
        ? (native.effectiveExtensionRoots as () => unknown)()
        : undefined,
  });
  const startup = await manager.waitForStartup(mcpStartupWait.ms);
  if (result.errors.size || startup.failed.length || startup.pending.length) {
    throw new Error(
      `MCP startup failed for ${cwd}: ${JSON.stringify({ errors: [...result.errors], ...startup })}`,
    );
  }
  await active.refreshMCPTools(manager.getTools());
}

type GrantManager = SessionLike["sessionManager"] & {
  getBranch(): Array<{ type: string; customType?: string; data?: unknown }>;
  appendCustomEntry(customType: string, data: unknown): unknown;
  addWorkspaceDirectory(directory: string): Promise<string | null>;
  removeWorkspaceDirectory(directory: string): Promise<string | null>;
  setAdditionalDirectories(directories: string[]): Promise<void>;
};

const GRANTS_ENTRY = "omp-agent-nav.workspace";

export class WorkspaceRollbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRollbackError";
  }
}

/** Native moveTo omits the current root; acceptance must survive that presentation change. */
export class WorkspaceGrantState {
  initialCwd: string;
  #manager: GrantManager;
  #sessionId: string;
  #grants = new Set<string>();
  #transition = new AsyncLocalStorage<boolean>();
  #setDirectories: GrantManager["setAdditionalDirectories"];

  constructor(manager: GrantManager) {
    this.#manager = manager;
    this.#sessionId = manager.getSessionId();
    this.initialCwd = manager.getCwd();
    this.#setDirectories = manager.setAdditionalDirectories.bind(manager);
    this.#restore();
    const add = manager.addWorkspaceDirectory.bind(manager);
    const remove = manager.removeWorkspaceDirectory.bind(manager);
    manager.addWorkspaceDirectory = async (directory) => {
      this.#checkSession();
      const added = await add(directory);
      if (!this.#transition.getStore()) {
        this.#grants.add(this.#canonical(added ?? directory));
        await this.#persist();
      }
      return added;
    };
    manager.removeWorkspaceDirectory = async (directory) => {
      this.#checkSession();
      const canonical = this.#canonical(directory);
      const removed = await remove(directory);
      if (!this.#transition.getStore()) {
        const accepted = this.#grants.delete(canonical);
        await this.#persist();
        return removed ?? (accepted ? canonical : null);
      }
      return removed;
    };
    manager.setAdditionalDirectories = async (directories) => {
      this.#checkSession();
      await this.#setDirectories(directories);
      if (!this.#transition.getStore()) {
        this.#grants = new Set(directories.map((directory) => this.#canonical(directory)));
        await this.#persist();
      }
    };
  }

  #canonical(directory: string): string {
    const absolute = resolve(this.#manager.getCwd(), directory);
    try {
      return realpathSync(absolute);
    } catch {
      return absolute;
    }
  }

  #checkSession(): void {
    if (this.#sessionId === this.#manager.getSessionId()) return;
    this.#sessionId = this.#manager.getSessionId();
    this.#restore();
  }

  #restore(): void {
    const saved = this.#manager
      .getBranch()
      .findLast((entry) => entry.type === "custom" && entry.customType === GRANTS_ENTRY)?.data as
      | { initialCwd?: unknown; grants?: unknown }
      | undefined;
    if (
      typeof saved?.initialCwd === "string" &&
      Array.isArray(saved.grants) &&
      saved.grants.every((item) => typeof item === "string")
    ) {
      this.initialCwd = saved.initialCwd;
      this.#grants = new Set(saved.grants as string[]);
    } else {
      this.initialCwd = this.#canonical(this.#manager.getCwd());
      this.#grants = new Set(
        this.#manager.getAdditionalDirectories().map((directory) => this.#canonical(directory)),
      );
    }
  }

  async #persist(): Promise<void> {
    this.#manager.appendCustomEntry(GRANTS_ENTRY, {
      initialCwd: this.initialCwd,
      grants: [...this.#grants],
    });
    await this.#manager.flush();
  }

  roots(): string[] {
    this.#checkSession();
    return [...this.#grants];
  }

  async synchronize(): Promise<void> {
    await this.#setDirectories([...this.#grants]);
    await this.#persist();
  }

  async withTransition<T>(operation: () => Promise<T>): Promise<T> {
    this.#checkSession();
    return await this.#transition.run(true, operation);
  }
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
  #disposed = false;
  #notices: Array<{
    role: "developer";
    content: Array<{ type: "text"; text: string }>;
    timestamp: number;
    attribution: "agent";
  }> = [];
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
      if (!result?.block && NAVIGATION_TOOLS.has(context.toolCall.name))
        this.#admittedToolCalls.add(context.toolCall.id);
      return result;
    };
    this.session.agent.beforeToolCall = wrappedGate;
    this.#removers.push(() => {
      if (this.session.agent.beforeToolCall === wrappedGate)
        this.session.agent.beforeToolCall = originalGate;
    });
    this.#removers.push(
      this.session.agent.addBeforeModelCallHook(async (signal) => {
        this.#admittedToolCalls.clear();
        await this.applyPending(signal);
        await this.#dependencies.beforeModelCall?.();
      }),
    );
    this.#removers.push(
      this.session.agent.addBeforeModelCall(async (context) => {
        for (const notice of this.#notices) {
          const text = notice.content[0].text;
          if (!context.messages.some((message) => JSON.stringify(message.content).includes(text)))
            context.messages.push(notice);
        }
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
    if (this.#disposed) throw new Error("The navigation session is closed.");
    if (this.#pending || this.#applying) throw new Error("Another workspace operation is pending.");
    if (this.session.isCompacting)
      throw new Error("Wait for context maintenance before changing workspace.");
    signal?.throwIfAborted();
    const sourceCwd = this.session.sessionManager.getCwd();
    const sourceId = this.session.sessionManager.getSessionId();
    let target: string | undefined;
    switch (request.action) {
      case "move":
        target = await this.navigation.validateMove(request.dir);
        break;
      case "enter":
        target = await this.navigation.validateEnter(request.path);
        break;
      case "exit":
        target = await this.navigation.validateExit();
        break;
      case "create":
        if (!request.branch.trim()) throw new Error("A non-empty worktree branch is required.");
        break;
      case "remove":
        if (!request.path.trim()) throw new Error("A worktree path is required.");
        break;
      default:
        throw new Error("Unknown workspace operation.");
    }
    signal?.throwIfAborted();
    if (
      sourceCwd !== this.session.sessionManager.getCwd() ||
      sourceId !== this.session.sessionManager.getSessionId()
    )
      throw new Error("The session changed while validating the workspace request.");
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

  async applyPending(signal?: AbortSignal): Promise<void> {
    const pending = this.#pending;
    if (!pending) return;
    if (
      signal?.aborted ||
      pending.signal?.aborted ||
      this.session.sessionManager.getSessionId() !== pending.sessionId ||
      this.session.sessionManager.getCwd() !== pending.cwd
    ) {
      await this.cancel("The session changed or the request was aborted.");
      return;
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
        )
          throw new Error("The session changed before applying the workspace operation.");
        if (this.session.isCompacting)
          throw new Error("Workspace operation is blocked by context maintenance.");
        switch (pending.request.action) {
          case "move":
            result.target = await this.navigation.validateMove(pending.request.dir);
            await this.#dependencies.relocate(result.target);
            break;
          case "enter":
            result.target = await this.navigation.validateEnter(pending.request.path);
            await this.#dependencies.relocate(result.target);
            break;
          case "exit":
            result.target = await this.navigation.validateExit();
            await this.#dependencies.relocate(result.target);
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
      if (error instanceof WorkspaceRollbackError) fatal = error;
    } finally {
      this.#applying = false;
    }
    result.cwd = this.session.sessionManager.getCwd();
    if (pending.sessionId !== this.session.sessionManager.getSessionId()) return;
    await this.#notice(result);
    if (fatal) throw fatal;
  }

  async cancel(reason: string): Promise<void> {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    pending.detachAbort?.();
    if (this.session.sessionManager.getSessionId() === pending.sessionId) {
      await this.#notice({
        ...pending.result,
        status: "cancelled",
        error: reason,
        cwd: this.session.sessionManager.getCwd(),
      });
    }
  }

  async #notice(result: WorkspaceResult): Promise<void> {
    const message = {
      role: "developer" as const,
      content: [
        { type: "text" as const, text: `Workspace operation result: ${JSON.stringify(result)}` },
      ],
      attribution: "agent" as const,
      timestamp: Date.now(),
    };
    this.#notices.push(message);
    this.session.agent.appendMessage(message);
    this.session.sessionManager.appendMessage(message);
    await this.session.sessionManager.flush();
  }

  dispose(): void {
    void this.cancel("The session closed.").catch((error) =>
      process.stderr.write(`omp-nav cancellation: ${String(error)}\n`),
    );
    this.#disposed = true;
    for (const remove of this.#removers.splice(0)) remove();
  }

  get disposed(): boolean {
    return this.#disposed;
  }
}

const installations = new WeakMap<object, WorkspaceBridge>();

export class WorkspaceBridge {
  readonly runtime: RuntimeModules;
  #owners = new WeakMap<object, InteractiveOwner>();
  #coordinators = new WeakMap<object, WorkspaceCoordinator>();
  #memory?: MemoryBridgeLike;
  #grantStates = new WeakMap<object, WorkspaceGrantState>();
  #promptWorkspaceTrees = new WeakMap<object, { cwd: string; tree: unknown }>();
  #projectPrefixes = new WeakMap<object, { initial: string; current: string; append?: string }>();
  #promptScopeChecked = new WeakSet<object>();
  #afterRelocation = new Set<(session: SessionLike) => Promise<void>>();
  #btwRunning = new WeakMap<object, number>();
  #workspaceApplying = new WeakSet<object>();
  #activeMain?: {
    sessionManager: SessionLike["sessionManager"];
    session: SessionLike;
    grants?: WorkspaceGrantState;
    navigation: WorkspaceNavigation;
  };

  constructor(runtime: RuntimeModules) {
    this.runtime = runtime;
  }

  setMemoryBridge(memory: MemoryBridgeLike): void {
    this.#memory = memory;
  }
  async runBtw<T>(session: SessionLike, operation: () => Promise<T>): Promise<T> {
    if (this.#workspaceApplying.has(session))
      throw new Error("BTW cannot start while a workspace operation is applying.");
    this.#btwRunning.set(session, (this.#btwRunning.get(session) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const remaining = (this.#btwRunning.get(session) ?? 1) - 1;
      if (remaining) this.#btwRunning.set(session, remaining);
      else this.#btwRunning.delete(session);
    }
  }
  addAfterRelocationHook(hook: (session: SessionLike) => Promise<void>): () => void {
    this.#afterRelocation.add(hook);
    return () => {
      this.#afterRelocation.delete(hook);
    };
  }
  async notifyAfterRelocation(session: SessionLike): Promise<void> {
    for (const hook of this.#afterRelocation) await hook(session);
  }

  async prepareProjectPrompt(session: SessionLike): Promise<void> {
    if (this.#promptScopeChecked.has(session)) return;
    this.#promptScopeChecked.add(session);
    const cli = await this.runtime.importModule<{
      parseArgs(args: string[]): {
        systemPrompt?: string;
        systemPromptTemplate?: string;
        appendSystemPrompt?: string;
      };
    }>("cli/args.ts");
    const args = cli.parseArgs([...process.argv.slice(2)]);
    if (args.systemPrompt !== undefined || args.systemPromptTemplate !== undefined) return;
    if (!(await this.#discoverPromptOverride(session.sessionManager.getCwd()))) return;
    const prefix = session.agent.state.systemPrompt[0];
    if (prefix) {
      const prompts = await this.runtime.importLibraryModule<{
        resolvePromptInput(
          input: string | undefined,
          description: string,
        ): Promise<string | undefined>;
      }>("system-prompt.ts");
      const append = await prompts.resolvePromptInput(
        args.appendSystemPrompt,
        "append system prompt",
      );
      this.#projectPrefixes.set(session, { initial: prefix, current: prefix, append });
    }
  }

  async #discoverPromptOverride(
    cwd: string,
  ): Promise<{ kind?: string; content: string } | undefined> {
    await this.runtime.importModule("capability/system-prompt.ts");
    const capabilities = await this.runtime.importModule<{
      loadCapability(
        id: string,
        options: { cwd: string },
      ): Promise<{ items: Array<{ level: string; kind?: string; content: string }> }>;
    }>("capability/index.ts");
    const result = await capabilities.loadCapability("system-prompt", { cwd });
    for (const level of ["project", "user"]) {
      const text = result.items.find(
        (item) => item.level === level && (item.kind ?? "text") === "text",
      );
      if (text) return text;
      const template = result.items.find(
        (item) => item.level === level && item.kind === "template" && item.content.trim(),
      );
      if (template) return template;
    }
  }

  async refreshProjectPrompt(session: SessionLike): Promise<void> {
    await this.prepareProjectPrompt(session);
    const state = this.#projectPrefixes.get(session);
    const sessionId = session.sessionManager.getSessionId();
    const cwd = session.sessionManager.getCwd();
    const current = session.agent.state.systemPrompt;
    // Keep an intentional extension override; only own the automatically discovered prefix.
    if (!state || (current[0] !== state.initial && current[0] !== state.current)) return;
    const native = findNativeToolSession(session);
    const active = session as RescopableSession & {
      getAllToolNames(): string[];
      getEnabledToolNames(): string[];
      getEvalPreludes(): unknown[];
      getXdevToolEntries(): Array<{ name: string }>;
      skills: unknown[];
      renderedSkills: unknown[];
      obfuscator?: { obfuscates(): boolean };
      ttsrManager?: { getRules(): Array<{ name: string }> };
      skillsSettings: unknown;
      model?: { provider: string; id: string };
    };
    const prompts = await this.runtime.importLibraryModule<{
      buildSystemPrompt(options: Record<string, unknown>): Promise<{ systemPrompt: string[] }>;
      projectSystemPromptToolMetadata(
        tools: Map<string, unknown>,
        options: Record<string, unknown>,
      ): unknown;
    }>("system-prompt.ts");
    const ids = [
      "inlineToolDescriptors",
      "personality",
      "skillful",
      "includeModelInPrompt",
      "includeWorkspaceTree",
      "task.disabledAgents",
      "tools.xdevDocs",
      "tools.xdevInlineDevices",
      "task.eager",
      "task.batch",
      "task.maxConcurrency",
      "tools.intentTracing",
      "security.enabled",
      "memory.backend",
      "tui.renderMermaid",
      "tui.renderSvg",
      "tui.autoGraph",
      "tui.reactions",
    ];
    const values = Object.fromEntries(
      await Promise.all(
        ids.map(async (id) => [id, await readSetting(this.runtime, session.settings, id)]),
      ),
    );
    const inline =
      values.inlineToolDescriptors === "on" ||
      (values.inlineToolDescriptors === "auto" && active.model?.id.includes("gemini"));
    const names = active.getEnabledToolNames();
    const tools = new Map(
      active.getAllToolNames().map((name) => [name, active.getToolByName(name)]),
    );
    const xdevEntries = active.getXdevToolEntries();
    const dialect = await this.runtime.importModule<{
      resolveDialect(format: unknown, model: unknown): unknown;
    }>("sdk.ts");
    const nativeTools =
      dialect.resolveDialect(
        await readSetting(this.runtime, session.settings, "tools.format"),
        active.model,
      ) === undefined;
    const override = await this.#discoverPromptOverride(cwd);
    const [
      spawn,
      policy,
      irc,
      autoQa,
      xdev,
      repoContext,
      nativeRouter,
      sourceRouter,
      nativeUtils,
      sourceUtils,
      projections,
    ] = await Promise.all([
      this.runtime.importModule<{ isScoutSpawnable(disabled: unknown, spawns: unknown): boolean }>(
        "task/spawn-policy.ts",
      ),
      this.runtime.importModule<{ sessionDelegationBias(session: unknown): unknown }>(
        "task/prompt-policy.ts",
      ),
      this.runtime.importModule<{ isIrcEnabled(settings: unknown, depth: number): boolean }>(
        "irc/messaging.ts",
      ),
      this.runtime.importModule<{ isAutoQaEnabled(settings: unknown): boolean }>(
        "tools/report-tool-issue.ts",
      ),
      this.runtime.importModule<{
        planXdevPromptDocs(
          state: unknown,
          mode: unknown,
          inline: unknown,
        ): { catalog: Map<string, unknown> };
        renderXdevPromptDocs(docs: unknown, elsewhere: Set<string>): string;
        listXdevTools(state: unknown): unknown[];
      }>("tools/xdev.ts"),
      this.runtime.importModule<{ resolveActiveRepoContext(cwd: string): Promise<unknown> }>(
        "utils/active-repo-context.ts",
      ),
      this.runtime.importModule<{ InternalUrlRouter: { instance(): unknown } }>(
        "internal-urls/router.ts",
      ),
      this.runtime.importLibraryModule<{ InternalUrlRouter: { instance(): unknown } }>(
        "internal-urls/router.ts",
      ),
      this.runtime.importModule<{ getAgentDir(): string }>("@oh-my-pi/pi-utils"),
      this.runtime.importLibraryModule<{ getAgentDir(): string }>("@oh-my-pi/pi-utils"),
      this.runtime.importModule<{
        collectMountedMCPToolRoutes(tools: unknown[]): unknown;
        projectMountedMCPXdevGuidance(routes: unknown): { mappings: Array<{ name: string }> };
      }>("session/session-tools.ts"),
    ]);
    // The library's renderer must consult the live URL registry, not its own singleton.
    if (sourceRouter.InternalUrlRouter !== nativeRouter.InternalUrlRouter)
      sourceRouter.InternalUrlRouter.instance = () => nativeRouter.InternalUrlRouter.instance();
    // PERSONALITY.md is the renderer's only remaining file lookup; bind its scope explicitly.
    if (sourceUtils.getAgentDir() !== nativeUtils.getAgentDir())
      throw new Error(
        "The prompt renderer's agent directory differs from the running omp profile.",
      );
    let workspaceTree: unknown = {
      rootPath: cwd,
      rendered: "",
      truncated: false,
      totalLines: 0,
      agentsMdFiles: [],
    };
    if (values.includeWorkspaceTree === true) {
      let saved = this.#promptWorkspaceTrees.get(session);
      if (!saved || saved.cwd !== cwd) {
        const sdk = dialect as typeof dialect & {
          buildWorkspaceTree(cwd: string, options: { timeoutMs: number }): Promise<unknown>;
        };
        saved = { cwd, tree: await sdk.buildWorkspaceTree(cwd, { timeoutMs: 5_000 }) };
        this.#promptWorkspaceTrees.set(session, saved);
      }
      workspaceTree = saved.tree;
    }
    const docs = native.xdev
      ? xdev.planXdevPromptDocs(
          native.xdev,
          values["tools.xdevDocs"],
          values["tools.xdevInlineDevices"],
        )
      : undefined;
    const routed = projections.projectMountedMCPXdevGuidance(
      projections.collectMountedMCPToolRoutes(native.xdev ? xdev.listXdevTools(native.xdev) : []),
    );
    const routedNames = new Set(
      routed.mappings
        .filter((mapping) => docs?.catalog.has(mapping.name))
        .map((mapping) => mapping.name),
    );
    const ttsrNames = new Set(active.ttsrManager?.getRules().map((rule) => rule.name) ?? []);
    const promptRules = (
      (native.activeRules ?? []) as Array<{
        name: string;
        alwaysApply?: boolean;
        description?: string;
      }>
    ).filter((rule) => !ttsrNames.has(rule.name));
    // Capability discoveries and session snapshots come from the host; preserve its render inputs.
    const rendered = await prompts.buildSystemPrompt({
      cwd,
      resolvedCustomPrompt: override?.kind === "template" ? undefined : (override?.content ?? ""),
      systemPromptTemplate: override?.kind === "template" ? override.content : undefined,
      resolvedAppendSystemPrompt: state.append,
      additionalWorkspaceRoots: [],
      workspaceTree,
      includeWorkspaceTree: values.includeWorkspaceTree,
      activeRepoContext: await repoContext.resolveActiveRepoContext(cwd).catch(() => null),
      tools: prompts.projectSystemPromptToolMetadata(
        tools,
        inline || !nativeTools
          ? { mode: "full" }
          : { mode: "compact", toolNames: [...names, ...xdevEntries.map((entry) => entry.name)] },
      ),
      toolNames: names,
      directToolNames: active.getActiveToolNames(),
      inlineToolDescriptors: inline,
      nativeTools,
      skills: values.skillful ? active.renderedSkills : [],
      skillsSettings: active.skillsSettings,
      skillDescriptions: { render: (skills: unknown[]) => skills },
      contextFiles: native.contextFiles ?? [],
      rules: promptRules.filter((rule) => rule.alwaysApply !== true && rule.description),
      alwaysApplyRules: promptRules.filter((rule) => rule.alwaysApply === true),
      evalPreludes: active.getEvalPreludes(),
      xdevTools: xdevEntries,
      model:
        native.getActiveModelString?.() ??
        (active.model ? `${active.model.provider}/${active.model.id}` : undefined),
      includeModelInPrompt: values.includeModelInPrompt,
      scoutAvailable: spawn.isScoutSpawnable(
        values["task.disabledAgents"],
        native.getSessionSpawns?.() ?? "*",
      ),
      delegationBias: policy.sessionDelegationBias(native),
      taskIrcEnabled: irc.isIrcEnabled(session.settings, native.taskDepth ?? 0),
      autoQaEnabled: autoQa.isAutoQaEnabled(session.settings),
      secretsEnabled: active.obfuscator?.obfuscates() === true,
      writeTransportOnly:
        native.deviceOnlyWrite === true && native.pendingFullWriteDescription !== true,
      xdevDocs: docs ? xdev.renderXdevPromptDocs(docs, routedNames) : "",
      personality: values.personality,
      eagerTasks: values["task.eager"] !== "default",
      eagerTasksAlways: values["task.eager"] === "always",
      taskBatch: values["task.batch"],
      taskMaxConcurrency: values["task.maxConcurrency"],
      intentField: values["tools.intentTracing"] ? "i" : undefined,
      memoryBackend: values["memory.backend"] === "off" ? undefined : values["memory.backend"],
      securityEnabled: values["security.enabled"],
      settingsApproval: native.settingsApproval === true,
      renderMermaid: !!this.owner(session) && values["tui.renderMermaid"],
      renderSvg: !!this.owner(session) && values["tui.renderSvg"],
      autoGraph: !!this.owner(session) && values["tui.autoGraph"] !== "off",
      reactions: !!this.owner(session) && values["tui.reactions"],
    });
    const latest = session.agent.state.systemPrompt;
    if (
      sessionId !== session.sessionManager.getSessionId() ||
      cwd !== session.sessionManager.getCwd() ||
      (latest[0] !== state.initial && latest[0] !== state.current)
    )
      return;
    state.current = rendered.systemPrompt[0];
    session.agent.setSystemPrompt([state.current, ...latest.slice(1)]);
  }

  currentSession(ctx: ExtensionContextLike): SessionLike {
    const ref = this.runtime.host.AgentRegistry.global().get(ctx.agent.id);
    if (!ref?.session || ref.session.sessionManager !== ctx.sessionManager) {
      throw new Error(
        `omp-agent-nav cannot match this context to the running omp session (supported: ${SUPPORTED_OMP_VERSIONS.join(", ")}).`,
      );
    }
    return ref.session;
  }

  owner(session: SessionLike): InteractiveOwner | undefined {
    return this.#owners.get(session.sessionManager);
  }
  captureOwner(owner: InteractiveOwner): void {
    this.#owners.set(owner.sessionManager, owner);
  }

  navigation(ctx: ExtensionContextLike): WorkspaceNavigation {
    return this.coordinator(ctx).navigation;
  }
  async assertAllowedPath(ctx: ExtensionContextLike, path: string): Promise<string> {
    return await this.navigation(ctx).validateMove(path);
  }
  async grantWorkspaceDirs(
    ctx: ExtensionContextLike,
    dirs: string[],
  ): Promise<{ granted: string[]; skipped: string[]; roots: string[] }> {
    const session = this.currentSession(ctx);
    this.coordinator(ctx);
    const grants = this.#grantStates.get(session.sessionManager);
    const granted: string[] = [];
    const skipped: string[] = [];
    const accepted = new Set(grants?.roots() ?? session.sessionManager.getAdditionalDirectories());
    for (const dir of dirs) {
      const lexical = resolve(session.sessionManager.getCwd(), dir);
      if (lexical.split(sep).includes(".git"))
        throw new Error("Git metadata cannot become a workspace root.");
      const identity = await resolveProjectIdentity(this.runtime, lexical);
      const candidate = identity.mainRoot;
      if (accepted.has(candidate) || [...accepted].some((root) => pathIsWithin(root, candidate))) {
        skipped.push(candidate);
        continue;
      }
      const manager = session.sessionManager as Partial<GrantManager>;
      if (typeof manager.addWorkspaceDirectory !== "function")
        throw new Error("This omp session manager does not support adding workspace directories.");
      const added = await manager.addWorkspaceDirectory(candidate);
      const canonical = added ?? candidate;
      accepted.add(canonical);
      granted.push(canonical);
    }
    return { granted, skipped, roots: [...accepted] };
  }

  /** session_move targets outside accepted roots need an on-the-spot human approval; execute re-validates. */
  moveNeedsGrant(dir: string): boolean {
    const active = this.#activeMain;
    if (
      !active ||
      typeof dir !== "string" ||
      !dir.trim() ||
      !this.#owners.has(active.sessionManager)
    )
      return false;
    let target: string;
    try {
      target = expandPath(dir, active.session.sessionManager.getCwd());
    } catch {
      return false;
    }
    if (target.split(sep).includes(".git")) return false;
    const granted =
      active.grants?.roots() ?? active.session.sessionManager.getAdditionalDirectories();
    const initial =
      active.navigation.resolvedInitialRoot ??
      active.grants?.initialCwd ??
      active.session.sessionManager.getCwd();
    return ![initial, ...granted].some((root) => pathIsWithin(root, target));
  }

  sessionMoveApproval(
    args: unknown,
  ): "write" | { tier: "write"; policy: "prompt"; reason: string } {
    const dir = (args as { dir?: unknown } | null | undefined)?.dir;
    return typeof dir === "string" && this.moveNeedsGrant(dir)
      ? { tier: "write", policy: "prompt", reason: "Цель вне принятых workspace-корней" }
      : "write";
  }

  coordinator(ctx: ExtensionContextLike): WorkspaceCoordinator {
    if (ctx.agent.kind !== "main")
      throw new Error("Only the main session may navigate projects or worktrees.");
    const session = this.currentSession(ctx);
    let coordinator = this.#coordinators.get(session.sessionManager);
    if (
      coordinator &&
      (coordinator.disposed || coordinator.sessionId !== session.sessionManager.getSessionId())
    ) {
      coordinator.dispose();
      coordinator = undefined;
    }
    if (!coordinator) {
      let grants = this.#grantStates.get(session.sessionManager);
      if (
        !grants &&
        typeof (session.sessionManager as Partial<GrantManager>).appendCustomEntry === "function"
      ) {
        grants = new WorkspaceGrantState(session.sessionManager as GrantManager);
        this.#grantStates.set(session.sessionManager, grants);
      }
      grants?.roots();
      const initialCwd = grants?.initialCwd ?? session.sessionManager.getCwd();
      const navigation = new WorkspaceNavigation(this.runtime, {
        initialCwd,
        getCwd: () => session.sessionManager.getCwd(),
        getWorkspaceRoots: () =>
          grants?.roots() ?? session.sessionManager.getAdditionalDirectories(),
        getSettings: () => session.settings,
        getLiveAgentCwds: () =>
          this.runtime.host.AgentRegistry.global()
            .list()
            .filter((ref) => ref.kind !== "main" && ref.session)
            .flatMap((ref) => {
              const settings = ref.session!.settings as typeof ref.session.settings & {
                getCwd?(): string;
              };
              return [
                ref.session!.sessionManager.getCwd(),
                ...(settings.getCwd ? [settings.getCwd()] : []),
              ];
            }),
      });
      coordinator = new WorkspaceCoordinator({
        session,
        navigation,
        beforeModelCall: () => this.refreshProjectPrompt(session),
        relocate: (cwd) => this.relocate(session, cwd),
        withGate: async (operation) => {
          if ((this.#btwRunning.get(session) ?? 0) > 0)
            throw new Error("Workspace operation is blocked by an active BTW request.");
          this.#workspaceApplying.add(session);
          try {
            await session.settings.flush();
            const owner = this.owner(session);
            if (!owner) return await operation();
            let ran = false;
            let value: Awaited<ReturnType<typeof operation>> | undefined;
            let operationError: unknown;
            const accepted = await owner.withBtwSessionMove(async () => {
              ran = true;
              try {
                value = await operation();
                return true;
              } catch (error) {
                operationError = error;
                return false;
              }
            });
            if (operationError) throw operationError;
            if (!ran || !accepted)
              throw new Error(
                "Workspace operation is blocked by an active BTW request or session transition.",
              );
            return value as Awaited<ReturnType<typeof operation>>;
          } finally {
            this.#workspaceApplying.delete(session);
          }
        },
      });
      this.#coordinators.set(session.sessionManager, coordinator);
    }
    this.#activeMain = {
      sessionManager: session.sessionManager,
      session,
      grants: this.#grantStates.get(session.sessionManager),
      navigation: coordinator.navigation,
    };
    return coordinator;
  }

  async relocate(session: SessionLike, cwd: string): Promise<void> {
    const grants = this.#grantStates.get(session.sessionManager);
    if (grants) return await grants.withTransition(() => this.#relocate(session, cwd));
    return await this.#relocate(session, cwd);
  }

  async #relocate(session: SessionLike, cwd: string): Promise<void> {
    const previous = session.sessionManager.captureState();
    if (previous.cwd === cwd) return;
    await session.settleMemoryBackend();
    await session.sessionManager.flush();
    try {
      await session.moveSession(cwd);
      await this.#rescope(session, cwd);
      await this.#coordinators.get(session.sessionManager)?.navigation.validateMove(cwd);
      await this.#grantStates.get(session.sessionManager)?.synchronize();
      await session.refreshBaseSystemPrompt();
      await this.refreshProjectPrompt(session);
      await this.notifyAfterRelocation(session);
    } catch (error) {
      try {
        await session.sessionManager.rollbackMove(previous);
        await this.#rescope(session, previous.cwd);
        await this.#grantStates.get(session.sessionManager)?.synchronize();
        await session.refreshBaseSystemPrompt();
        await this.refreshProjectPrompt(session);
        await this.notifyAfterRelocation(session);
      } catch (restoreError) {
        throw new WorkspaceRollbackError(
          `Workspace transition failed (${String(error)}); restoring ${previous.cwd} also failed (${String(restoreError)}). Actual cwd: ${session.sessionManager.getCwd()}. The model run was stopped.`,
        );
      }
      throw new Error(
        `Workspace transition failed and was restored to ${previous.cwd}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #rescope(session: SessionLike, cwd: string): Promise<void> {
    const owner = this.owner(session);
    if (owner) {
      if (!(await owner.applyCwdChange(cwd)))
        throw new Error(`The TUI could not prepare workspace ${cwd}.`);
      await this.#memory?.ensure(session, cwd);
      if (typeof (session as Partial<RescopableSession>).getToolByName === "function")
        await rescopeProjectMcp(this.runtime, session, cwd);
      await session.refreshSkillsAndCommands();
      owner.updateEditorBorderColor();
      await owner.reloadTodos();
      owner.ui.requestRender();
    } else {
      const dirs = await this.runtime.importModule<{ setProjectDir(cwd: string): void }>(
        "@oh-my-pi/pi-utils/dirs",
      );
      const discovery = await this.runtime.importModule<{ clearClaudePluginRootsCache(): void }>(
        "discovery/helpers.ts",
      );
      const backend = await this.runtime.importModule<{
        rebindMemoryBackendForCwd(session: SessionLike): Promise<void>;
      }>("hindsight/backend.ts");
      dirs.setProjectDir(cwd);
      await session.settings.reloadForCwd(cwd);
      await backend.rebindMemoryBackendForCwd(session);
      await this.#memory?.ensure(session, cwd);
      discovery.clearClaudePluginRootsCache();
      if (typeof (session as Partial<RescopableSession>).getToolByName === "function")
        await rescopeProjectMcp(this.runtime, session, cwd);
      await session.refreshSkillsAndCommands();
    }
  }
}

export async function installHostBridge(runtime: RuntimeModules): Promise<WorkspaceBridge> {
  const host: HostNamespace = runtime.host;
  const prototype = host.ExtensionRunner.prototype;
  const existing = installations.get(prototype);
  if (existing) return existing;
  const registry = await runtime.importModule<{ AgentRegistry: HostNamespace["AgentRegistry"] }>(
    "registry/agent-registry.ts",
  );
  if (registry.AgentRegistry !== host.AgentRegistry)
    throw new Error(
      `omp-agent-nav could not bind to the running omp module registry. Use a supported npm omp version: ${SUPPORTED_OMP_VERSIONS.join(", ")}.`,
    );
  const bridge = new WorkspaceBridge(runtime);
  await installInstructionScope(runtime);
  const sessions = await runtime.importModule<{
    AgentSession: {
      prototype: SessionLike & {
        runEphemeralTurn(args: {
          conversationKey?: string;
          [key: string]: unknown;
        }): Promise<unknown>;
      };
    };
  }>("session/agent-session.ts");
  const ephemeral = sessions.AgentSession.prototype.runEphemeralTurn;
  sessions.AgentSession.prototype.runEphemeralTurn = async function (args) {
    return args.conversationKey?.startsWith("btw:")
      ? await bridge.runBtw(this, () => ephemeral.call(this, args))
      : await ephemeral.call(this, args);
  };
  installations.set(prototype, bridge);
  const createContext = prototype.createContext;
  prototype.createContext = function (...args: unknown[]) {
    const ctx = createContext.apply(this, args);
    const delegation = args[1] as
      | { toolName: string; depth?: number; signal?: AbortSignal }
      | undefined;
    const assertTopLevel = () => {
      if ((delegation?.depth ?? 0) > 0)
        throw new Error(
          "Nested workspace navigation is not supported; call the navigation tool directly in a solo batch.",
        );
      return bridge.coordinator(ctx);
    };
    ctx.requestWorkspaceChange = async (request) => {
      if (delegation && !NAVIGATION_TOOLS.has(delegation.toolName))
        throw new Error("Workspace changes must be requested through a direct navigation tool.");
      return await assertTopLevel().request(request, delegation?.signal);
    };
    ctx.listWorktrees = async () => await assertTopLevel().navigation.listWorktrees();
    return ctx;
  };
  const interactive = host.InteractiveMode.prototype;
  const originalInit = interactive.init;
  interactive.init = async function (...args: unknown[]) {
    bridge.captureOwner(this);
    return await originalInit.apply(this, args);
  };
  return bridge;
}
