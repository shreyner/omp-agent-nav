import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveProjectIdentity } from "./navigation";
import { type RuntimeModules, type SessionLike, type SettingsLike } from "./types";

interface NativeSettings extends SettingsLike {
  getCwd(): string;
  overlay(values: Record<string, unknown>): NativeSettings;
}
interface MemorySession extends SessionLike {
  getMnemopiSessionState?(): MemoryState | undefined;
  isDisposed?: boolean;
  modelRegistry: unknown;
  prompt(text: string, options?: unknown): Promise<unknown>;
  settings: NativeSettings;
}
interface MemoryBackend {
  start(options: StartOptions): Promise<void>;
  [key: string]: unknown;
}
interface MemoryState {
  aliasOf?: MemoryState;
  config: { bank: string; autoRetain: boolean; [key: string]: unknown };
  dispose(options?: { retain?: boolean; consolidate?: boolean }): Promise<void>;
  getScopedRecallTargets(): Array<{ memory: { beam: { db: { filename: string } } } }>;
  getScopedRetainTarget(): { memory: { beam: { db: { filename: string } } } };
  globalMemory?: { beam: { db: { filename: string } } };
}
interface StartOptions {
  agentDir: string;
  modelRegistry: unknown;
  parentMnemopiSessionState?: MemoryState;
  session: MemorySession;
  settings: NativeSettings;
  taskDepth: number;
}

export interface MemoryBridge {
  close(session: SessionLike): Promise<void>;
  ensure(session: SessionLike, sourceCwd?: string): Promise<void>;
  getState(session: SessionLike): MemoryState | undefined;
}

// Process-wide like the host bridge: each subagent re-imports this module graph.
const MEMORY_BRIDGE = Symbol.for("omp-agent-nav.memory-bridge");

/** Own library resources independently of native session disposal, while sharing its public state. */
export async function installMemoryBridge(runtime: RuntimeModules): Promise<MemoryBridge> {
  const { AgentSession } = await runtime.importModule<{
    AgentSession: { prototype: { [MEMORY_BRIDGE]?: Promise<MemoryBridge> } };
  }>("session/agent-session.ts");
  const prototype = AgentSession.prototype;
  prototype[MEMORY_BRIDGE] ??= createMemoryBridge(runtime).catch((error) => {
    delete prototype[MEMORY_BRIDGE];
    throw error;
  });
  return await prototype[MEMORY_BRIDGE];
}

async function createMemoryBridge(runtime: RuntimeModules): Promise<MemoryBridge> {
  const [
    { mnemopiBackend },
    stateModule,
    configModule,
    embedModule,
    sessionModule,
    utils,
    registry,
  ] = await Promise.all([
    runtime.importLibraryModule<{ mnemopiBackend: MemoryBackend }>("mnemopi/backend.ts"),
    runtime.importLibraryModule<{
      getMnemopiSessionState(session: SessionLike): MemoryState | undefined;
      setMnemopiSessionState(
        session: SessionLike,
        state: MemoryState | undefined,
      ): MemoryState | undefined;
      getMnemopiScopedDbPaths(config: MemoryState["config"]): string[];
    }>("mnemopi/state.ts"),
    runtime.importLibraryModule<{
      computeMnemopiBankScope(
        prefix: string | undefined,
        cwd: string,
        scoping: string,
      ): { bank: string };
      loadMnemopiConfig(settings: NativeSettings, agentDir: string): MemoryState["config"];
    }>("mnemopi/config.ts"),
    runtime.importLibraryModule<{ mnemopiEmbedClient: { terminate(): Promise<void> } }>(
      "mnemopi/embed-client.ts",
    ),
    runtime.importModule<{ AgentSession: { prototype: MemorySession } }>(
      "session/agent-session.ts",
    ),
    runtime.importModule<{
      getAgentDir(): string;
      postmortem: { register(name: string, dispose: () => Promise<void>): unknown };
    }>("@oh-my-pi/pi-utils"),
    runtime.importModule<{
      lookup(id: string): { get(settings: SettingsLike): unknown } | undefined;
    }>("config/registry.ts"),
  ]);
  const originalStart = mnemopiBackend.start.bind(mnemopiBackend);
  const [{ resolveMemoryBackend }, { Settings }] = await Promise.all([
    runtime.importModule<{
      resolveMemoryBackend(settings: NativeSettings): Promise<MemoryBackend>;
    }>("memory-backend/resolve.ts"),
    runtime.importModule<{
      Settings: { isolated(values: Record<string, unknown>): NativeSettings };
    }>("config/settings.ts"),
  ]);
  const nativeBackend = await resolveMemoryBackend(
    Settings.isolated({ "memory.backend": "mnemopi" }),
  );
  const sharesClient = nativeBackend === mnemopiBackend;
  const nativeSlot = sharesClient
    ? undefined
    : await captureNativeStateSlot(nativeBackend, Settings, sessionModule.AgentSession.prototype);
  const pending = new WeakMap<SessionLike, Promise<void>>();
  const failures = new WeakMap<SessionLike, Error>();
  const targets = new WeakMap<SessionLike, string>();
  const hooked = new WeakSet<SessionLike>();
  const activeStates = new Map<SessionLike, MemoryState>();
  const ownedDisposers = new WeakSet<MemoryState>();
  let databaseTransition: Promise<unknown> = Promise.resolve();
  function withDatabaseTransition<T>(operation: () => Promise<T>): Promise<T> {
    const result = databaseTransition.then(operation);
    databaseTransition = result.catch(() => {});
    return result;
  }
  const getState = (session: SessionLike): MemoryState | undefined => {
    const state = stateModule.getMnemopiSessionState(session);
    return nativeSlot && (session as MemorySession).getMnemopiSessionState?.() !== state
      ? undefined
      : state;
  };
  const setState = (
    session: SessionLike,
    state: MemoryState | undefined,
  ): MemoryState | undefined => {
    if (nativeSlot) {
      const current = (session as unknown as Record<symbol, unknown>)[nativeSlot];
      if ((session as MemorySession).getMnemopiSessionState?.() !== current) {
        throw new Error("Mnemopi native state slot no longer agrees with the session getter.");
      }
      if (state) {
        (session as unknown as Record<symbol, unknown>)[nativeSlot] = state;
      } else {
        delete (session as unknown as Record<symbol, unknown>)[nativeSlot];
      }
      if ((session as MemorySession).getMnemopiSessionState?.() !== state) {
        throw new Error("Mnemopi state publication failed.");
      }
    }
    return stateModule.setMnemopiSessionState(session, state);
  };
  const detachState = (session: SessionLike): MemoryState | undefined => {
    // Native transitions may already have closed the state and removed their slot.
    const state = getState(session);
    setState(session, undefined);
    return state;
  };
  const read = (settings: SettingsLike, key: string) => registry.lookup(key)!.get(settings);
  const libraryCaches = new WeakMap<NativeSettings, unknown[]>();
  const librarySettingsForSession = new WeakMap<SessionLike, NativeSettings>();
  const librarySessions = new WeakMap<SessionLike, MemorySession>();

  function librarySettings(settings: NativeSettings, bankPath?: string): NativeSettings {
    let cache = libraryCaches.get(settings);
    if (!cache) {
      cache = [];
      libraryCaches.set(settings, cache);
    }
    return new Proxy(settings, {
      get(target, property) {
        // Derived.slot is module-local: source handles must never address the host's cache.
        if (!sharesClient && property === "valueCache") {
          return cache;
        }
        if (property === "getCwd" && bankPath) {
          return () => bankPath;
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  function librarySession(session: MemorySession): MemorySession {
    if (sharesClient) {
      return session;
    }
    let proxy = librarySessions.get(session);
    if (!proxy) {
      proxy = new Proxy(session, {
        get(target, property) {
          if (property === "settings") {
            return librarySettingsForSession.get(target) ?? librarySettings(target.settings);
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      librarySessions.set(session, proxy);
    }
    return proxy;
  }

  function libraryArgument(value: unknown): unknown {
    if (!value || typeof value !== "object") {
      return value;
    }
    const object = value as Record<string, unknown>;
    if (object.sessionManager && object.settings) {
      return librarySession(value as MemorySession);
    }
    if (typeof object.rawValue === "function" && object.valueCache) {
      return librarySettings(value as NativeSettings);
    }
    if (object.session) {
      return { ...object, session: librarySession(object.session as MemorySession) };
    }
    return value;
  }

  async function assertClearOwnership(session: MemorySession, agentDir: string): Promise<void> {
    const config =
      getState(session)?.config ??
      configModule.loadMnemopiConfig(librarySession(session).settings, agentDir);
    const canonical = (path: string) => fs.realpath(path).catch(() => resolve(path));
    const paths = new Set(
      await Promise.all(stateModule.getMnemopiScopedDbPaths(config).map(canonical)),
    );
    for (const [other, state] of activeStates) {
      if (other === session) {
        continue;
      }
      const memories = [
        state.getScopedRetainTarget().memory,
        ...state.getScopedRecallTargets().map((target) => target.memory),
        ...(state.globalMemory ? [state.globalMemory] : []),
      ];
      const overlap = (
        await Promise.all(memories.map((memory) => canonical(memory.beam.db.filename)))
      ).some((path) => paths.has(path));
      if (overlap) {
        throw new Error(
          "Cannot clear Mnemopi while another session owns a database in the selected memory scope.",
        );
      }
    }
  }

  function publishOwnedState(session: MemorySession, state: MemoryState): void {
    if (!ownedDisposers.has(state)) {
      ownedDisposers.add(state);
      const dispose = state.dispose.bind(state);
      const clearGlobalSlot = () => {
        if (stateModule.getMnemopiSessionState(session) === state) {
          stateModule.setMnemopiSessionState(session, undefined);
        }
      };
      const clearNativeSlot = () => {
        if (!(nativeSlot && session.getMnemopiSessionState?.() === state)) {
          return;
        }
        if ((session as unknown as Record<symbol, unknown>)[nativeSlot] !== state) {
          throw new Error("Mnemopi state ownership changed during disposal.");
        }
        delete (session as unknown as Record<symbol, unknown>)[nativeSlot];
      };
      state.dispose = async (options) => {
        try {
          clearGlobalSlot();
          clearNativeSlot();
          await dispose(options);
        } finally {
          if (activeStates.get(session) === state) {
            activeStates.delete(session);
          }
        }
      };
    }
    setState(session, state);
    activeStates.set(session, state);
  }

  function isChild(session: SessionLike): boolean {
    return runtime.host.AgentRegistry.global()
      .list()
      .some((ref) => ref.session === session && ref.kind !== "main");
  }

  function installGate(session: MemorySession): void {
    if (hooked.has(session)) {
      return;
    }
    hooked.add(session);
    const detach = session.agent.addBeforeModelCallHook(() => bridge.ensure(session));
    session.addDisposer(detach);
    session.addDisposer(() => {
      stateModule.setMnemopiSessionState(session, undefined);
      librarySettingsForSession.delete(session);
      targets.delete(session);
      failures.delete(session);
    });
  }

  async function startOwned(options: StartOptions, sourceCwd?: string): Promise<void> {
    const { session, settings } = options;
    const identity = await resolveProjectIdentity(runtime, sourceCwd ?? settings.getCwd());
    const child = options.taskDepth > 0 || isChild(session);
    const expected = configModule.computeMnemopiBankScope(
      read(settings, "mnemopi.bank") as string | undefined,
      identity.bankPath,
      read(settings, "mnemopi.scoping") as string,
    ).bank;
    const current = getState(session);
    if (
      current &&
      !current.aliasOf &&
      current.config.bank === expected &&
      (!child || !current.config.autoRetain)
    ) {
      targets.set(session, identity.bankPath);
      return;
    }
    // A cwd rebind must drain explicit writes without retaining the old transcript in the new bank.
    await detachState(session)?.dispose({ retain: false });
    const memorySettings = librarySettings(
      child ? settings.overlay({ "mnemopi.autoRetain": false }) : settings,
      identity.bankPath,
    );
    librarySettingsForSession.set(session, memorySettings);
    await syncCustomMemoryProviders(runtime, options.modelRegistry);
    await originalStart({
      ...options,
      session: librarySession(session),
      settings: memorySettings,
      taskDepth: 0,
      parentMnemopiSessionState: undefined,
    });
    const state = stateModule.getMnemopiSessionState(session);
    if (!state || state.aliasOf || state.config.bank !== expected) {
      stateModule.setMnemopiSessionState(session, undefined);
      await state?.dispose({ retain: false, consolidate: false });
      throw new Error(`Mnemopi startup failed for ${identity.cwd} (expected bank ${expected}).`);
    }
    publishOwnedState(session, state);
    if (session.isDisposed) {
      await detachState(session)?.dispose({ retain: false, consolidate: false });
      throw new Error("The session closed during Mnemopi startup.");
    }
    failures.delete(session);
    targets.set(session, identity.bankPath);
  }

  function launch(options: StartOptions, sourceCwd?: string): Promise<void> {
    installGate(options.session);
    const running = pending.get(options.session);
    if (running) {
      return running;
    }
    const promise = withDatabaseTransition(() => startOwned(options, sourceCwd))
      .catch((error) => {
        failures.set(options.session, error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        if (pending.get(options.session) === promise) {
          pending.delete(options.session);
        }
      });
    pending.set(options.session, promise);
    return promise;
  }

  const bridge: MemoryBridge = {
    async ensure(sessionLike, sourceCwd) {
      const session = sessionLike as MemorySession;
      installGate(session);
      if (read(session.settings, "memory.backend") !== "mnemopi") {
        return;
      }
      const running = pending.get(session);
      if (running) {
        await running;
      }
      const error = failures.get(session);
      if (error) {
        throw error;
      }
      const identity = await resolveProjectIdentity(
        runtime,
        sourceCwd ?? session.settings.getCwd(),
      );
      if (getState(session) && targets.get(session) === identity.bankPath) {
        return;
      }
      await launch(
        {
          session,
          settings: session.settings,
          modelRegistry: session.modelRegistry,
          agentDir: utils.getAgentDir(),
          taskDepth: isChild(session) ? 1 : 0,
        },
        sourceCwd,
      );
      const failure = failures.get(session);
      if (failure) {
        throw failure;
      }
    },
    async close(session) {
      await pending.get(session);
      await detachState(session)?.dispose({ retain: !isChild(session) });
      librarySettingsForSession.delete(session);
      targets.delete(session);
      failures.delete(session);
    },
    getState,
  };

  // SDK startup is fire-and-forget: record errors there and reject at the awaited prompt/model gate.
  nativeBackend.start = (options) => launch(options);
  // Native tools use the same owned library; native disposal only terminates its unused client.
  for (const [name, operation] of Object.entries(mnemopiBackend)) {
    if (name === "start" || typeof operation !== "function") {
      continue;
    }
    if (sharesClient && name !== "clear") {
      continue;
    }
    nativeBackend[name] = async (...args: unknown[]) => {
      const assertClearAllowed = async () => {
        if (name === "clear" && args[2]) {
          await assertClearOwnership(args[2] as MemorySession, args[0] as string);
        }
      };
      const publishClearState = () => {
        if (name !== "clear" || !args[2]) {
          return;
        }
        const session = args[2] as MemorySession;
        const state = stateModule.getMnemopiSessionState(session);
        if (state) {
          publishOwnedState(session, state);
        } else {
          setState(session, undefined);
        }
      };
      const run = async () => {
        await assertClearAllowed();
        const result = await operation.apply(mnemopiBackend, args.map(libraryArgument));
        publishClearState();
        return result;
      };
      return name === "clear" ? await withDatabaseTransition(run) : await run();
    };
  }
  const originalPrompt = sessionModule.AgentSession.prototype.prompt;
  sessionModule.AgentSession.prototype.prompt = async function (text, options) {
    await bridge.ensure(this);
    return originalPrompt.call(this, text, options);
  };
  const terminate = embedModule.mnemopiEmbedClient.terminate.bind(embedModule.mnemopiEmbedClient);
  let stopping = false;
  if (sharesClient) {
    embedModule.mnemopiEmbedClient.terminate = async () => {
      if (stopping) {
        await terminate();
      }
    };
  }
  utils.postmortem.register("omp-agent-nav-embedding", async () => {
    stopping = true;
    await terminate();
  });
  return bridge;
}
async function captureNativeStateSlot(
  backend: MemoryBackend,
  settingsFactory: { isolated(values: Record<string, unknown>): NativeSettings },
  prototype: MemorySession,
): Promise<symbol> {
  const temporary = await fs.mkdtemp(join(tmpdir(), "omp-nav-memory-slot-"));
  const settings = settingsFactory.isolated({
    "memory.backend": "mnemopi",
    "mnemopi.dbPath": join(temporary, "mnemopi.db"),
    "mnemopi.noEmbeddings": true,
    "mnemopi.llmMode": "none",
    "mnemopi.autoRecall": false,
    "mnemopi.autoRetain": false,
  });
  const probe = {
    sessionId: "omp-nav-memory-slot",
    settings,
    sessionManager: { getCwd: () => temporary, getBranch: () => [] },
    subscribe: () => () => {},
    getXdevToolEntries: () => [],
  } as unknown as MemorySession;
  let state: MemoryState | undefined;
  try {
    await backend.start({
      session: probe,
      settings,
      agentDir: temporary,
      modelRegistry: { getApiKeyForProvider: async () => undefined },
      taskDepth: 0,
    });
    state = prototype.getMnemopiSessionState?.call(probe);
    if (!state) {
      throw new Error("Cannot initialise the native Mnemopi state adapter.");
    }
    const slots = Object.getOwnPropertySymbols(probe).filter(
      (slot) => (probe as unknown as Record<symbol, unknown>)[slot] === state,
    );
    if (slots.length !== 1) {
      throw new Error("Native Mnemopi state ownership is ambiguous.");
    }
    delete (probe as unknown as Record<symbol, unknown>)[slots[0]];
    return slots[0];
  } finally {
    await state?.dispose({ retain: false, consolidate: false });
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function syncCustomMemoryProviders(
  runtime: RuntimeModules,
  modelRegistry: unknown,
): Promise<void> {
  if (runtime.mode === "source-test") {
    return;
  }
  const models =
    (modelRegistry as { getAll?(kind: string): Array<{ api: string }> }).getAll?.("all") ?? [];
  if (!models.length) {
    return;
  }
  const [nativeRegistry, ownedRegistry, ai] = await Promise.all([
    runtime.importModule<{ getCustomApi(api: string): unknown }>("@oh-my-pi/pi-ai/api-registry"),
    runtime.importLibraryModule<{
      registerCustomApi(api: string, stream: (...args: unknown[]) => unknown, source: string): void;
    }>("@oh-my-pi/pi-ai/api-registry"),
    runtime.importModule<{ streamSimple(...args: unknown[]): unknown }>("@oh-my-pi/pi-ai"),
  ]);
  for (const api of new Set(models.map((model) => model.api))) {
    if (nativeRegistry.getCustomApi(api)) {
      ownedRegistry.registerCustomApi(
        api,
        (...args) => ai.streamSimple(...args),
        "omp-agent-nav-memory",
      );
    }
  }
}
