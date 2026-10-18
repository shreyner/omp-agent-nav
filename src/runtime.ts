import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import { type HostNamespace, type RuntimeModules, type SessionLike } from "./types";

export const SUPPORTED_OMP_VERSIONS: readonly string[] = [
  "18.11.0",
  "18.11.1",
  "18.11.2",
  "18.11.3",
  "18.12.0",
  "18.12.1",
];
// Политика версий (2026-10-18): принимаем любой хост >= floor в том же major,
// что и последняя проверенная версия; непроверенные грузятся с warning,
// ниже floor / следующий major / не-semver — отказ.
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const MIN_VERSION = SUPPORTED_OMP_VERSIONS[0] ?? "";
const NEXT_MAJOR = Number(SUPPORTED_OMP_VERSIONS.at(-1)?.split(".")[0]) + 1;
const NEXT_MAJOR_VERSION = `${NEXT_MAJOR}.0.0`;

function versionRank(version: string): number | null {
  const match = VERSION_PATTERN.exec(version);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 1_000_000 + Number(match[2]) * 1_000 + Number(match[3]);
}

function versionStatus(version: string): "verified" | "unverified" | "rejected" {
  if (SUPPORTED_OMP_VERSIONS.includes(version)) {
    return "verified";
  }
  const rank = versionRank(version);
  const floor = versionRank(MIN_VERSION);
  if (rank === null || floor === null || rank < floor || rank >= NEXT_MAJOR * 1_000_000) {
    return "rejected";
  }
  return "unverified";
}

let warnedUnverifiedHost = false;
function warnUnverifiedHost(version: string): void {
  if (!warnedUnverifiedHost) {
    warnedUnverifiedHost = true;
    console.warn(
      `omp-agent-nav: host ${version} is newer than the verified matrix (${SUPPORTED_OMP_VERSIONS.join(", ")}); loading unverified.`,
    );
  }
}

export function findInstalledOmp(executable = Bun.which("omp")): string {
  if (!executable) {
    throw new Error("omp-agent-nav requires the installed npm omp executable on PATH.");
  }
  let directory = dirname(realpathSync(executable));
  while (true) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const metadata = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (metadata.name === "@oh-my-pi/pi-coding-agent") {
        assertInstalledOmp(directory);
        return directory;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new Error(
    "The omp executable is not inside the npm @oh-my-pi/pi-coding-agent package. Install the supported npm package.",
  );
}

export function assertInstalledOmp(packageRoot: string): void {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
  };
  const status = versionStatus(manifest.version ?? "");
  if (manifest.name !== "@oh-my-pi/pi-coding-agent" || status === "rejected") {
    throw new Error(
      `omp-agent-nav supports @oh-my-pi/pi-coding-agent >= ${MIN_VERSION} and below ${NEXT_MAJOR_VERSION} (verified: ${SUPPORTED_OMP_VERSIONS.join(", ")}); found ${manifest.name ?? "unknown"} ${manifest.version ?? "unknown"}.`,
    );
  }
  if (status === "unverified") {
    warnUnverifiedHost(manifest.version ?? "");
  }
}

// Literal imports are rewritten by omp's loader into its bundled module registry.
// Computed paths or file URLs would create a second graph with different session state.
const hostedModules: Record<string, () => Promise<unknown>> = {
  "registry/agent-registry.ts": () => import("@oh-my-pi/pi-coding-agent/registry/agent-registry"),
  "session/agent-session.ts": () => import("@oh-my-pi/pi-coding-agent/session/agent-session"),
  "session/session-tools.ts": () => import("@oh-my-pi/pi-coding-agent/session/session-tools"),
  "session/session-manager.ts": () => import("@oh-my-pi/pi-coding-agent/session/session-manager"),
  "session/artifacts.ts": () => import("@oh-my-pi/pi-coding-agent/session/artifacts"),
  "config/all-settings.ts": () => import("@oh-my-pi/pi-coding-agent/config/all-settings"),
  "config/registry.ts": () => import("@oh-my-pi/pi-coding-agent/config/registry"),
  "config/settings.ts": () => import("@oh-my-pi/pi-coding-agent/config/settings"),
  "capability/index.ts": () => import("@oh-my-pi/pi-coding-agent/capability"),
  "capability/context-file.ts": () => import("@oh-my-pi/pi-coding-agent/capability/context-file"),
  "capability/system-prompt.ts": () => import("@oh-my-pi/pi-coding-agent/capability/system-prompt"),
  "cli/args.ts": () => import("@oh-my-pi/pi-coding-agent/cli/args"),
  "discovery/helpers.ts": () => import("@oh-my-pi/pi-coding-agent/discovery/helpers"),
  "extensibility/settings.ts": () => import("@oh-my-pi/pi-coding-agent/extensibility/settings"),
  "hindsight/backend.ts": () => import("@oh-my-pi/pi-coding-agent/hindsight/backend"),
  "memory-backend/resolve.ts": () => import("@oh-my-pi/pi-coding-agent/memory-backend/resolve"),
  "mcp/config.ts": () => import("@oh-my-pi/pi-coding-agent/mcp/config"),
  "mcp/manager.ts": () => import("@oh-my-pi/pi-coding-agent/mcp/manager"),
  "task/index.ts": () => import("@oh-my-pi/pi-coding-agent/task"),
  "task/output-manager.ts": () => import("@oh-my-pi/pi-coding-agent/task/output-manager"),
  "task/types.ts": () => import("@oh-my-pi/pi-coding-agent/task/types"),
  "task/parallel.ts": () => import("@oh-my-pi/pi-coding-agent/task/parallel"),
  "task/structured-subagent.ts": () => import("@oh-my-pi/pi-coding-agent/task/structured-subagent"),
  "task/spawn-policy.ts": () => import("@oh-my-pi/pi-coding-agent/task/spawn-policy"),
  "task/prompt-policy.ts": () => import("@oh-my-pi/pi-coding-agent/task/prompt-policy"),
  "irc/messaging.ts": () => import("@oh-my-pi/pi-coding-agent/irc/messaging"),
  "tools/report-tool-issue.ts": () => import("@oh-my-pi/pi-coding-agent/tools/report-tool-issue"),
  "tools/xdev.ts": () => import("@oh-my-pi/pi-coding-agent/tools/xdev"),
  "internal-urls/router.ts": () => import("@oh-my-pi/pi-coding-agent/internal-urls/router"),
  "utils/active-repo-context.ts": () =>
    import("@oh-my-pi/pi-coding-agent/utils/active-repo-context"),
  "task/worktree.ts": () => import("@oh-my-pi/pi-coding-agent/task/worktree"),
  "tools/gh-pr-checkout.ts": () => import("@oh-my-pi/pi-coding-agent/tools/gh-pr-checkout"),
  "@oh-my-pi/pi-utils": () => import("@oh-my-pi/pi-utils"),
  "@oh-my-pi/pi-utils/dirs": () => import("@oh-my-pi/pi-utils"),
  "@oh-my-pi/pi-natives/vcs": () => import("@oh-my-pi/pi-natives/vcs"),
  "@oh-my-pi/omptype/typebox": () => import("@sinclair/typebox"),
  "@oh-my-pi/pi-ai": () => import("@oh-my-pi/pi-ai"),
  "@oh-my-pi/pi-ai/api-registry": () => import("@oh-my-pi/pi-ai/api-registry"),
};

export function createRuntime(host: HostNamespace, sourceTestRoot?: string): RuntimeModules {
  const packageRoot = sourceTestRoot ?? findInstalledOmp();
  assertInstalledOmp(packageRoot);
  if (!sourceTestRoot) {
    const hostStatus = versionStatus(String(host.VERSION));
    if (hostStatus === "rejected") {
      throw new Error(
        `omp-agent-nav needs host version >= ${MIN_VERSION} and below ${NEXT_MAJOR_VERSION}; found ${String(host.VERSION)}.`,
      );
    }
    if (hostStatus === "unverified") {
      warnUnverifiedHost(String(host.VERSION));
    }
  }
  const libraryImport = async <T>(specifier: string): Promise<T> => {
    const target = specifier.startsWith("@")
      ? Bun.resolveSync(specifier, packageRoot)
      : isAbsolute(specifier)
        ? specifier
        : join(packageRoot, "src", specifier);
    return (await import(pathToFileURL(target).href)) as T;
  };
  return {
    packageRoot,
    host,
    mode: sourceTestRoot ? "source-test" : "host",
    async importModule<T>(specifier: string): Promise<T> {
      if (sourceTestRoot) {
        return await libraryImport<T>(specifier);
      }
      // /sdk is a catch-all fallback into source; the root host exposes the actual SDK.
      if (specifier === "sdk.ts") {
        return host as T;
      }
      const load = hostedModules[specifier];
      if (!load) {
        throw new Error(
          `Unsupported hosted omp module: ${specifier}. A source-state fallback is not permitted.`,
        );
      }
      return (await load()) as T;
    },
    async importLibraryModule<T>(specifier: string): Promise<T> {
      if (
        !sourceTestRoot &&
        ![
          "mnemopi/backend.ts",
          "mnemopi/state.ts",
          "mnemopi/config.ts",
          "mnemopi/embed-client.ts",
          "system-prompt.ts",
          "internal-urls/router.ts",
          "@oh-my-pi/pi-utils",
          "@oh-my-pi/pi-ai/api-registry",
        ].includes(specifier)
      ) {
        throw new Error(`Unsupported extension-owned omp library: ${specifier}.`);
      }
      return await libraryImport<T>(specifier);
    },
  };
}

export async function readSetting(
  runtime: Pick<RuntimeModules, "importModule">,
  settings: unknown,
  id: string,
): Promise<unknown> {
  await runtime.importModule("config/all-settings.ts");
  const registry = await runtime.importModule<{
    lookup(id: string): { get(settings: unknown): unknown } | undefined;
  }>("config/registry.ts");
  const setting = registry.lookup(id);
  if (!setting) {
    throw new Error(`Unknown omp setting: ${id}`);
  }
  return setting.get(settings);
}

/** Additional roots grant access; their instruction files must not become the selected project's rules. */
export async function installInstructionScope(runtime: RuntimeModules): Promise<void> {
  const [{ contextFileCapability }, { SessionTools }, { AgentSession }] = await Promise.all([
    runtime.importModule<{
      contextFileCapability: { providers: Array<{ load(ctx: { cwd: string }): Promise<unknown> }> };
    }>("capability/context-file.ts"),
    runtime.importModule<{
      SessionTools: {
        prototype: {
          runToolRegistryMutation(
            mutation: () => Promise<unknown>,
            signal?: AbortSignal,
          ): Promise<unknown>;
        };
      };
    }>("session/session-tools.ts"),
    runtime.importModule<{
      AgentSession: {
        prototype: SessionLike & { prompt(...args: [string, unknown?]): Promise<unknown> };
      };
    }>("session/agent-session.ts"),
  ]);
  const scope = new AsyncLocalStorage<SessionLike>();
  const owners = new WeakMap<object, SessionLike>();
  const bound = new WeakSet<object>();
  const wrapped = new WeakSet<object>();
  const canonical = (directory: string) => {
    try {
      return realpathSync(directory);
    } catch {
      return directory;
    }
  };
  const wrapProviders = () => {
    for (const provider of contextFileCapability.providers) {
      if (wrapped.has(provider)) {
        continue;
      }
      wrapped.add(provider);
      const load = provider.load;
      provider.load = async function (ctx) {
        const owner = scope.getStore();
        if (owner && canonical(ctx.cwd) !== canonical(owner.sessionManager.getCwd())) {
          return { items: [] };
        }
        return await load.call(this, ctx);
      };
    }
  };
  wrapProviders();
  const tools = SessionTools.prototype;
  const mutate = tools.runToolRegistryMutation;
  tools.runToolRegistryMutation = async function (mutation, signal) {
    const owner = scope.getStore() ?? owners.get(this);
    if (owner) {
      owners.set(this, owner);
    }
    wrapProviders();
    return await mutate.call(this, () => (owner ? scope.run(owner, mutation) : mutation()), signal);
  };
  const sessions = AgentSession.prototype;
  const refresh = sessions.refreshBaseSystemPrompt;
  sessions.refreshBaseSystemPrompt = async function (commitIf) {
    await scope.run(this, () => refresh.call(this, commitIf));
    bound.add(this);
  };
  const prompt = sessions.prompt;
  sessions.prompt = async function (...args) {
    // Bind before native memory injection so its own rebuild retains recall and the selected scope.
    if (!bound.has(this)) {
      await this.refreshBaseSystemPrompt();
    }
    return await prompt.apply(this, args);
  };
}
