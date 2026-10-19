import { existsSync, realpathSync } from "node:fs";
import { sep } from "node:path";

import {
  expandPath,
  pathIsWithin,
  resolveProjectIdentity,
  WorkspaceNavigation,
} from "../navigation";
import { SUPPORTED_OMP_VERSIONS } from "../runtime";
import {
  type ExtensionContextLike,
  type HostNamespace,
  type InteractiveOwner,
  type RuntimeModules,
  type SessionLike,
} from "../types";
import { WorkspaceCoordinator } from "./coordinator";
import { type GrantManager, WorkspaceGrantState, WorkspaceRollbackError } from "./grants";
import { type RescopableSession, rescopeProjectMcp } from "./mcp";

interface MemoryBridgeLike {
  ensure(session: SessionLike, sourceCwd?: string): Promise<unknown>;
}

export interface WorkspaceRoot {
  missing: boolean;
  root: string;
  source: "start" | "grant" | "add-dir";
}

// omp re-imports the extension graph (`?mtime=`) for every subagent session, so module-local
// state cannot see an earlier install. The process-wide key lives on a host prototype that all
// graphs share.
const HOST_BRIDGE = Symbol.for("omp-agent-nav.host-bridge");

export class WorkspaceBridge {
  readonly runtime: RuntimeModules;
  #owners = new WeakMap<object, InteractiveOwner>();
  #coordinators = new WeakMap<object, WorkspaceCoordinator>();
  #memory?: MemoryBridgeLike;
  #grantStates = new WeakMap<object, WorkspaceGrantState>();
  #afterRelocation = new Set<(session: SessionLike) => Promise<void>>();
  #btwRunning = new WeakMap<object, number>();
  /** Grant roots shown in approval dialogs, by requested dir, per main session manager. */
  #approvedRoots = new WeakMap<object, Map<string, string>>();
  #workspaceApplying = new WeakSet<object>();
  #settingRegistry?: { lookup(id: string): { get(settings: unknown): unknown } | undefined };
  #activeMain?: {
    sessionManager: SessionLike["sessionManager"];
    session: SessionLike;
    grants: WorkspaceGrantState;
    navigation: WorkspaceNavigation;
  };

  constructor(runtime: RuntimeModules) {
    this.runtime = runtime;
  }

  /** Root checks run synchronously (approval), so the settings registry is loaded up front. */
  async loadSettingRegistry(): Promise<void> {
    await this.runtime.importModule("config/all-settings.ts");
    this.#settingRegistry = await this.runtime.importModule("config/registry.ts");
  }

  /** `workspace.additionalDirectories` of the current settings, as configured. */
  #configuredRoots(session: SessionLike): string[] {
    const value = this.#settingRegistry
      ?.lookup("workspace.additionalDirectories")
      ?.get(session.settings);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
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
  /**
   * `approved[i]`, when set, is the root the human saw for `dirs[i]`; a directory that now resolves
   * elsewhere (a swapped symlink) fails the whole call before anything is granted.
   */
  async grantWorkspaceDirs(
    ctx: ExtensionContextLike,
    dirs: string[],
    approved: Array<string | undefined> = [],
  ): Promise<{ granted: string[]; skipped: string[]; roots: string[] }> {
    const session = this.currentSession(ctx);
    const navigation = this.coordinator(ctx).navigation;
    const grants = this.#grants(session);
    // Resolve every directory before granting any, so one bad path grants nothing.
    const candidates: string[] = [];
    for (const [index, dir] of dirs.entries()) {
      const lexical = expandPath(dir, session.sessionManager.getCwd());
      if (lexical.split(sep).includes(".git")) {
        throw new Error("Git metadata cannot become a workspace root.");
      }
      const candidate = (await resolveProjectIdentity(this.runtime, lexical)).mainRoot;
      if (approved[index] !== undefined && approved[index] !== candidate) {
        throw new Error(
          `${dir} now resolves to ${candidate}, not the approved ${approved[index]}; nothing was granted.`,
        );
      }
      candidates.push(candidate);
    }
    const initial = await navigation.initialRoot();
    const accepted = [...(initial ? [initial] : []), ...grants.roots()];
    const granted: string[] = [];
    const skipped: string[] = [];
    for (const candidate of candidates) {
      if (accepted.some((root) => pathIsWithin(root, candidate))) {
        skipped.push(candidate);
        continue;
      }
      grants.add(candidate);
      accepted.push(candidate);
      granted.push(candidate);
    }
    await grants.persist();
    return { granted, skipped, roots: grants.roots() };
  }

  #grants(session: SessionLike): WorkspaceGrantState {
    let grants = this.#grantStates.get(session.sessionManager);
    if (!grants) {
      grants = new WorkspaceGrantState(session.sessionManager as GrantManager, () =>
        this.#configuredRoots(session),
      );
      this.#grantStates.set(session.sessionManager, grants);
    }
    return grants;
  }

  /** Root a grant for `dir` would accept, as shown in approval dialogs. */
  grantPreview(dir: unknown): string | undefined {
    const active = this.#activeMain;
    if (!active || typeof dir !== "string" || !dir.trim()) {
      return undefined;
    }
    try {
      const target = expandPath(dir, active.session.sessionManager.getCwd());
      return active.navigation.previewProjectRoot(target);
    } catch {
      return undefined;
    }
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
      const lexical = expandPath(dir, active.session.sessionManager.getCwd());
      if (lexical.split(sep).includes(".git")) {
        return false;
      }
      // Ledger roots are realpaths (macOS /var → /private/var); a missing target is rejected by validateMove.
      target = realpathSync(lexical);
    } catch {
      return false;
    }
    if (target.split(sep).includes(".git")) {
      return false;
    }
    const granted = active.grants.roots();
    const initial = active.navigation.resolvedInitialRoot ?? active.grants.initialCwd;
    // A worktree of an accepted project is accepted too (validateMove authorizes its primary).
    const project = active.navigation.previewProjectRoot(target);
    return ![initial, ...granted].some(
      (root) =>
        pathIsWithin(root, target) || (project !== undefined && pathIsWithin(root, project)),
    );
  }

  #approvals(): Map<string, string> | undefined {
    const active = this.#activeMain;
    if (!active) {
      return undefined;
    }
    let roots = this.#approvedRoots.get(active.sessionManager);
    if (!roots) {
      roots = new Map();
      this.#approvedRoots.set(active.sessionManager, roots);
    }
    return roots;
  }

  /**
   * The approval decision is made once, here: the dialog shows this root and execute may grant
   * only this root. Re-deciding in execute would let a symlink swapped after approval through.
   */
  sessionMoveApproval(
    args: unknown,
  ): "write" | { tier: "write"; policy: "prompt"; reason: string } {
    const dir = (args as { dir?: unknown } | null | undefined)?.dir;
    if (typeof dir !== "string") {
      return "write";
    }
    const root = this.moveNeedsGrant(dir) ? this.grantPreview(dir) : undefined;
    if (!root) {
      this.#approvals()?.delete(dir);
      return "write";
    }
    this.#approvals()?.set(dir, root);
    return { tier: "write", policy: "prompt", reason: "Цель вне принятых workspace-корней" };
  }

  /** Dialog line for `dir`; `record` (workspace_grant) remembers the shown root for execute. */
  describeGrant(dir: unknown, record = false): string {
    if (typeof dir !== "string") {
      return `dir: ${String(dir)}`;
    }
    let root = this.#approvals()?.get(dir);
    if (record) {
      root = this.grantPreview(dir);
      if (root) {
        this.#approvals()?.set(dir, root);
      } else {
        this.#approvals()?.delete(dir);
      }
    }
    return root && root !== dir ? `dir: ${dir} → grant: ${root}` : `dir: ${dir}`;
  }

  /** Consumes the root approved for `dir`, if any. */
  takeApprovedRoot(dir: string): string | undefined {
    const approvals = this.#approvals();
    const root = approvals?.get(dir);
    approvals?.delete(dir);
    return root;
  }

  async listRoots(ctx: ExtensionContextLike): Promise<WorkspaceRoot[]> {
    const navigation = this.coordinator(ctx).navigation;
    const grants = this.#grants(this.currentSession(ctx));
    const initial = await navigation.initialRoot();
    // A root also in the native list shows as add-dir: its AGENTS join the prompt.
    const native = new Set(grants.trustedNative().map(([root]) => root));
    return [
      { root: initial ?? grants.initialCwd, source: "start", missing: initial === undefined },
      ...grants.roots().map((root) => ({
        root,
        source: native.has(root) ? ("add-dir" as const) : ("grant" as const),
        missing: !existsSync(root),
      })),
    ];
  }

  /**
   * Revokes the root named by `dir` (a worktree path names its primary) from the ledger and the
   * native list. The start root is not revocable, and neither is a root the session stands in.
   */
  async revokeRoot(
    ctx: ExtensionContextLike,
    dir: string,
  ): Promise<{ revoked: string[]; coveredBy?: string }> {
    const session = this.currentSession(ctx);
    const navigation = this.coordinator(ctx).navigation;
    const grants = this.#grants(session);
    const target = this.#namedRoot(navigation, expandPath(dir, session.sessionManager.getCwd()));
    const ledger = grants.ledger().filter(target.matches);
    const native = grants.native().filter(([root]) => target.matches(root));
    const initial = await navigation.initialRoot();
    const revoked = [...new Set([...ledger, ...native.map(([root]) => root)])];
    const remaining = [
      ...(initial ? [initial] : []),
      ...grants.roots().filter((root) => !revoked.includes(root)),
    ];
    const coveredBy = remaining.find((root) => pathIsWithin(root, target.path));
    if (!revoked.length) {
      throw new Error(
        initial !== undefined && target.matches(initial)
          ? `${dir} is the start project; it cannot be revoked.`
          : `${dir} is not a granted workspace root${coveredBy ? `; it is inside ${coveredBy}` : ""}.`,
      );
    }
    // Refuse only when the revoke itself would leave the session's cwd outside every root.
    const here = this.#namedRoot(navigation, session.sessionManager.getCwd());
    const holding = revoked.find(here.covered);
    if (holding !== undefined && !remaining.some(here.covered)) {
      throw new Error(`The session is inside ${holding}; move out of it before revoking it.`);
    }
    for (const root of ledger) {
      grants.revoke(root);
    }
    await grants.persist();
    const manager = session.sessionManager as GrantManager;
    for (const [, stored] of native) {
      await manager.removeWorkspaceDirectory(stored);
    }
    if (native.length) {
      // Native /remove-dir does the same: the root's AGENTS leave the prompt.
      await session.refreshBaseSystemPrompt();
    }
    return { revoked, coveredBy };
  }

  /**
   * A path names a root exactly; only a linked worktree outside its primary checkout names the
   * primary. A subdirectory names nothing, so revoking it cannot take its whole repository.
   */
  #namedRoot(navigation: WorkspaceNavigation, lexical: string) {
    let path = lexical;
    try {
      path = realpathSync(lexical);
    } catch {
      // A vanished directory still matches its ledger entry lexically.
    }
    const primary = navigation.previewProjectRoot(path);
    const worktreeOf =
      primary !== undefined && primary !== path && !pathIsWithin(primary, path)
        ? primary
        : undefined;
    return {
      path,
      matches: (root: string) => root === path || root === lexical || root === worktreeOf,
      /** Whether `root` authorizes this path, directly or through its primary checkout. */
      covered: (root: string) =>
        pathIsWithin(root, path) || (primary !== undefined && pathIsWithin(root, primary)),
    };
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
      const grants = this.#grants(session);
      // roots() first re-reads the ledger if the session id changed since the state was created.
      grants.roots();
      const navigation = new WorkspaceNavigation(this.runtime, {
        initialCwd: grants.initialCwd,
        getCwd: () => session.sessionManager.getCwd(),
        getWorkspaceRoots: () => grants.roots(),
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
      grants: this.#grants(session),
      navigation: coordinator.navigation,
    };
    return coordinator;
  }

  /**
   * Native roots that authorize `cwd` move into the ledger before the move: native moveTo drops
   * the new cwd from the native list and the settings watcher may drop configured roots, yet the
   * post-move validation and later navigation must still accept them. Persisting first also
   * records the start root before the session file moves; a rollback restores the entries.
   */
  async #adoptNativeRoots(session: SessionLike, cwd: string): Promise<void> {
    const grants = this.#grants(session);
    const primary = this.#coordinators
      .get(session.sessionManager)
      ?.navigation.previewProjectRoot(cwd);
    for (const [root] of grants.trustedNative()) {
      if (pathIsWithin(root, cwd) || (primary !== undefined && pathIsWithin(root, primary))) {
        grants.add(root);
      }
    }
    await grants.persist();
  }

  /** Resolves to a warning when project MCP of `cwd` started only partially. */
  async relocate(session: SessionLike, cwd: string): Promise<string | undefined> {
    const previous = session.sessionManager.captureState();
    if (previous.cwd === cwd) {
      return undefined;
    }
    await session.settleMemoryBackend();
    await session.sessionManager.flush();
    try {
      await this.#adoptNativeRoots(session, cwd);
      await session.moveSession(cwd);
      const warning = await this.#rescope(session, cwd);
      await this.#coordinators.get(session.sessionManager)?.navigation.validateMove(cwd);
      await session.refreshBaseSystemPrompt();
      await this.notifyAfterRelocation(session);
      return warning;
    } catch (error) {
      let warning: string | undefined;
      try {
        await session.sessionManager.rollbackMove(previous);
        this.#grants(session).reload();
        warning = await this.#rescope(session, previous.cwd);
        await session.refreshBaseSystemPrompt();
        await this.notifyAfterRelocation(session);
      } catch (restoreError) {
        throw new WorkspaceRollbackError(
          `Workspace transition failed (${String(error)}); restoring ${previous.cwd} also failed (${String(restoreError)}). Actual cwd: ${session.sessionManager.getCwd()}. The model run was stopped.`,
        );
      }
      throw new Error(
        `Workspace transition failed and was restored to ${previous.cwd}${warning ? ` (partially: ${warning})` : ""}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Memory and project MCP of `cwd`. Project MCP tolerates flaky servers like native startup: the
   * tools that started are published and the failure comes back as a warning. Memory stays
   * strict: a run must not continue without mandatory memory; the next prompt retries startup.
   */
  async #rescopeResources(session: SessionLike, cwd: string): Promise<string | undefined> {
    await this.#memory?.ensure(session, cwd);
    if (typeof (session as Partial<RescopableSession>).getToolByName === "function") {
      return await rescopeProjectMcp(this.runtime, session, cwd);
    }
    return undefined;
  }

  async #rescope(session: SessionLike, cwd: string): Promise<string | undefined> {
    const owner = this.owner(session);
    let warning: string | undefined;
    if (owner) {
      if (!(await owner.applyCwdChange(cwd))) {
        throw new Error(`The TUI could not prepare workspace ${cwd}.`);
      }
      warning = await this.#rescopeResources(session, cwd);
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
      discovery.clearClaudePluginRootsCache();
      warning = await this.#rescopeResources(session, cwd);
      await session.refreshSkillsAndCommands();
    }
    return warning;
  }
}

export async function installHostBridge(runtime: RuntimeModules): Promise<WorkspaceBridge> {
  const prototype = runtime.host.ExtensionRunner.prototype as {
    [HOST_BRIDGE]?: Promise<WorkspaceBridge>;
  };
  prototype[HOST_BRIDGE] ??= createHostBridge(runtime).catch((error) => {
    delete prototype[HOST_BRIDGE];
    throw error;
  });
  return await prototype[HOST_BRIDGE];
}

async function createHostBridge(runtime: RuntimeModules): Promise<WorkspaceBridge> {
  const host: HostNamespace = runtime.host;
  const registry = await runtime.importModule<{ AgentRegistry: HostNamespace["AgentRegistry"] }>(
    "registry/agent-registry.ts",
  );
  if (registry.AgentRegistry !== host.AgentRegistry) {
    throw new Error(
      `omp-agent-nav could not bind to the running omp module registry. Use a supported npm omp version: ${SUPPORTED_OMP_VERSIONS.join(", ")}.`,
    );
  }
  const bridge = new WorkspaceBridge(runtime);
  await bridge.loadSettingRegistry();
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
  const interactive = host.InteractiveMode.prototype;
  const originalInit = interactive.init;
  interactive.init = async function (...args: unknown[]) {
    bridge.captureOwner(this);
    return await originalInit.apply(this, args);
  };
  return bridge;
}
