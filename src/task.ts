import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";

import { type WorkspaceBridge } from "./host";
import { type MemoryBridge } from "./memory";
import {
  type ExtensionApiLike,
  type RuntimeModules,
  type SessionLike,
  type SettingsLike,
} from "./types";

interface TaskSettings extends SettingsLike {
  cloneForCwd(cwd: string): Promise<TaskSettings>;
  extensionsSourceLevel(): string;
  getCwd(): string;
  overlay(values: Record<string, unknown>): TaskSettings;
}
export interface NativeTaskSession {
  agentOutputManager?: unknown;
  authStorage?: unknown;
  cwd: string;
  enableMCP?: boolean;
  getSessionSpawns(): string | null;
  settings: TaskSettings;
  [key: string]: unknown;
}
interface TaskAnchor {
  artifacts: string;
  file: string;
  manager: unknown;
  sessionId: string;
}
const anchors = new WeakMap<SessionLike, TaskAnchor>();
const anchorTransitions = new WeakMap<SessionLike, Promise<void>>();

/** Keep child journals outside the parent's relocatable artifact directory. */
export async function syncTaskAnchor(runtime: RuntimeModules, parent: SessionLike): Promise<void> {
  const prior = anchorTransitions.get(parent) ?? Promise.resolve();
  const transition = prior.catch(() => {}).then(() => applyTaskAnchor(runtime, parent));
  anchorTransitions.set(parent, transition);
  try {
    await transition;
  } finally {
    if (anchorTransitions.get(parent) === transition) {
      anchorTransitions.delete(parent);
    }
  }
}

async function applyTaskAnchor(runtime: RuntimeModules, parent: SessionLike): Promise<void> {
  const manager = parent.sessionManager as SessionLike["sessionManager"] & {
    getSessionFile(): string | undefined;
    getSessionDir(): string;
    adoptArtifactManager(manager: unknown): void;
    getArtifactsDir(): string | null;
  };
  const actualFile = manager.getSessionFile();
  if (!actualFile) {
    return;
  }
  let anchor = anchors.get(parent);
  if (!anchor || anchor.sessionId !== parent.sessionId) {
    const file = join(
      dirname(manager.getSessionDir()),
      ".omp-agent-nav",
      `${parent.sessionId}.jsonl`,
    );
    const artifacts = file.slice(0, -6);
    const { ArtifactManager } = await runtime.importModule<{
      ArtifactManager: new (directory: string) => unknown;
    }>("session/artifacts.ts");
    await fs.mkdir(dirname(file), { recursive: true });
    const previousArtifacts = manager.getArtifactsDir();
    const anchorExists = await fs.stat(artifacts).then(
      () => true,
      (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw error;
      },
    );
    if (!anchorExists && previousArtifacts && previousArtifacts !== artifacts) {
      await fs
        .cp(previousArtifacts, artifacts, { recursive: true, errorOnExist: true, force: false })
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        });
    }
    const native = findNativeToolSession(parent);
    anchor = {
      sessionId: parent.sessionId,
      file,
      artifacts,
      manager: new ArtifactManager(artifacts),
    };
    anchors.set(parent, anchor);
    native.getSessionFile = () => anchor!.file;
    native.getArtifactsDir = () => anchor!.artifacts;
    native.getArtifactManager = () => anchor!.manager;
  }
  manager.adoptArtifactManager(anchor.manager);
  const next = `${anchor.file}.next-${process.pid}`;
  await fs.symlink(actualFile, next);
  await fs.rename(next, anchor.file).catch(async (error) => {
    await fs.unlink(next).catch(() => {});
    throw error;
  });
  const ref = runtime.host.AgentRegistry.global()
    .list()
    .find((value) => value.session === parent);
  if (ref) {
    (ref as typeof ref & { sessionFile: string }).sessionFile = anchor.file;
  }
}
interface Schema {
  array(): Schema;
  exclude(value: string): Schema;
  get(...keys: (string | number)[]): Schema;
  merge(fields: Record<string, unknown>): Schema;
  toJsonSchema(): Record<string, unknown>;
}
interface NativeTask {
  description: string;
  execute(
    id: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (result: TaskResult) => void,
  ): Promise<TaskResult>;
  parameters: Schema;
  session: NativeTaskSession;
}
interface TaskResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  details: {
    results: Array<{ index?: number; [key: string]: unknown }>;
    progress?: Array<{ index?: number; [key: string]: unknown }>;
    totalDurationMs?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
export interface ScopedMcpManager {
  disconnectAll(): Promise<void>;
  getTools(): unknown[];
}
/** Shared budget for target-MCP startup readiness; mutable for tests. */
export const mcpStartupWait = { ms: 30_000 };
const ownedMcpManagers = new WeakMap<NativeTaskSession, ScopedMcpManager>();

export function findNativeToolSession(session: SessionLike): NativeTaskSession {
  const getTool = (session as SessionLike & { getToolByName(name: string): unknown }).getToolByName;
  if (!getTool) {
    throw new Error("omp-nav cannot access the native tool session on this omp runtime.");
  }
  for (const name of ["task", "read", "bash", "edit", "write"]) {
    let tool = getTool.call(session, name) as Record<string, unknown> | undefined;
    for (let depth = 0; tool && depth < 8; depth++) {
      const candidate = tool.session as NativeTaskSession | undefined;
      if (candidate?.settings && typeof candidate.getSessionSpawns === "function") {
        return candidate;
      }
      tool = tool.tool as Record<string, unknown> | undefined;
    }
  }
  throw new Error(
    "omp-nav needs an installed native task/read/bash/edit/write tool to bind the destination task scope.",
  );
}

interface SettingRegistry {
  lookup(id: string): { get(settings: SettingsLike): unknown } | undefined;
}
function readSetting(registry: SettingRegistry, settings: SettingsLike, key: string) {
  const handle = registry.lookup(key);
  if (!handle) {
    throw new Error(`omp-nav needs the native ${key} setting on this omp runtime.`);
  }
  return handle.get(settings);
}
function extensionRoots(settings: TaskSettings, registry: SettingRegistry) {
  return {
    explicit: [],
    mode: "merge",
    configured: readSetting(registry, settings, "extensions"),
    configuredLevel: settings.extensionsSourceLevel(),
  };
}

export async function createScopedMcpManager(
  runtime: RuntimeModules,
  cwd: string,
  settings: TaskSettings,
  authStorage?: unknown,
): Promise<ScopedMcpManager> {
  const registry = await runtime.importModule<SettingRegistry>("config/registry.ts");
  const { MCPManager } = await runtime.importModule<{
    MCPManager: new (
      cwd: string,
    ) => ScopedMcpManager & {
      setAuthStorage(storage: unknown): void;
      discoverAndConnect(
        options: Record<string, unknown>,
      ): Promise<{ errors?: Map<string, string> }>;
      waitForStartup(
        timeoutMs: number,
      ): Promise<{ failed: Array<{ name: string; error: string }>; pending: string[] }>;
    };
  }>("mcp/manager.ts");
  const manager = new MCPManager(cwd);
  if (authStorage) {
    manager.setAuthStorage(authStorage);
  }
  try {
    const loaded = await manager.discoverAndConnect({
      enableProjectConfig: readSetting(registry, settings, "mcp.enableProjectConfig"),
      startupTimeoutMs: readSetting(registry, settings, "mcp.startupTimeoutMs"),
      filterExa: true,
      filterBrowser: false,
      extensionRoots: extensionRoots(settings, registry),
    });
    const startup = await manager.waitForStartup(mcpStartupWait.ms);
    if (loaded.errors?.size || startup.failed.length || startup.pending.length) {
      throw new Error(
        `MCP startup failed for ${cwd}: ${JSON.stringify({ errors: [...(loaded.errors ?? [])], ...startup })}`,
      );
    }
    return manager;
  } catch (error) {
    await manager.disconnectAll();
    throw error;
  }
}

export async function prepareTaskScope(
  runtime: RuntimeModules,
  parent: SessionLike,
  target: string,
  batch: boolean,
): Promise<NativeTaskSession> {
  const [registry, { AgentOutputManager }] = await Promise.all([
    runtime.importModule<SettingRegistry>("config/registry.ts"),
    runtime.importModule<{
      AgentOutputManager: new (getArtifactsDir: () => string | null) => unknown;
    }>("task/output-manager.ts"),
  ]);
  const native = findNativeToolSession(parent);
  if (!native.agentOutputManager) {
    native.agentOutputManager = new AgentOutputManager(
      (native.getArtifactsDir as () => string | null).bind(native),
    );
  }
  const settings = (await native.settings.cloneForCwd(target)).overlay({
    "workspace.additionalDirectories": [],
    "task.batch": batch,
  });
  const scoped: NativeTaskSession = { ...native, cwd: target, settings, additionalDirectories: [] };
  const parentId = parent.sessionId;
  const parentFile = (native.getSessionFile as () => string | null)();
  const artifactDirectory =
    (native.getArtifactsDir as (() => string | null) | undefined)?.() ?? null;
  const artifactManager = (native.getArtifactManager as (() => unknown) | undefined)?.();
  scoped.getSessionId = () => parentId;
  scoped.getSessionFile = () => parentFile;
  scoped.getArtifactsDir = () => artifactDirectory;
  scoped.getArtifactManager = () => artifactManager;
  for (const key of [
    "contextFiles",
    "skills",
    "activeRules",
    "rules",
    "workspaceTree",
    "promptTemplates",
    "extensionPaths",
    "preparedExtensions",
    "customToolPaths",
    "refreshSkills",
    "getMnemopiSessionState",
    "getHindsightSessionState",
  ]) {
    scoped[key] = undefined;
  }
  scoped.effectiveExtensionRoots = () => extensionRoots(settings, registry);
  const [{ discoverSkills }, { cfgSkills }] = await Promise.all([
    runtime.importModule<{
      discoverSkills(
        cwd: string,
        agentDir: undefined,
        options: Record<string, unknown>,
      ): Promise<{ skills: unknown[] }>;
    }>("sdk.ts"),
    runtime.importModule<{ cfgSkills: { get(settings: SettingsLike): Record<string, unknown> } }>(
      "extensibility/settings.ts",
    ),
  ]);
  // Native task policy turns an absent parent skill list into [], which suppresses SDK discovery.
  scoped.skills = (
    await discoverSkills(target, undefined, {
      ...cfgSkills.get(settings),
      disabledExtensions: readSetting(registry, settings, "disabledExtensions"),
    })
  ).skills;
  if (native.enableMCP !== false) {
    const manager = await createScopedMcpManager(runtime, target, settings, native.authStorage);
    scoped.mcpManager = manager;
    ownedMcpManagers.set(scoped, manager);
    // Kept-alive native children retain this manager across park/revive and parent cwd changes.
    parent.addDisposer(() => {
      void manager.disconnectAll().catch(() => {});
    });
  } else {
    scoped.mcpManager = undefined;
    scoped.enableMCP = false;
  }
  return scoped;
}

export async function installTaskTool(
  pi: ExtensionApiLike,
  runtime: RuntimeModules,
  bridge: WorkspaceBridge,
  _memory: MemoryBridge,
): Promise<void> {
  const [{ TaskTool }, { getTaskSchema }, registry, policy, { Semaphore }] = await Promise.all([
    runtime.importModule<{ TaskTool: { create(session: NativeTaskSession): Promise<NativeTask> } }>(
      "task/index.ts",
    ),
    runtime.importModule<{ getTaskSchema(options: Record<string, unknown>): Schema }>(
      "task/types.ts",
    ),
    runtime.importModule<SettingRegistry>("config/registry.ts"),
    runtime.importModule<{
      resolveEffectiveSubagentPolicy(
        request: Record<string, unknown>,
      ): Promise<{ effectiveAgent: { blocking?: boolean } }>;
    }>("task/structured-subagent.ts"),
    runtime.importModule<{
      Semaphore: new (
        limit: number,
      ) => {
        acquire(signal?: AbortSignal): Promise<void>;
        release(): void;
        resize(limit: number): void;
      };
    }>("task/parallel.ts"),
  ]);
  const gates = new WeakMap<SessionLike, InstanceType<typeof Semaphore>>();
  const schemaOptions = {
    isolationEnabled: true,
    effortEnabled: true,
    evalToolsEnabled: true,
    structured: true,
    defaultAgent: "task",
  };
  const initialSchema = getTaskSchema({ ...schemaOptions, batchEnabled: false });
  let advertisedTask: NativeTask | undefined;
  let advertisedParent: SessionLike | undefined;
  let advertisedKind: "main" | "sub" | undefined;
  let removeRelocationHook: (() => void) | undefined;
  pi.on("session_start", async (_event, ctx) => {
    removeRelocationHook?.();
    advertisedParent = bridge.currentSession(ctx);
    advertisedKind = ctx.agent.kind;
    advertisedTask = await TaskTool.create(findNativeToolSession(advertisedParent));
    if (advertisedKind === "main") {
      const remove = bridge.addAfterRelocationHook(async (session) => {
        if (session !== advertisedParent) {
          return;
        }
        await syncTaskAnchor(runtime, session);
        advertisedTask = await TaskTool.create(findNativeToolSession(session));
      });
      removeRelocationHook = remove;
      advertisedParent.addDisposer(remove);
    }
  });
  pi.registerTool({
    name: "task",
    label: "Task",
    approval: "exec",
    get description() {
      if (advertisedKind === "sub") {
        return advertisedTask!.description;
      }
      return `${advertisedTask?.description ?? "Delegate to native omp agents."}\nOptional cwd selects the project before agent discovery and launch. Each tasks[] item may set its own cwd; omitted cwd snapshots the parent's directory. Child instructions, tools, MCP, and memory come from the destination.`;
    },
    get parameters() {
      const schema = advertisedTask?.parameters ?? initialSchema;
      if (advertisedKind === "sub") {
        return schema;
      }
      const properties = schema.toJsonSchema().properties as Record<string, unknown> | undefined;
      return properties?.tasks
        ? schema.merge({
            tasks: schema.get("tasks", 0).exclude("undefined").merge({ "cwd?": "string" }).array(),
          })
        : schema.merge({ "cwd?": "string" });
    },
    async execute(id, raw, signal, onUpdate, ctx) {
      const parent = bridge.currentSession(ctx);
      if (ctx.agent.kind === "sub") {
        return await runSubagentTask({ id, raw, signal, onUpdate, parent, advertisedTask });
      }
      const sourceCwd = parent.sessionManager.getCwd();
      const batch = Array.isArray(raw.tasks);
      const items = assertTaskRequestShape(raw, registry, parent.settings);
      const targets = await resolveTaskTargets(items, sourceCwd, (requested) =>
        bridge.assertAllowedPath(ctx, requested),
      );
      await syncTaskAnchor(runtime, parent);
      const limit = Math.max(
        0,
        Math.trunc(Number(readSetting(registry, parent.settings, "task.maxConcurrency")) || 0),
      );
      let gate = gates.get(parent);
      if (gate) {
        gate.resize(limit);
      } else {
        gate = new Semaphore(limit);
        gates.set(parent, gate);
      }
      const scopes = new Map<string, Promise<NativeTask>>();
      // Resolve every destination before native preflight can allocate an artifact or start a child.
      for (const target of new Set(targets)) {
        scopes.set(
          target,
          prepareTaskScope(runtime, parent, target, batch).then(async (scoped) => {
            try {
              wrapOwnedAsyncJobs(scoped, gate!);
              return await TaskTool.create(scoped);
            } catch (error) {
              await ownedMcpManagers.get(scoped)?.disconnectAll();
              throw error;
            }
          }),
        );
      }
      const prepared = await Promise.allSettled(scopes.values());
      const ready = prepared
        .filter((value) => value.status === "fulfilled")
        .map((value) => (value as PromiseFulfilledResult<NativeTask>).value);
      const cleanupPrepared = () =>
        Promise.all(ready.map((task) => ownedMcpManagers.get(task.session)?.disconnectAll()));
      const preparationFailure = prepared.find((value) => value.status === "rejected") as
        | PromiseRejectedResult
        | undefined;
      if (preparationFailure) {
        await cleanupPrepared();
        throw preparationFailure.reason;
      }
      let preflights: Array<{ effectiveAgent: { blocking?: boolean } }>;
      try {
        preflights = await Promise.all(
          items.map(async (item, index) => {
            const task = await scopes.get(targets[index])!;
            const structured =
              readSetting(registry, task.session.settings, "task.structured") === true;
            return policy.resolveEffectiveSubagentPolicy({
              session: task.session,
              ...taskPreflightOptions(item, raw, batch, structured),
              signal,
            });
          }),
        );
      } catch (error) {
        await cleanupPrepared();
        throw error;
      }
      const started = Date.now();
      const snapshots: TaskResult[] = new Array(items.length);
      const merged = () => mergeTaskOutcomes(snapshots.filter(Boolean), Date.now() - started);
      const invoke = (index: number) =>
        runTaskInvocation(
          {
            id,
            signal,
            onUpdate,
            registry,
            scopes,
            targets,
            items,
            raw,
            batch,
            snapshots,
            merged,
            gate,
            preflights,
          },
          index,
        );
      if (!batch) {
        return await invoke(0);
      }
      await runBatchedInvocations(items, limit, invoke);
      return merged();
    },
  });
}

function aggregateUsage(
  usages: Array<{ cost: Record<string, number>; [key: string]: unknown }>,
): Record<string, unknown> {
  const usage: Record<string, unknown> = { cost: {} };
  for (const current of usages) {
    for (const [key, value] of Object.entries(current)) {
      if (typeof value === "number") {
        usage[key] = Number(usage[key] ?? 0) + value;
      }
    }
    const cost = usage.cost as Record<string, number>;
    for (const [key, value] of Object.entries(current.cost ?? {})) {
      cost[key] = (cost[key] ?? 0) + value;
    }
  }
  return usage;
}

function summarizeAsyncStates(asyncStates: Array<{ state: string; jobId: string; type: string }>): {
  state: string;
  jobId: string;
  type: string;
} {
  const states = asyncStates.map((value) => value.state);
  return {
    ...asyncStates[0],
    state: states.includes("running")
      ? "running"
      : states.includes("failed")
        ? "failed"
        : "completed",
  };
}

function hasCwdAssignment(raw: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(raw, "cwd") ||
    (Array.isArray(raw.tasks) &&
      raw.tasks.some((item) => item && typeof item === "object" && Object.hasOwn(item, "cwd")))
  );
}

async function runSubagentTask(deps: {
  id: string;
  raw: Record<string, unknown>;
  signal?: AbortSignal;
  onUpdate: unknown;
  parent: SessionLike;
  advertisedTask: NativeTask | undefined;
}): Promise<TaskResult> {
  if (hasCwdAssignment(deps.raw)) {
    throw new Error("Only the main session can assign task.cwd to a subagent.");
  }
  const task = deps.advertisedTask ?? (await TaskTool.create(findNativeToolSession(deps.parent)));
  return await task.execute(
    deps.id,
    deps.raw,
    deps.signal,
    typeof deps.onUpdate === "function"
      ? (deps.onUpdate as (result: TaskResult) => void)
      : undefined,
  );
}

function assertTaskRequestShape(
  raw: Record<string, unknown>,
  registry: Parameters<typeof readSetting>[0],
  settings: SettingsLike,
): Record<string, unknown>[] {
  const batch = Array.isArray(raw.tasks);
  assertBatchTaskRules(raw, batch, registry, settings);
  const items = batch ? (raw.tasks as Record<string, unknown>[]) : [raw];
  if (!items.length) {
    throw new Error("Provide at least one tasks[] item.");
  }
  for (const item of items) {
    if (!item || typeof item.task !== "string" || !item.task.trim()) {
      throw new Error("Every task requires a non-empty assignment.");
    }
  }
  const names = items
    .filter((item) => typeof item.name === "string" && item.name.trim())
    .map((item) => (item.name as string).trim().toLowerCase());
  if (new Set(names).size !== names.length) {
    throw new Error("Batch task names must be unique.");
  }
  return items;
}

function wrapOwnedAsyncJobs(
  scoped: { asyncJobManager?: unknown; getAgentId?: unknown },
  gate: Semaphore,
): void {
  const manager = scoped.asyncJobManager as
    | {
        register(
          type: unknown,
          label: unknown,
          run: (context: { signal: AbortSignal }) => Promise<unknown>,
          options: unknown,
        ): unknown;
      }
    | undefined;
  const ownerId = (scoped.getAgentId as (() => string | null) | undefined)?.();
  if (!manager) {
    return;
  }
  scoped.asyncJobManager = new Proxy(manager, {
    get(object, property) {
      if (property === "register") {
        return (
          type: unknown,
          label: unknown,
          run: (context: { signal: AbortSignal }) => Promise<unknown>,
          options: unknown,
        ) => {
          if ((options as { ownerId?: string } | undefined)?.ownerId !== ownerId) {
            return object.register(type, label, run, options);
          }
          return object.register(
            type,
            label,
            async (context) => {
              await gate.acquire(context.signal);
              try {
                return await run(context);
              } finally {
                gate.release();
              }
            },
            options,
          );
        };
      }
      const value = Reflect.get(object, property, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

function assertBatchTaskRules(
  raw: Record<string, unknown>,
  batch: boolean,
  registry: Parameters<typeof readSetting>[0],
  settings: SettingsLike,
): void {
  if (!batch) {
    return;
  }
  if (readSetting(registry, settings, "task.batch") !== true) {
    throw new Error("task.batch is disabled in the main session.");
  }
  if (raw.cwd !== undefined) {
    throw new Error("For batch tasks, specify cwd in each tasks[] item.");
  }
  if (typeof raw.context !== "string" || !raw.context.trim()) {
    throw new Error("Batch tasks require a non-empty shared context.");
  }
  if (typeof raw.task === "string" && raw.task.trim()) {
    throw new Error("Put batch assignments in tasks[] rather than top-level task.");
  }
}

async function resolveTaskTargets(
  items: Record<string, unknown>[],
  sourceCwd: string,
  resolve: (path: string) => Promise<string>,
): Promise<string[]> {
  return await Promise.all(
    items.map(async (item) => {
      if (item.cwd !== undefined && (typeof item.cwd !== "string" || !item.cwd.trim())) {
        throw new Error("task.cwd must be a non-empty path.");
      }
      const requested = typeof item.cwd === "string" ? item.cwd : sourceCwd;
      return await resolve(requested);
    }),
  );
}

async function runTaskInvocation(
  deps: {
    id: string;
    signal?: AbortSignal;
    onUpdate: unknown;
    registry: Parameters<typeof readSetting>[0];
    scopes: Map<string, Promise<NativeTask>>;
    targets: string[];
    items: Record<string, unknown>[];
    raw: Record<string, unknown>;
    batch: boolean;
    snapshots: TaskResult[];
    merged: () => TaskResult;
    gate: Semaphore;
    preflights: Array<{ effectiveAgent: { blocking?: boolean } }>;
  },
  index: number,
): Promise<TaskResult> {
  const {
    id,
    signal,
    onUpdate,
    registry,
    scopes,
    targets,
    items,
    raw,
    batch,
    snapshots,
    merged,
    gate,
    preflights,
  } = deps;
  signal?.throwIfAborted();
  const task = await scopes.get(targets[index])!;
  const { cwd: _cwd, ...params } = items[index];
  const nativeParams = batch ? { context: raw.context, tasks: [params] } : params;
  const update =
    typeof onUpdate === "function" ? (onUpdate as (result: TaskResult) => void) : undefined;
  const inline =
    readSetting(registry, task.session.settings, "async.enabled") !== true ||
    !task.session.asyncJobManager ||
    preflights[index].effectiveAgent.blocking === true;
  if (inline) {
    await gate.acquire(signal);
  }
  let outcome: TaskResult;
  try {
    outcome = await task.execute(
      id,
      nativeParams,
      signal,
      update
        ? (result) => {
            snapshots[index] = decorateTaskResult(result, index);
            update(batch ? merged() : snapshots[index]);
          }
        : undefined,
    );
  } finally {
    if (inline) {
      gate.release();
    }
  }
  snapshots[index] = decorateTaskResult(outcome, index);
  return snapshots[index];
}

async function runBatchedInvocations(
  items: Record<string, unknown>[],
  limit: number,
  invoke: (index: number) => Promise<TaskResult>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: limit > 0 ? Math.min(limit, items.length) : items.length }, async () => {
      while (next < items.length) {
        const index = next++;
        await invoke(index);
      }
    }),
  );
}

function taskPreflightOptions(
  item: Record<string, unknown>,
  raw: Record<string, unknown>,
  batch: boolean,
  structured: boolean,
) {
  return {
    invocationKind: "task",
    assignment: item.task,
    context: batch ? raw.context : undefined,
    agent: item.agent,
    structured,
    ...(structured && Object.hasOwn(item, "outputSchema")
      ? { outputSchema: item.outputSchema }
      : {}),
    ...(structured && Object.hasOwn(item, "schemaMode") ? { schemaMode: item.schemaMode } : {}),
    effort: item.effort,
    ...(Object.hasOwn(item, "isolated") ? { isolation: { requested: item.isolated } } : {}),
  };
}

function decorateTaskResult(result: TaskResult, index: number): TaskResult {
  return {
    ...result,
    details: {
      ...result.details,
      results: result.details.results.map((value) => ({ ...value, index })),
      progress: result.details.progress?.map((value) => ({ ...value, index })),
    },
  };
}
function mergeTaskOutcomes(outcomes: TaskResult[], duration: number): TaskResult {
  const progress = outcomes.flatMap((outcome) => outcome.details.progress ?? []);
  const asyncStates = outcomes
    .map(
      (outcome) =>
        outcome.details.async as { state: string; jobId: string; type: string } | undefined,
    )
    .filter((value) => value !== undefined);
  const usages = outcomes
    .map(
      (outcome) =>
        outcome.details.usage as
          | { cost: Record<string, number>; [key: string]: unknown }
          | undefined,
    )
    .filter((value) => value !== undefined);
  const usage = aggregateUsage(usages);
  return {
    content: outcomes.flatMap((outcome) => outcome.content),
    isError: outcomes.some((outcome) => outcome.isError === true),
    details: {
      projectAgentsDir:
        outcomes.find((outcome) => outcome.details.projectAgentsDir)?.details.projectAgentsDir ??
        null,
      results: outcomes.flatMap((outcome) => outcome.details.results),
      totalDurationMs: duration,
      ...(usages.length ? { usage } : {}),
      outputPaths: outcomes.flatMap((outcome) => (outcome.details.outputPaths as string[]) ?? []),
      ...(progress.length ? { progress } : {}),
      ...(asyncStates.length ? { async: summarizeAsyncStates(asyncStates) } : {}),
    },
  };
}
