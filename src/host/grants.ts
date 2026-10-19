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
 * Native roots that the current settings configure (`workspace.additionalDirectories`) are not
 * accepted live: after a move those come from the target project's config, which the user never
 * approved. The roots present when the session starts — `--add-dir` and the start project's or
 * global settings — seed the ledger instead.
 */
export class WorkspaceGrantState {
  initialCwd: string;
  #manager: GrantManager;
  #configured: () => string[];
  #sessionId: string;
  #grants = new Set<string>();

  constructor(manager: GrantManager, configured: () => string[] = () => []) {
    this.#manager = manager;
    this.#configured = configured;
    this.#sessionId = manager.getSessionId();
    this.initialCwd = manager.getCwd();
    this.#restore();
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

  #checkSession(): void {
    if (this.#sessionId === this.#manager.getSessionId()) {
      return;
    }
    this.#sessionId = this.#manager.getSessionId();
    this.#restore();
  }

  /** Last ledger entry on the current branch (tree navigation can change the branch). */
  #saved(): unknown {
    return this.#manager
      .getBranch()
      .findLast((entry) => entry.type === "custom" && entry.customType === GRANTS_ENTRY)?.data;
  }

  #restore(): void {
    const saved = this.#saved() as { initialCwd?: unknown; grants?: unknown } | undefined;
    if (
      typeof saved?.initialCwd === "string" &&
      Array.isArray(saved.grants) &&
      saved.grants.every((item) => typeof item === "string")
    ) {
      this.initialCwd = saved.initialCwd;
      this.#grants = new Set(saved.grants as string[]);
    } else {
      this.initialCwd = this.#canonical(this.#manager.getCwd());
      this.#grants = new Set(this.native().map(([root]) => root));
    }
  }

  /**
   * Re-reads the ledger after a rollback restored the session entries. With no entry written yet
   * the start root stays the one already known: the cwd may have moved through native /move.
   */
  reload(): void {
    const initial = this.initialCwd;
    this.#sessionId = this.#manager.getSessionId();
    this.#restore();
    if (this.#saved() === undefined) {
      this.initialCwd = initial;
    }
  }

  /** Appends a ledger entry only when it differs from the branch's last one. */
  async persist(): Promise<void> {
    this.#checkSession();
    const entry = { initialCwd: this.initialCwd, grants: [...this.#grants] };
    if (JSON.stringify(entry) === JSON.stringify(this.#saved())) {
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

  /** Native roots the user added, without those the current settings configure. */
  trustedNative(): [string, string][] {
    const configured = new Set(this.#configured().map((directory) => this.#canonical(directory)));
    return this.native().filter(([root]) => !configured.has(root));
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
