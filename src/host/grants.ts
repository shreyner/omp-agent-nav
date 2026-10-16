import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { type SessionLike } from "../types";

export type GrantManager = SessionLike["sessionManager"] & {
  getBranch(): Array<{ type: string; customType?: string; data?: unknown }>;
  appendCustomEntry(customType: string, data: unknown): unknown;
  addWorkspaceDirectory(directory: string): Promise<string | null>;
  removeWorkspaceDirectory(directory: string): Promise<string | null>;
  setAdditionalDirectories(directories: string[]): Promise<void>;
};

const GRANTS_ENTRY = "omp-agent-nav.workspace";

export class WorkspaceRollbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRollbackError";
  }
}

/** Native moveTo omits the current root; acceptance must survive that presentation change. */
export class WorkspaceGrantState {
  initialCwd: string;
  #manager: GrantManager;
  #sessionId: string;
  #grants = new Set<string>();
  #transition = new AsyncLocalStorage<boolean>();
  #setDirectories: GrantManager["setAdditionalDirectories"];

  constructor(manager: GrantManager) {
    this.#manager = manager;
    this.#sessionId = manager.getSessionId();
    this.initialCwd = manager.getCwd();
    this.#setDirectories = manager.setAdditionalDirectories.bind(manager);
    this.#restore();
    const add = manager.addWorkspaceDirectory.bind(manager);
    const remove = manager.removeWorkspaceDirectory.bind(manager);
    manager.addWorkspaceDirectory = async (directory) => {
      this.#checkSession();
      const added = await add(directory);
      if (!this.#transition.getStore()) {
        this.#grants.add(this.#canonical(added ?? directory));
        await this.#persist();
      }
      return added;
    };
    manager.removeWorkspaceDirectory = async (directory) => {
      this.#checkSession();
      const canonical = this.#canonical(directory);
      const removed = await remove(directory);
      if (!this.#transition.getStore()) {
        const accepted = this.#grants.delete(canonical);
        await this.#persist();
        return removed ?? (accepted ? canonical : null);
      }
      return removed;
    };
    manager.setAdditionalDirectories = async (directories) => {
      this.#checkSession();
      await this.#setDirectories(directories);
      if (!this.#transition.getStore()) {
        this.#grants = new Set(directories.map((directory) => this.#canonical(directory)));
        await this.#persist();
      }
    };
  }

  #canonical(directory: string): string {
    const absolute = resolve(this.#manager.getCwd(), directory);
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

  #restore(): void {
    const saved = this.#manager
      .getBranch()
      .findLast((entry) => entry.type === "custom" && entry.customType === GRANTS_ENTRY)?.data as
      | { initialCwd?: unknown; grants?: unknown }
      | undefined;
    if (
      typeof saved?.initialCwd === "string" &&
      Array.isArray(saved.grants) &&
      saved.grants.every((item) => typeof item === "string")
    ) {
      this.initialCwd = saved.initialCwd;
      this.#grants = new Set(saved.grants as string[]);
    } else {
      this.initialCwd = this.#canonical(this.#manager.getCwd());
      this.#grants = new Set(
        this.#manager.getAdditionalDirectories().map((directory) => this.#canonical(directory)),
      );
    }
  }

  async #persist(): Promise<void> {
    this.#manager.appendCustomEntry(GRANTS_ENTRY, {
      initialCwd: this.initialCwd,
      grants: [...this.#grants],
    });
    await this.#manager.flush();
  }

  roots(): string[] {
    this.#checkSession();
    return [...this.#grants];
  }

  async synchronize(): Promise<void> {
    await this.#setDirectories([...this.#grants]);
    await this.#persist();
  }

  async withTransition<T>(operation: () => Promise<T>): Promise<T> {
    this.#checkSession();
    return await this.#transition.run(true, operation);
  }
}
