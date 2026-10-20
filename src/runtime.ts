import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import { type HostNamespace, type RuntimeModules } from "./types";

export const SUPPORTED_OMP_VERSIONS: readonly string[] = [
  "18.11.0",
  "18.11.1",
  "18.11.2",
  "18.11.3",
  "18.12.0",
  "18.12.1",
  "18.12.2",
  "18.12.3",
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

// Process-wide: omp re-imports this module for every subagent session.
const WARNED_HOSTS = Symbol.for("omp-agent-nav.warned-hosts");
const processState = globalThis as { [WARNED_HOSTS]?: Set<string> };
processState[WARNED_HOSTS] ??= new Set<string>();
const warnedUnverifiedHosts = processState[WARNED_HOSTS];
function warnUnverifiedHost(version: string): void {
  if (!warnedUnverifiedHosts.has(version)) {
    warnedUnverifiedHosts.add(version);
    console.warn(
      `omp-agent-nav: host ${version} is newer than the verified matrix (${SUPPORTED_OMP_VERSIONS.join(", ")}); loading unverified.`,
    );
  }
}

export function findInstalledOmp(executable = Bun.which("omp")): string {
  const directory = locateInstalledOmp(executable);
  assertInstalledOmp(directory);
  return directory;
}

function readPackage(packageRoot: string): { name?: string; version?: string } {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
}

/** Package root of the omp on PATH, before any version gate. */
function locateInstalledOmp(executable: string | null): string {
  if (!executable) {
    throw new Error("omp-agent-nav requires the installed npm omp executable on PATH.");
  }
  let directory = dirname(realpathSync(executable));
  while (true) {
    if (
      existsSync(join(directory, "package.json")) &&
      readPackage(directory).name === "@oh-my-pi/pi-coding-agent"
    ) {
      return directory;
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

/** Returns the accepted package version. */
export function assertInstalledOmp(packageRoot: string): string {
  const manifest = readPackage(packageRoot);
  const status = versionStatus(manifest.version ?? "");
  if (manifest.name !== "@oh-my-pi/pi-coding-agent" || status === "rejected") {
    throw new Error(
      `omp-agent-nav supports @oh-my-pi/pi-coding-agent >= ${MIN_VERSION} and below ${NEXT_MAJOR_VERSION} (verified: ${SUPPORTED_OMP_VERSIONS.join(", ")}); found ${manifest.name ?? "unknown"} ${manifest.version ?? "unknown"}.`,
    );
  }
  if (status === "unverified") {
    warnUnverifiedHost(manifest.version ?? "");
  }
  return manifest.version ?? "";
}

// Literal imports are rewritten by omp's loader into its bundled module registry.
// Computed paths or file URLs would create a second graph with different session state.
export const hostedModules: Readonly<Record<string, () => Promise<unknown>>> = {
  "registry/agent-registry.ts": () => import("@oh-my-pi/pi-coding-agent/registry/agent-registry"),
  "session/agent-session.ts": () => import("@oh-my-pi/pi-coding-agent/session/agent-session"),
  "session/artifacts.ts": () => import("@oh-my-pi/pi-coding-agent/session/artifacts"),
  "config/all-settings.ts": () => import("@oh-my-pi/pi-coding-agent/config/all-settings"),
  "config/registry.ts": () => import("@oh-my-pi/pi-coding-agent/config/registry"),
  "cli/args.ts": () => import("@oh-my-pi/pi-coding-agent/cli/args"),
  "slash-commands/helpers/parse.ts": () =>
    import("@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse"),
  "tools/path-utils.ts": () => import("@oh-my-pi/pi-coding-agent/tools/path-utils"),
  "config/settings.ts": () => import("@oh-my-pi/pi-coding-agent/config/settings"),
  "capability/index.ts": () => import("@oh-my-pi/pi-coding-agent/capability"),
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
  "task/worktree.ts": () => import("@oh-my-pi/pi-coding-agent/task/worktree"),
  "tools/gh-pr-checkout.ts": () => import("@oh-my-pi/pi-coding-agent/tools/gh-pr-checkout"),
  "@oh-my-pi/pi-utils": () => import("@oh-my-pi/pi-utils"),
  "@oh-my-pi/pi-utils/dirs": () => import("@oh-my-pi/pi-utils"),
  "@oh-my-pi/pi-natives/vcs": () => import("@oh-my-pi/pi-natives/vcs"),
  "@oh-my-pi/pi-tui/tools/task": () => import("@oh-my-pi/pi-tui/tools/task"),
};

/**
 * Mnemopi is imported as a library from the omp on PATH; it must be the
 * running omp, not another installation (bunx, a second global install) that happens to be first.
 */
function hostPackageRoot(host: HostNamespace): string {
  const hostVersion = String(host.VERSION);
  const hostStatus = versionStatus(hostVersion);
  if (hostStatus === "rejected") {
    throw new Error(
      `omp-agent-nav needs host version >= ${MIN_VERSION} and below ${NEXT_MAJOR_VERSION}; found ${hostVersion}.`,
    );
  }
  if (hostStatus === "unverified") {
    warnUnverifiedHost(hostVersion);
  }
  const packageRoot = locateInstalledOmp(Bun.which("omp"));
  const installed = readPackage(packageRoot).version;
  if (installed !== hostVersion) {
    throw new Error(
      `omp-agent-nav loads Mnemopi from the omp on PATH (${installed ?? "unknown"} at ${packageRoot}), which differs from the running omp ${hostVersion}. Put the running installation first on PATH.`,
    );
  }
  return packageRoot;
}

export function createRuntime(host: HostNamespace, sourceTestRoot?: string): RuntimeModules {
  const packageRoot = sourceTestRoot ?? hostPackageRoot(host);
  assertInstalledOmp(packageRoot);
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
