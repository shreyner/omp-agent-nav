import { resolve, sep } from "node:path";

import {
  expandPath,
  pathIsWithin,
  resolveProjectIdentity,
  WorkspaceNavigation,
} from "../navigation";
import { installInstructionScope, readSetting, SUPPORTED_OMP_VERSIONS } from "../runtime";
import { findNativeToolSession, type NativeTaskSession } from "../task";
import {
  type ExtensionContextLike,
  type HostNamespace,
  type InteractiveOwner,
  type RuntimeModules,
  type SessionLike,
} from "../types";
import { NAVIGATION_TOOLS, WorkspaceCoordinator } from "./coordinator";
import { type GrantManager, WorkspaceGrantState, WorkspaceRollbackError } from "./grants";
import { type RescopableSession, rescopeProjectMcp } from "./mcp";

interface MemoryBridgeLike {
  ensure(session: SessionLike, sourceCwd?: string): Promise<unknown>;
}

interface PromptRenderContext {
  active: RescopableSession & {
    getAllToolNames(): string[];
    getEnabledToolNames(): string[];
    getEvalPreludes(): unknown[];
    getXdevToolEntries(): Array<{ name: string }>;
    renderedSkills: unknown[];
    obfuscator?: { obfuscates(): boolean };
    skillsSettings: unknown;
    model?: { provider: string; id: string };
  };
  activeRepoContext: unknown;
  docs: { catalog: Map<string, unknown> } | undefined;
  inline: boolean;
  modules: {
    spawn: { isScoutSpawnable(disabled: unknown, spawns: unknown): boolean };
    policy: { sessionDelegationBias(session: unknown): unknown };
    irc: { isIrcEnabled(settings: unknown, depth: number): boolean };
    autoQa: { isAutoQaEnabled(settings: unknown): boolean };
    xdev: { renderXdevPromptDocs(docs: unknown, elsewhere: Set<string>): string };
    repoContext: { resolveActiveRepoContext(cwd: string): Promise<unknown> };
  };
  names: string[];
  native: NativeTaskSession;
  nativeTools: boolean;
  override: { kind?: string; content: string } | undefined;
  promptRules: Array<{ name: string; alwaysApply?: boolean; description?: string }>;
  prompts: {
    buildSystemPrompt(options: Record<string, unknown>): Promise<{ systemPrompt: string[] }>;
    projectSystemPromptToolMetadata(
      tools: Map<string, unknown>,
      options: Record<string, unknown>,
    ): unknown;
  };
  routedNames: Set<string>;
  tools: Map<string, unknown>;
  values: Record<string, unknown>;
  workspaceTree: unknown;
  xdevEntries: Array<{ name: string }>;
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
    if (this.#workspaceApplying.has(session)) {
      throw new Error("BTW cannot start while a workspace operation is applying.");
    }
    this.#btwRunning.set(session, (this.#btwRunning.get(session) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const remaining = (this.#btwRunning.get(session) ?? 1) - 1;
      if (remaining) {
        this.#btwRunning.set(session, remaining);
      } else {
        this.#btwRunning.delete(session);
      }
    }
  }
  addAfterRelocationHook(hook: (session: SessionLike) => Promise<void>): () => void {
    this.#afterRelocation.add(hook);
    return () => {
      this.#afterRelocation.delete(hook);
    };
  }
  async notifyAfterRelocation(session: SessionLike): Promise<void> {
    for (const hook of this.#afterRelocation) {
      await hook(session);
    }
  }

  async prepareProjectPrompt(session: SessionLike): Promise<void> {
    if (this.#promptScopeChecked.has(session)) {
      return;
    }
    this.#promptScopeChecked.add(session);
    const cli = await this.runtime.importModule<{
      parseArgs(args: string[]): {
        systemPrompt?: string;
        systemPromptTemplate?: string;
        appendSystemPrompt?: string;
      };
    }>("cli/args.ts");
    const args = cli.parseArgs([...process.argv.slice(2)]);
    if (args.systemPrompt !== undefined || args.systemPromptTemplate !== undefined) {
      return;
    }
    if (!(await this.#discoverPromptOverride(session.sessionManager.getCwd()))) {
      return;
    }
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
      if (text) {
        return text;
      }
      const template = result.items.find(
        (item) => item.level === level && item.kind === "template" && item.content.trim(),
      );
      if (template) {
        return template;
      }
    }
  }

  async refreshProjectPrompt(session: SessionLike): Promise<void> {
    await this.prepareProjectPrompt(session);
    const state = this.#projectPrefixes.get(session);
    const sessionId = session.sessionManager.getSessionId();
    const cwd = session.sessionManager.getCwd();
    const current = session.agent.state.systemPrompt;
    // Keep an intentional extension override; only own the automatically discovered prefix.
    if (!state || (current[0] !== state.initial && current[0] !== state.current)) {
      return;
    }
    const context = await this.#collectPromptContext(session, cwd);
    const rendered = await context.prompts.buildSystemPrompt(
      this.#promptOptions(session, cwd, state, context),
    );
    const latest = session.agent.state.systemPrompt;
    if (
      sessionId !== session.sessionManager.getSessionId() ||
      cwd !== session.sessionManager.getCwd() ||
      (latest[0] !== state.initial && latest[0] !== state.current)
    ) {
      return;
    }
    state.current = rendered.systemPrompt[0];
    session.agent.setSystemPrompt([state.current, ...latest.slice(1)]);
  }

  async #collectPromptContext(session: SessionLike, cwd: string): Promise<PromptRenderContext> {
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
      (values.inlineToolDescriptors === "auto" && active.model?.id.includes("gemini") === true);
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
    if (sourceRouter.InternalUrlRouter !== nativeRouter.InternalUrlRouter) {
      sourceRouter.InternalUrlRouter.instance = () => nativeRouter.InternalUrlRouter.instance();
    }
    // PERSONALITY.md is the renderer's only remaining file lookup; bind its scope explicitly.
    if (sourceUtils.getAgentDir() !== nativeUtils.getAgentDir()) {
      throw new Error(
        "The prompt renderer's agent directory differs from the running omp profile.",
      );
    }
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
    const activeRepoContext = await repoContext.resolveActiveRepoContext(cwd).catch(() => null);
    return {
      native,
      active,
      prompts,
      values,
      inline,
      names,
      tools,
      xdevEntries,
      nativeTools,
      override,
      modules: { spawn, policy, irc, autoQa, xdev, repoContext },
      workspaceTree,
      docs,
      routedNames,
      promptRules,
      activeRepoContext,
    };
  }

  #tuiPromptFlags(session: SessionLike, values: Record<string, unknown>) {
    const interactive = !!this.owner(session);
    return {
      renderMermaid: interactive && values["tui.renderMermaid"],
      renderSvg: interactive && values["tui.renderSvg"],
      autoGraph: interactive && values["tui.autoGraph"] !== "off",
      reactions: interactive && values["tui.reactions"],
    };
  }

  #promptOptions(
    session: SessionLike,
    cwd: string,
    state: { initial: string; current: string; append?: string },
    context: PromptRenderContext,
  ): Record<string, unknown> {
    const {
      native,
      active,
      prompts,
      values,
      inline,
      names,
      tools,
      xdevEntries,
      nativeTools,
      override,
      modules,
      workspaceTree,
      docs,
      routedNames,
      promptRules,
      activeRepoContext,
    } = context;
    return {
      cwd,
      resolvedCustomPrompt: override?.kind === "template" ? undefined : (override?.content ?? ""),
      systemPromptTemplate: override?.kind === "template" ? override.content : undefined,
      resolvedAppendSystemPrompt: state.append,
      additionalWorkspaceRoots: [],
      workspaceTree,
      includeWorkspaceTree: values.includeWorkspaceTree,
      activeRepoContext,
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
        (native.getActiveModelString as (() => string | undefined) | undefined)?.() ??
        (active.model ? `${active.model.provider}/${active.model.id}` : undefined),
      includeModelInPrompt: values.includeModelInPrompt,
      scoutAvailable: modules.spawn.isScoutSpawnable(
        values["task.disabledAgents"],
        native.getSessionSpawns?.() ?? "*",
      ),
      delegationBias: modules.policy.sessionDelegationBias(native),
      taskIrcEnabled: modules.irc.isIrcEnabled(
        session.settings,
        (native.taskDepth as number | undefined) ?? 0,
      ),
      autoQaEnabled: modules.autoQa.isAutoQaEnabled(session.settings),
      secretsEnabled: active.obfuscator?.obfuscates() === true,
      writeTransportOnly:
        native.deviceOnlyWrite === true && native.pendingFullWriteDescription !== true,
      xdevDocs: docs ? modules.xdev.renderXdevPromptDocs(docs, routedNames) : "",
      personality: values.personality,
      eagerTasks: values["task.eager"] !== "default",
      eagerTasksAlways: values["task.eager"] === "always",
      taskBatch: values["task.batch"],
      taskMaxConcurrency: values["task.maxConcurrency"],
      intentField: values["tools.intentTracing"] ? "i" : undefined,
      memoryBackend: values["memory.backend"] === "off" ? undefined : values["memory.backend"],
      securityEnabled: values["security.enabled"],
      settingsApproval: native.settingsApproval === true,
      ...this.#tuiPromptFlags(session, values),
    };
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
      if (lexical.split(sep).includes(".git")) {
        throw new Error("Git metadata cannot become a workspace root.");
      }
      const identity = await resolveProjectIdentity(this.runtime, lexical);
      const candidate = identity.mainRoot;
      if (accepted.has(candidate) || [...accepted].some((root) => pathIsWithin(root, candidate))) {
        skipped.push(candidate);
        continue;
      }
      const manager = session.sessionManager as Partial<GrantManager>;
      if (typeof manager.addWorkspaceDirectory !== "function") {
        throw new Error("This omp session manager does not support adding workspace directories.");
      }
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
    ) {
      return false;
    }
    let target: string;
    try {
      target = expandPath(dir, active.session.sessionManager.getCwd());
    } catch {
      return false;
    }
    if (target.split(sep).includes(".git")) {
      return false;
    }
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
    if (ctx.agent.kind !== "main") {
      throw new Error("Only the main session may navigate projects or worktrees.");
    }
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
            .flatMap((ref) => {
              if (ref.kind === "main" || !ref.session) {
                return [];
              }
              const settings = ref.session.settings as SessionLike["settings"] & {
                getCwd?(): string;
              };
              return [
                ref.session.sessionManager.getCwd(),
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
          if ((this.#btwRunning.get(session) ?? 0) > 0) {
            throw new Error("Workspace operation is blocked by an active BTW request.");
          }
          this.#workspaceApplying.add(session);
          try {
            await session.settings.flush();
            const owner = this.owner(session);
            if (!owner) {
              return await operation();
            }
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
            if (operationError) {
              throw operationError;
            }
            if (!ran || !accepted) {
              throw new Error(
                "Workspace operation is blocked by an active BTW request or session transition.",
              );
            }
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
    if (grants) {
      return await grants.withTransition(() => this.#relocate(session, cwd));
    }
    return await this.#relocate(session, cwd);
  }

  async #relocate(session: SessionLike, cwd: string): Promise<void> {
    const previous = session.sessionManager.captureState();
    if (previous.cwd === cwd) {
      return;
    }
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
      if (!(await owner.applyCwdChange(cwd))) {
        throw new Error(`The TUI could not prepare workspace ${cwd}.`);
      }
      await this.#memory?.ensure(session, cwd);
      if (typeof (session as Partial<RescopableSession>).getToolByName === "function") {
        await rescopeProjectMcp(this.runtime, session, cwd);
      }
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
      if (typeof (session as Partial<RescopableSession>).getToolByName === "function") {
        await rescopeProjectMcp(this.runtime, session, cwd);
      }
      await session.refreshSkillsAndCommands();
    }
  }
}

export async function installHostBridge(runtime: RuntimeModules): Promise<WorkspaceBridge> {
  const host: HostNamespace = runtime.host;
  const prototype = host.ExtensionRunner.prototype;
  const existing = installations.get(prototype);
  if (existing) {
    return existing;
  }
  const registry = await runtime.importModule<{ AgentRegistry: HostNamespace["AgentRegistry"] }>(
    "registry/agent-registry.ts",
  );
  if (registry.AgentRegistry !== host.AgentRegistry) {
    throw new Error(
      `omp-agent-nav could not bind to the running omp module registry. Use a supported npm omp version: ${SUPPORTED_OMP_VERSIONS.join(", ")}.`,
    );
  }
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
      if ((delegation?.depth ?? 0) > 0) {
        throw new Error(
          "Nested workspace navigation is not supported; call the navigation tool directly in a solo batch.",
        );
      }
      return bridge.coordinator(ctx);
    };
    ctx.requestWorkspaceChange = async (request) => {
      if (delegation && !NAVIGATION_TOOLS.has(delegation.toolName)) {
        throw new Error("Workspace changes must be requested through a direct navigation tool.");
      }
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
