import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { type SessionLike } from "../types";

export type GrantManager = SessionLike["sessionManager"] & {
  appendCustomEntry(customType: string, data: unknown): unknown;
  getEntries(): Array<{ type: string; customType?: string; data?: unknown }>;
  removeWorkspaceDirectory(directory: string): Promise<string | null>;
};

const GRANTS_ENTRY = "omp-agent-nav.workspace";

/** Directories the user started omp with: `--add-dir` and the start project's or global settings. */
export interface LaunchRoots {
  added: string[];
  configured: string[];
}

export class WorkspaceRollbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRollbackError";
  }
}

/** `~` and relative paths resolve like the host's `normalizeWorkspaceDirectory`, then realpath. */
export function canonicalDirectory(directory: string, base: string): string {
  const expanded =
    directory === "~" || directory.startsWith("~/")
      ? join(homedir(), directory.slice(1))
      : directory;
  const absolute = resolve(base, expanded);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Accepted roots are the start root and the extension's own grants (a session ledger entry). The
 * native additional-directory list is never read as a root: the host's settings watcher writes it
 * from whatever project the session enters, with relative values resolved against a moving cwd.
 * Grants come only from the user: approval dialogs, the directories omp was started with, and the
 * `/add-dir`/`/remove-dir` commands the user types (see the bridge's input hook).
 */
export class WorkspaceGrantState {
  initialCwd: string;
  #manager: GrantManager;
  #sessionId: string;
  #grants = new Set<string>();
  /** State the session just left, for a /new or fork that must inherit it (see `switched`). */
  #left?: { sessionId: string; initialCwd: string; grants: Set<string> };
  /** In-memory roots the ledger does not hold yet; `settle` writes them. */
  #dirty = false;

  constructor(manager: GrantManager, launch: LaunchRoots = { added: [], configured: [] }) {
    this.#manager = manager;
    this.#sessionId = manager.getSessionId();
    const saved = this.#saved();
    this.initialCwd = saved?.initialCwd ?? this.#canonical(manager.getCwd());
    // Start settings count only for a session without a ledger: a resumed session may sit in a
    // project the agent moved to, whose settings the user never approved.
    this.#grants = new Set(
      saved?.grants ?? launch.configured.map((directory) => this.#canonical(directory)),
    );
    for (const directory of launch.added) {
      const root = canonicalDirectory(directory, process.cwd());
      this.#dirty ||= saved !== undefined && !this.#grants.has(root);
      this.#grants.add(root);
    }
  }

  #canonical(directory: string): string {
    return canonicalDirectory(directory, this.#manager.getCwd());
  }

  /** The session's latest ledger entry. Grants are session-wide like the native workspace header. */
  #saved(): { initialCwd: string; grants: string[] } | undefined {
    const data = this.#manager
      .getEntries()
      .findLast((entry) => entry.type === "custom" && entry.customType === GRANTS_ENTRY)?.data as
      | { initialCwd?: unknown; grants?: unknown }
      | undefined;
    if (
      typeof data?.initialCwd !== "string" ||
      !Array.isArray(data.grants) ||
      !data.grants.every((item) => typeof item === "string")
    ) {
      return undefined;
    }
    return { initialCwd: data.initialCwd, grants: data.grants };
  }

  /** A switched session uses its own ledger; without one the user's roots carry over. */
  #checkSession(): void {
    if (this.#sessionId === this.#manager.getSessionId()) {
      return;
    }
    this.#sessionId = this.#manager.getSessionId();
    this.#left = {
      sessionId: this.#sessionId,
      initialCwd: this.initialCwd,
      grants: new Set(this.#grants),
    };
    const saved = this.#saved();
    if (saved) {
      this.initialCwd = saved.initialCwd;
      this.#grants = new Set(saved.grants);
    } else {
      this.#carry(this.#left);
    }
  }

  /** The previous start root becomes a grant; the current cwd is the new start. */
  #carry(left: { initialCwd: string; grants: Set<string> }): void {
    this.#grants = new Set([...left.grants, left.initialCwd]);
    this.initialCwd = this.#canonical(this.#manager.getCwd());
    this.#grants.delete(this.initialCwd);
    this.#dirty = true;
  }

  /**
   * The host told why the session changed. A /new or fork inherits the state it came from even
   * when the fork copied an older ledger entry: a revoke must not come back through a fork.
   */
  switched(reason: "new" | "resume" | "fork"): void {
    this.#checkSession();
    if (reason !== "resume" && this.#left?.sessionId === this.#sessionId) {
      this.#carry(this.#left);
    }
    this.#left = undefined;
  }

  /**
   * Writes roots the ledger does not hold yet — carried over by a session change or added by
   * `--add-dir` to a resumed session — so a later resume in another process sees them too.
   */
  async settle(): Promise<void> {
    this.#checkSession();
    if (this.#dirty) {
      await this.persist();
    }
  }

  /** Appends a ledger entry only when it differs from the session's latest one. */
  async persist(): Promise<void> {
    this.#checkSession();
    this.#dirty = false;
    const entry = { initialCwd: this.initialCwd, grants: [...this.#grants] };
    if (JSON.stringify(entry) === JSON.stringify(this.#saved() ?? null)) {
      return;
    }
    this.#manager.appendCustomEntry(GRANTS_ENTRY, entry);
    await this.#manager.flush();
  }

  roots(): string[] {
    this.#checkSession();
    return [...this.#grants];
  }

  /** Native additional directories as `[canonical, stored]`; native removal needs the stored form. */
  native(): [string, string][] {
    return this.#manager
      .getAdditionalDirectories()
      .map((directory) => [this.#canonical(directory), directory]);
  }

  /** Grants `directory` as the user typed it, resolved against the current cwd. */
  add(directory: string): string {
    this.#checkSession();
    const root = this.#canonical(directory);
    this.#grants.add(root);
    return root;
  }

  revoke(root: string): boolean {
    this.#checkSession();
    return this.#grants.delete(root);
  }
}
