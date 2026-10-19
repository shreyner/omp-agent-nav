import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { type SessionLike } from "../types";

export type GrantManager = SessionLike["sessionManager"] & {
  getBranch(): Array<{ type: string; customType?: string; data?: unknown }>;
  appendCustomEntry(customType: string, data: unknown): unknown;
  removeWorkspaceDirectory(directory: string): Promise<string | null>;
};

const GRANTS_ENTRY = "omp-agent-nav.workspace";

interface SavedGrants {
  grants: string[];
  initialCwd: string;
  untrusted?: string[];
}

export class WorkspaceRollbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRollbackError";
  }
}

/**
 * Accepted roots are the extension's own grants (a session ledger entry, per branch) plus the live
 * native additional directories the user added (`--add-dir`, `/add-dir`). Grants never enter the
 * native list, so the host does not load their AGENTS into the prompt.
 *
 * The host's settings watcher also writes the native list: on a move it adds the target project's
 * `workspace.additionalDirectories`, which the user never approved. Those dirs are excluded twice:
 * while the current settings name them, and — because the watcher cannot always remove a relative
 * entry after the cwd changed — through the `untrusted` set recorded at each move. Only the native
 * list at process start (`--add-dir`, the start project's and global settings) seeds the ledger.
 */
export class WorkspaceGrantState {
  initialCwd: string;
  #manager: GrantManager;
  #configured: () => string[];
  #sessionId: string;
  #grants = new Set<string>();
  /** Grants the current session started with; tree navigation before any entry returns to them. */
  #seed = new Set<string>();
  #untrusted = new Set<string>();

  constructor(manager: GrantManager, configured: () => string[] = () => []) {
    this.#manager = manager;
    this.#configured = configured;
    this.#sessionId = manager.getSessionId();
    this.initialCwd = manager.getCwd();
    this.#start(this.native());
  }

  #canonical(directory: string): string {
    const expanded =
      directory === "~" || directory.startsWith("~/")
        ? join(homedir(), directory.slice(1))
        : directory;
    const absolute = resolve(this.#manager.getCwd(), expanded);
    try {
      return realpathSync(absolute);
    } catch {
      return absolute;
    }
  }

  /** Last ledger entry on the current branch (tree navigation can change the branch). */
  #saved(): SavedGrants | undefined {
    const saved = this.#manager
      .getBranch()
      .findLast((entry) => entry.type === "custom" && entry.customType === GRANTS_ENTRY)?.data as
      | { initialCwd?: unknown; grants?: unknown; untrusted?: unknown }
      | undefined;
    const strings = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((item) => typeof item === "string");
    if (typeof saved?.initialCwd !== "string" || !strings(saved.grants)) {
      return undefined;
    }
    return {
      initialCwd: saved.initialCwd,
      grants: saved.grants,
      untrusted: strings(saved.untrusted) ? saved.untrusted : [],
    };
  }

  /** A session (re)starts from its ledger, or from `seed` when it has none yet. */
  #start(seed: [string, string][]): void {
    this.#seed = new Set(seed.map(([root]) => root));
    const saved = this.#saved();
    this.initialCwd = saved?.initialCwd ?? this.#canonical(this.#manager.getCwd());
    this.#apply(saved);
  }

  #apply(saved: SavedGrants | undefined): void {
    this.#grants = new Set(saved?.grants ?? this.#seed);
    for (const root of saved?.untrusted ?? []) {
      this.#untrusted.add(root);
    }
  }

  #checkSession(): void {
    if (this.#sessionId === this.#manager.getSessionId()) {
      return;
    }
    this.#sessionId = this.#manager.getSessionId();
    // A session switch (/new, /resume, fork) is not a process start: the native list may already
    // hold the current project's settings, so only roots the user added seed it.
    this.#start(this.trustedNative());
  }

  /** Tree navigation moved the leaf: the branch's ledger entry, or the session's seed, applies. */
  reloadBranch(): void {
    this.#checkSession();
    this.#apply(this.#saved());
  }

  /**
   * Captures the start root and grants; the returned function restores them after a rollback.
   * The untrusted set only grows: dirs a failed move's settings named stay excluded.
   */
  snapshot(): () => void {
    const initialCwd = this.initialCwd;
    const grants = new Set(this.#grants);
    return () => {
      this.#sessionId = this.#manager.getSessionId();
      this.initialCwd = initialCwd;
      this.#grants = grants;
    };
  }

  /** Appends a ledger entry only when it differs from the branch's last one. */
  async persist(): Promise<void> {
    this.#checkSession();
    const entry: SavedGrants = {
      initialCwd: this.initialCwd,
      grants: [...this.#grants],
      untrusted: [...this.#untrusted],
    };
    if (JSON.stringify(entry) === JSON.stringify(this.#saved() ?? null)) {
      return;
    }
    this.#manager.appendCustomEntry(GRANTS_ENTRY, entry);
    await this.#manager.flush();
  }

  /** The extension's own grants. */
  ledger(): string[] {
    this.#checkSession();
    return [...this.#grants];
  }

  /** Native additional directories as `[canonical, stored]`; native removal needs the stored form. */
  native(): [string, string][] {
    return this.#manager
      .getAdditionalDirectories()
      .map((directory) => [this.#canonical(directory), directory]);
  }

  /** Native roots the user added: without dirs settings named at a move or name right now. */
  trustedNative(): [string, string][] {
    const configured = new Set(this.#configured().map((directory) => this.#canonical(directory)));
    return this.native().filter(([root]) => !configured.has(root) && !this.#untrusted.has(root));
  }

  /**
   * Records the dirs the settings of the cwd just entered name. The host resolves them against
   * that cwd, as done here, and may fail to remove a relative one once the cwd changes again.
   */
  distrustConfigured(): boolean {
    const before = this.#untrusted.size;
    for (const directory of this.#configured()) {
      this.#untrusted.add(this.#canonical(directory));
    }
    return this.#untrusted.size > before;
  }

  roots(): string[] {
    return [...new Set([...this.ledger(), ...this.trustedNative().map(([root]) => root)])];
  }

  add(root: string): void {
    this.#checkSession();
    this.#grants.add(this.#canonical(root));
  }

  revoke(root: string): boolean {
    this.#checkSession();
    return this.#grants.delete(root);
  }
}
