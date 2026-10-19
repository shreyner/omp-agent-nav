import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import { readSetting } from "./runtime";

export interface NavigationRuntime {
  importModule<T>(specifier: string): Promise<T>;
}

interface GitInfo {
  commonDir: string;
  gitDir: string;
  gitEntryPath: string;
  repoRoot: string;
}

interface NativeWorktree {
  branch?: string;
  detached: boolean;
  head?: string;
  path: string;
}

interface GitRepository {
  createBranch(branch: string, ref: string, force: boolean): Promise<unknown>;
  currentBranch(): Promise<string | null | undefined>;
  deleteBranch(branch: string, force: boolean): Promise<boolean>;
  info(): GitInfo;
  linkedWorktree(): { root: string; primaryRoot: string } | null;
  primaryRoot(): string;
  refExists(ref: string): Promise<boolean>;
  resolveRef(ref: string): Promise<string | null | undefined>;
  statusPorcelain(options: { untracked: string; nulTerminated?: boolean }): Promise<string>;
  worktreeAdd(
    target: string,
    ref: string,
    options: { detach: boolean; clone: boolean; backend?: unknown; keepChanges: boolean },
  ): Promise<{ clonedWith?: unknown; cloneError?: string }>;
  worktreeRemove(target: string, force: boolean): Promise<boolean>;
  worktrees(): Promise<NativeWorktree[]>;
}

interface NativeVcs {
  git(cwd: string): GitRepository | null;
  isPureJj(cwd: string): boolean;
}

export interface ProjectIdentity {
  bankPath: string;
  commonDir?: string;
  cwd: string;
  isWorktree: boolean;
  mainRoot: string;
  root: string;
}

export interface NavigationOptions {
  getCwd(): string;
  getLiveAgentCwds(): readonly string[];
  getSettings(): { flush?(): Promise<void> };
  getWorkspaceRoots(): readonly string[];
  initialCwd: string;
}

export interface WorktreeState {
  available: boolean;
  branch?: string;
  detached: boolean;
  dirty: boolean | null;
  head?: string;
  inUse: boolean;
  locked: boolean;
  path: string;
  primary: boolean;
  untracked: boolean | null;
}

export class NavigationError extends Error {
  constructor(
    readonly code: "invalid" | "unavailable" | "permission" | "conflict" | "git" | "busy",
    message: string,
    readonly suggestedGrants?: string[],
  ) {
    super(`${code}: ${message}`);
    this.name = "NavigationError";
  }
}

export function pathIsWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function expandPath(input: string, base: string): string {
  if (typeof input !== "string" || !input.trim() || input.includes("\0")) {
    throw new NavigationError("invalid", "A non-empty path is required.");
  }
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith("~/")) {
    return path.resolve(homedir(), input.slice(2));
  }
  if (input.startsWith("~")) {
    throw new NavigationError("invalid", "Only ~ and ~/ paths are supported.");
  }
  return path.resolve(base, input);
}

function notFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function existingDirectory(target: string): Promise<string> {
  try {
    const canonical = await fs.realpath(target);
    if (!(await fs.stat(canonical)).isDirectory()) {
      throw new NavigationError("unavailable", `Not a directory: ${target}`);
    }
    return canonical;
  } catch (error) {
    if (error instanceof NavigationError) {
      throw error;
    }
    throw new NavigationError("unavailable", `Cannot open directory ${target}: ${String(error)}`);
  }
}

// Resolve missing suffixes without accepting a dangling symlink as an absent directory.
async function futureDirectory(target: string): Promise<string> {
  let ancestor = target;
  const suffix: string[] = [];
  while (true) {
    try {
      const stat = await fs.lstat(ancestor);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) {
        throw new NavigationError("conflict", `Not a directory: ${ancestor}`);
      }
      return path.join(await existingDirectory(ancestor), ...suffix.reverse());
    } catch (error) {
      if (!notFound(error)) {
        throw error;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      suffix.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function resolveProjectIdentity(
  runtime: NavigationRuntime,
  directory: string,
): Promise<ProjectIdentity> {
  const cwd = await existingDirectory(path.resolve(directory));
  const vcs = await runtime.importModule<NativeVcs>("@oh-my-pi/pi-natives/vcs");
  const repository = vcs.git(cwd);
  if (!repository) {
    return { cwd, root: cwd, mainRoot: cwd, isWorktree: false, bankPath: cwd };
  }
  const root = await existingDirectory(repository.info().repoRoot);
  const mainRoot = await existingDirectory(repository.primaryRoot());
  const commonDir = await fs.realpath(repository.info().commonDir);
  const primary = vcs.git(mainRoot);
  if (!primary || (await fs.realpath(primary.info().commonDir)) !== commonDir) {
    throw new NavigationError("git", `Cannot verify primary checkout for ${cwd}`);
  }
  const entries = await repository.worktrees();
  if (!entries.some((entry) => path.resolve(entry.path) === root)) {
    throw new NavigationError("git", `Checkout is absent from the Git worktree registry: ${root}`);
  }
  const isWorktree = root !== mainRoot;
  return {
    cwd,
    root,
    mainRoot,
    commonDir,
    isWorktree,
    bankPath: isWorktree ? path.resolve(mainRoot, path.relative(root, cwd)) : cwd,
  };
}

export class WorkspaceNavigation {
  readonly #initialRoot: Promise<string>;
  #initialRootValue?: string;
  readonly #vcs: Promise<NativeVcs>;
  #vcsValue?: NativeVcs;

  constructor(
    readonly runtime: NavigationRuntime,
    readonly options: NavigationOptions,
  ) {
    this.#vcs = runtime.importModule<NativeVcs>("@oh-my-pi/pi-natives/vcs");
    this.#vcs.then(
      (vcs) => {
        this.#vcsValue = vcs;
      },
      () => {},
    );
    this.#initialRoot = resolveProjectIdentity(runtime, options.initialCwd).then((identity) => {
      this.#initialRootValue = identity.mainRoot;
      return identity.mainRoot;
    });
    // A vanished starting project must not surface as an unhandled rejection (fatal in omp).
    this.#initialRoot.catch(() => {});
  }

  get resolvedInitialRoot(): string | undefined {
    return this.#initialRootValue;
  }

  async initialRoot(): Promise<string | undefined> {
    return await this.#initialRoot.catch(() => undefined);
  }

  /** Sync best effort: the checkout root (a worktree's own top level) containing `directory`. */
  previewCheckoutRoot(directory: string): string | undefined {
    try {
      const root = this.#vcsValue?.git(realpathSync(directory))?.info().repoRoot;
      return root ? realpathSync(root) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Sync best effort for approval prompts: realpath, a worktree resolves to its primary checkout. */
  previewProjectRoot(directory: string): string | undefined {
    let canonical: string;
    try {
      canonical = realpathSync(directory);
    } catch {
      return undefined;
    }
    try {
      const primary = this.#vcsValue?.git(canonical)?.primaryRoot();
      return primary ? realpathSync(primary) : canonical;
    } catch {
      return canonical;
    }
  }

  async #roots(): Promise<string[]> {
    // A vanished starting project cannot authorize anything, like a vanished grant below.
    const initial = await this.initialRoot();
    const roots = initial ? [initial] : [];
    for (const directory of this.options.getWorkspaceRoots()) {
      try {
        roots.push(await existingDirectory(path.resolve(directory)));
      } catch {
        /* A vanished grant cannot authorize a new operation. */
      }
    }
    return roots;
  }

  async #authorize(target: string, identity?: ProjectIdentity): Promise<void> {
    const roots = await this.#roots();
    if (roots.some((root) => pathIsWithin(root, target))) {
      return;
    }
    if (identity?.isWorktree && roots.some((root) => pathIsWithin(root, identity.mainRoot))) {
      return;
    }
    const grant = identity
      ? ` Call workspace_grant with dirs ${JSON.stringify([identity.mainRoot])} to accept this project root.`
      : "";
    throw new NavigationError(
      "permission",
      `Path is outside the accepted workspace roots: ${target}.${grant}`,
      identity ? [identity.mainRoot] : undefined,
    );
  }

  async #rejectMetadata(target: string, identity?: ProjectIdentity): Promise<void> {
    if (
      target.split(path.sep).includes(".git") ||
      (identity?.commonDir && pathIsWithin(identity.commonDir, target))
    ) {
      throw new NavigationError("permission", `Git metadata is not a workspace: ${target}`);
    }
    const vcs = await this.#vcs;
    for (const root of new Set([this.options.getCwd(), ...(await this.#roots())])) {
      const info = vcs.git(root)?.info();
      if (!info) {
        continue;
      }
      for (const directory of [info.gitDir, info.commonDir]) {
        const metadata = await fs.realpath(directory);
        if (pathIsWithin(metadata, target)) {
          throw new NavigationError("permission", `Git metadata is not a workspace: ${target}`);
        }
      }
    }
  }

  async #currentProject(): Promise<{ identity: ProjectIdentity; repository: GitRepository }> {
    const identity = await resolveProjectIdentity(this.runtime, this.options.getCwd());
    await this.#authorize(identity.cwd, identity);
    const vcs = await this.#vcs;
    if (vcs.isPureJj(identity.cwd)) {
      throw new NavigationError(
        "git",
        "Worktree operations require a Git checkout, not a pure Jujutsu workspace.",
      );
    }
    const repository = vcs.git(identity.cwd);
    if (!repository) {
      throw new NavigationError("git", `Not inside a Git checkout: ${identity.cwd}`);
    }
    return { identity, repository };
  }

  async validateMove(directory: string): Promise<string> {
    const lexical = expandPath(directory, this.options.getCwd());
    await this.#rejectMetadata(lexical);
    const identity = await resolveProjectIdentity(this.runtime, lexical);
    await this.#rejectMetadata(identity.cwd, identity);
    await this.#authorize(identity.cwd, identity);
    return identity.cwd;
  }

  async validateEnter(directory: string): Promise<string> {
    const { identity: current } = await this.#currentProject();
    const target = await this.validateMove(directory);
    const identity = await resolveProjectIdentity(this.runtime, target);
    if (
      !identity.isWorktree ||
      identity.cwd !== identity.root ||
      identity.commonDir !== current.commonDir
    ) {
      throw new NavigationError(
        "git",
        `Not a registered worktree of the current project: ${target}`,
      );
    }
    return target;
  }

  async validateExit(): Promise<string> {
    const { identity } = await this.#currentProject();
    await this.#authorize(identity.mainRoot);
    return identity.mainRoot;
  }

  async #state(entry: NativeWorktree, mainRoot: string): Promise<WorktreeState> {
    const vcs = await this.#vcs;
    let target = path.resolve(entry.path);
    try {
      target = await fs.realpath(target);
    } catch {
      /* Keep stale registered paths visible. */
    }
    const repository = vcs.git(target);
    const available = Boolean(repository && path.resolve(repository.info().repoRoot) === target);
    const locked = Boolean(
      repository &&
        (await fs.lstat(path.join(repository.info().gitDir, "locked")).then(
          () => true,
          (error) => {
            if (notFound(error)) {
              return false;
            }
            throw error;
          },
        )),
    );
    const status = available
      ? await repository!.statusPorcelain({ untracked: "all", nulTerminated: true })
      : null;
    const records = status?.split("\0") ?? [];
    const agents = await Promise.all(
      this.options.getLiveAgentCwds().map(async (cwd) => {
        try {
          return await fs.realpath(cwd);
        } catch {
          return path.resolve(cwd);
        }
      }),
    );
    return {
      path: target,
      primary: target === mainRoot,
      branch: entry.branch?.replace(/^refs\/heads\//, ""),
      head: entry.head,
      detached: entry.detached,
      locked,
      dirty: status === null ? null : status.length > 0,
      untracked: status === null ? null : records.some((record) => record.startsWith("?? ")),
      inUse: agents.some((cwd) => pathIsWithin(target, cwd)),
      available,
    };
  }

  async listWorktrees(): Promise<WorktreeState[]> {
    const { identity, repository } = await this.#currentProject();
    return await Promise.all(
      (await repository.worktrees()).map((entry) => this.#state(entry, identity.mainRoot)),
    );
  }

  async #managedBase(): Promise<string> {
    const utils = await this.runtime.importModule<{ getWorktreesDir(): string }>(
      "@oh-my-pi/pi-utils/dirs",
    );
    const configured = await readSetting(this.runtime, this.options.getSettings(), "worktree.base");
    const fromEnv = process.env.OMP_WORKTREE_DIR;
    const explicit = [fromEnv, configured].find(
      (value) => typeof value === "string" && (path.isAbsolute(value) || value.startsWith("~/")),
    );
    return await futureDirectory(
      explicit ? expandPath(explicit as string, this.options.getCwd()) : utils.getWorktreesDir(),
    );
  }

  #invalidBranch(branch: string): boolean {
    return (
      typeof branch !== "string" ||
      !branch ||
      /[\s~^:?*[\\\0]/.test(branch) ||
      branch.startsWith("-") ||
      branch.endsWith("/") ||
      branch.includes("..") ||
      branch.includes("@{") ||
      branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
    );
  }

  #invalidRef(ref: string | undefined): boolean {
    return ref !== undefined && (typeof ref !== "string" || !ref.trim() || ref.includes("\0"));
  }

  async createWorktree(request: { branch: string; path?: string; ref?: string }): Promise<{
    path: string;
    branch: string;
    baseCommit: string;
    mainRoot: string;
    clonedWith?: unknown;
    cloneError?: string;
  }> {
    const { identity, repository } = await this.#currentProject();
    const branch = request.branch;
    if (this.#invalidBranch(branch)) {
      throw new NavigationError("invalid", `Invalid branch name: ${String(branch)}`);
    }
    if (this.#invalidRef(request.ref)) {
      throw new NavigationError("invalid", "ref must be a non-empty revision.");
    }
    const branchRef = `refs/heads/${branch}`;
    const { baseCommit, target, requestedPath } = await this.#resolveWorktreeDestination(
      request,
      identity,
      repository,
      branch,
      branchRef,
    );
    const existing = await this.#prepareExistingDirectory(requestedPath, target);
    const settings = this.options.getSettings();
    await settings.flush?.();
    const task = await this.runtime.importModule<{ parseIsolationBackend(value: string): unknown }>(
      "task/worktree.ts",
    );
    const nested = pathIsWithin(identity.mainRoot, target);
    const backend = task.parseIsolationBackend(
      String(await readSetting(this.runtime, settings, "isolation.backend")),
    );
    const clone = (await readSetting(this.runtime, settings, "worktree.clone")) === true;
    let retainedExclude: string | undefined;
    let createdBranch = false;
    let reservation: { ino: number; dev: number } | undefined;
    try {
      await repository.createBranch(branch, baseCommit, false);
      createdBranch = true;
      if (nested) {
        retainedExclude = await this.#applyNestedWorktreeExclude(target, identity);
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (!existing) {
        await fs.mkdir(target);
        reservation = await fs.stat(target);
      }
      // A clone backend may delete its failed target; a pre-existing empty directory must survive.
      const result = await repository.worktreeAdd(target, branch, {
        detach: false,
        clone: !nested && !existing && clone,
        backend,
        keepChanges: false,
      });
      const actual = await fs.realpath(target);
      const destination = (await this.#vcs).git(actual);
      if (!destination || (await destination.statusPorcelain({ untracked: "all" }))) {
        throw new NavigationError("git", `New worktree is not clean: ${actual}`);
      }
      return { path: actual, branch, baseCommit, mainRoot: identity.mainRoot, ...result };
    } catch (error) {
      return await this.#worktreeFailure(error, {
        target,
        identity,
        repository,
        branch,
        branchRef,
        baseCommit,
        reservation,
        createdBranch,
        retainedExclude,
      });
    }
  }

  async #resolveWorktreeDestination(
    request: { branch: string; path?: string; ref?: string },
    identity: ProjectIdentity,
    repository: {
      refExists(ref: string): Promise<boolean>;
      resolveRef(ref?: string): Promise<string | null | undefined>;
      worktrees(): Promise<NativeWorktree[]>;
    },
    branch: string,
    branchRef: string,
  ): Promise<{ baseCommit: string; target: string; requestedPath: string }> {
    if (await repository.refExists(branchRef)) {
      throw new NavigationError("conflict", `Branch already exists: ${branch}`);
    }
    const baseCommit = await repository.resolveRef(request.ref ?? "HEAD");
    if (!baseCommit) {
      throw new NavigationError("git", `Cannot resolve revision: ${request.ref ?? "HEAD"}`);
    }
    const registered = await repository.worktrees();
    if (registered.some((entry) => entry.branch === branchRef || entry.branch === branch)) {
      throw new NavigationError("conflict", `Branch is already checked out: ${branch}`);
    }
    const managed = await this.#managedBase();
    let requestedPath: string;
    if (request.path !== undefined) {
      requestedPath = expandPath(request.path, identity.mainRoot);
    } else {
      const utils = await this.runtime.importModule<{ hashPath(root: string): string }>(
        "@oh-my-pi/pi-utils/dirs",
      );
      const native = await this.runtime.importModule<{
        resolveAvailableWorktreePath(base: string, entries: NativeWorktree[]): Promise<string>;
      }>("tools/gh-pr-checkout.ts");
      requestedPath = await native.resolveAvailableWorktreePath(
        path.join(
          managed,
          `${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}-${utils.hashPath(identity.mainRoot)}`,
        ),
        registered,
      );
    }
    await this.#rejectMetadata(requestedPath, identity);
    const target = await futureDirectory(requestedPath);
    await this.#rejectMetadata(target, identity);
    if (!pathIsWithin(managed, target)) {
      await this.#authorize(target);
    }
    if (
      pathIsWithin(target, identity.mainRoot) ||
      registered.some(
        (entry) =>
          path.resolve(entry.path) !== identity.mainRoot &&
          (pathIsWithin(path.resolve(entry.path), target) ||
            pathIsWithin(target, path.resolve(entry.path))),
      )
    ) {
      throw new NavigationError("conflict", `Destination overlaps an existing checkout: ${target}`);
    }
    return { baseCommit, target, requestedPath };
  }

  async #prepareExistingDirectory(requestedPath: string, target: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(requestedPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new NavigationError(
          "conflict",
          `Destination is not an ordinary directory: ${requestedPath}`,
        );
      }
      if ((await fs.readdir(target)).length) {
        throw new NavigationError("conflict", `Destination is not empty: ${target}`);
      }
      return true;
    } catch (error) {
      if (!notFound(error)) {
        throw error;
      }
      return false;
    }
  }

  async #applyNestedWorktreeExclude(
    target: string,
    identity: { mainRoot: string; commonDir?: string },
  ): Promise<string | undefined> {
    const relative = path.relative(identity.mainRoot, target).split(path.sep).join("/");
    if (/[\r\n]/.test(relative)) {
      throw new NavigationError("invalid", "A nested worktree path cannot contain a newline.");
    }
    const check = Bun.spawn(
      ["git", "check-ignore", "--no-index", "--quiet", "--", `${relative}/`],
      { cwd: identity.mainRoot, stdout: "ignore", stderr: "pipe" },
    );
    const exit = await check.exited;
    if (exit !== 0 && exit !== 1) {
      throw new NavigationError(
        "git",
        `git check-ignore failed: ${await new Response(check.stderr).text()}`,
      );
    }
    if (exit !== 1) {
      return undefined;
    }
    const file = path.join(identity.commonDir!, "info", "exclude");
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (!pathIsWithin(identity.commonDir!, await fs.realpath(path.dirname(file)))) {
      throw new NavigationError(
        "permission",
        `Local exclude directory leaves Git metadata: ${file}`,
      );
    }
    const excludeStat = await fs.lstat(file).catch((error) => {
      if (notFound(error)) {
        return undefined;
      }
      throw error;
    });
    if (excludeStat && !excludeStat.isFile()) {
      throw new NavigationError("permission", `Local exclude must be a regular file: ${file}`);
    }
    const pattern = `/${relative.replace(/[\\*?[\] #!]/g, "\\$&")}/`;
    await fs.appendFile(file, `\n${pattern}\n`);
    return file;
  }

  async #pristineWorktree(
    destination: GitRepository,
    state: WorktreeState | undefined,
    baseCommit: string,
    branch: string,
  ): Promise<boolean> {
    if (!state?.available || state.dirty || state.locked || state.inUse || state.detached) {
      return false;
    }
    return (
      (await destination.resolveRef("HEAD")) === baseCommit &&
      (await destination.currentBranch()) === branch
    );
  }

  async #releaseFailedDestination(
    deps: {
      target: string;
      branch: string;
      baseCommit: string;
      identity: { mainRoot: string; commonDir?: string };
      repository: {
        worktrees(): Promise<NativeWorktree[]>;
        worktreeRemove(path: string, force: boolean): Promise<boolean>;
      };
    },
    destination: GitRepository | null,
    stat: unknown,
    reserved: boolean,
    owned: boolean,
    retained: string[],
    cleanupErrors: string[],
  ): Promise<void> {
    try {
      if (!owned) {
        if (reserved && !(await fs.readdir(deps.target)).length) {
          await fs.rmdir(deps.target);
        } else if (stat) {
          retained.push(deps.target);
        }
        return;
      }
      const entry = (await deps.repository.worktrees()).find(
        (entry) => path.resolve(entry.path) === deps.target,
      );
      const state = entry ? await this.#state(entry, deps.identity.mainRoot) : undefined;
      if (await this.#pristineWorktree(destination!, state, deps.baseCommit, deps.branch)) {
        if (!(await deps.repository.worktreeRemove(deps.target, false))) {
          retained.push(deps.target);
        }
      } else {
        retained.push(deps.target);
      }
    } catch (cleanup) {
      retained.push(deps.target);
      cleanupErrors.push(String(cleanup));
    }
  }

  async #rollbackRetainedBranch(
    deps: {
      branch: string;
      branchRef: string;
      baseCommit: string;
      createdBranch: boolean;
      repository: {
        resolveRef(ref?: string): Promise<string | null | undefined>;
        worktrees(): Promise<NativeWorktree[]>;
        deleteBranch(branch: string, force: boolean): Promise<boolean>;
      };
    },
    retained: string[],
    cleanupErrors: string[],
  ): Promise<void> {
    if (
      !deps.createdBranch ||
      retained.length ||
      (await deps.repository.resolveRef(deps.branchRef)) !== deps.baseCommit
    ) {
      return;
    }
    if (
      (await deps.repository.worktrees()).some(
        (entry) => entry.branch === deps.branchRef || entry.branch === deps.branch,
      )
    ) {
      return;
    }
    try {
      if (!(await deps.repository.deleteBranch(deps.branch, false))) {
        cleanupErrors.push(`Branch ${deps.branch} was retained.`);
      }
    } catch (cleanup) {
      cleanupErrors.push(`Branch ${deps.branch} was retained: ${String(cleanup)}`);
    }
  }

  async #worktreeFailure(
    error: unknown,
    deps: {
      target: string;
      identity: { mainRoot: string; commonDir?: string };
      repository: {
        resolveRef(ref?: string): Promise<string | null | undefined>;
        worktrees(): Promise<NativeWorktree[]>;
        worktreeRemove(path: string, force: boolean): Promise<boolean>;
        deleteBranch(branch: string, force: boolean): Promise<boolean>;
      };
      branch: string;
      branchRef: string;
      baseCommit: string;
      reservation: { ino: number; dev: number } | undefined;
      createdBranch: boolean;
      retainedExclude: string | undefined;
    },
  ): Promise<never> {
    const retained: string[] = [];
    const cleanupErrors: string[] = [];
    const vcs = await this.#vcs;
    const destination = vcs.git(deps.target);
    const stat = await fs.lstat(deps.target).catch(() => undefined);
    const reserved = Boolean(
      deps.reservation &&
        stat?.isDirectory() &&
        stat.ino === deps.reservation.ino &&
        stat.dev === deps.reservation.dev,
    );
    const owned =
      reserved &&
      destination &&
      path.resolve(destination.info().repoRoot) === deps.target &&
      (await fs.realpath(destination.info().commonDir)) === deps.identity.commonDir;
    await this.#releaseFailedDestination(
      deps,
      destination,
      stat,
      reserved,
      Boolean(owned),
      retained,
      cleanupErrors,
    );
    await this.#rollbackRetainedBranch(deps, retained, cleanupErrors);
    // Shared exclude is append-only here: rollback must never truncate another process's update.
    throw new NavigationError(
      "git",
      `${error instanceof Error ? error.message : String(error)}${retained.length ? `; retained destination for inspection: ${retained.join(", ")}` : ""}${deps.retainedExclude ? `; retained harmless exact ignore rule in ${deps.retainedExclude}` : ""}${cleanupErrors.length ? `; cleanup: ${cleanupErrors.join("; ")}` : ""}`,
    );
  }

  async removeWorktree(
    directory: string,
  ): Promise<{ path: string; branch: string; mainRoot: string }> {
    const { identity, repository } = await this.#currentProject();
    const target = await this.validateMove(directory);
    const targetIdentity = await resolveProjectIdentity(this.runtime, target);
    if (
      target !== targetIdentity.root ||
      !targetIdentity.isWorktree ||
      targetIdentity.commonDir !== identity.commonDir
    ) {
      throw new NavigationError("git", `Not a linked worktree of the current project: ${target}`);
    }
    if (pathIsWithin(target, await existingDirectory(this.options.getCwd()))) {
      throw new NavigationError("busy", `Cannot remove the current worktree: ${target}`);
    }
    const entry = (await repository.worktrees()).find(
      (entry) => path.resolve(entry.path) === target,
    );
    if (!entry) {
      throw new NavigationError("git", `Worktree is no longer registered: ${target}`);
    }
    const state = await this.#state(entry, identity.mainRoot);
    if (state.inUse) {
      throw new NavigationError("busy", `A live subagent uses this worktree: ${target}`);
    }
    if (
      state.locked ||
      state.detached ||
      state.dirty ||
      state.untracked ||
      !state.available ||
      !state.branch
    ) {
      throw new NavigationError(
        "git",
        `Removal requires an available, unlocked, attached, clean worktree: ${target}`,
      );
    }
    if (!(await repository.worktreeRemove(target, false))) {
      throw new NavigationError(
        "git",
        `Native backend refused removal; branch ${state.branch} is kept.`,
      );
    }
    return { path: target, branch: state.branch, mainRoot: identity.mainRoot };
  }
}
