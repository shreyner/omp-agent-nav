import { readSetting } from "../runtime";
import { findNativeToolSession, mcpStartupWait } from "../task";
import { type RuntimeModules, type SessionLike } from "../types";

interface ScopedMcp {
  cwd: string;
  disconnectAll(): Promise<void>;
  discoverAndConnect(
    options: Record<string, unknown>,
  ): Promise<{ tools: unknown[]; errors: Map<string, string> }>;
  getTools(): unknown[];
  setNotificationsEnabled(enabled: boolean): void;
  waitForStartup(
    timeout: number,
  ): Promise<{ failed: Array<{ name: string; error: string }>; pending: string[] }>;
}

export interface RescopableSession extends SessionLike {
  getActiveToolNames(): string[];
  getToolByName(name: string): unknown;
  refreshMCPTools(tools: unknown[]): Promise<void>;
}

/**
 * `strict: false` is for restoring the previous project after a failed move: flaky servers are
 * logged and the tools that did start are published, as native startup does.
 */
export async function rescopeProjectMcp(
  runtime: RuntimeModules,
  session: SessionLike,
  cwd: string,
  strict = true,
): Promise<void> {
  const native = findNativeToolSession(session);
  if (native.enableMCP === false) {
    return;
  }
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
    const detail = `MCP startup failed for ${cwd}: ${JSON.stringify({ errors: [...result.errors], ...startup })}`;
    if (strict) {
      throw new Error(detail);
    }
    process.stderr.write(`omp-agent-nav: ${detail}\n`);
  }
  await active.refreshMCPTools(manager.getTools());
}
