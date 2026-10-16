import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  type NavigationRuntime,
  pathIsWithin,
  resolveProjectIdentity,
  WorkspaceNavigation,
} from "../src/navigation";
import { createRuntime, findInstalledOmp } from "../src/runtime";
import { type HostNamespace } from "../src/types";

const runtime = createRuntime({} as HostNamespace, findInstalledOmp());
const temporary: string[] = [];
afterEach(async () => {
  while (temporary.length) {
    await fs.rm(temporary.pop()!, { recursive: true, force: true });
  }
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (code) {
    throw new Error(`git ${args[0]} failed: ${error}`);
  }
  return output.trim();
}

async function project(root: string, name: string): Promise<string> {
  const directory = path.join(root, name);
  await fs.mkdir(directory);
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Navigation Test");
  await git(directory, "config", "user.email", "navigation@example.invalid");
  await fs.writeFile(path.join(directory, "tracked.txt"), "original\n");
  await git(directory, "add", "tracked.txt");
  await git(directory, "commit", "-m", "fixture");
  return directory;
}

async function fixture(customRuntime: NavigationRuntime = runtime) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "omp-nav-test-")));
  temporary.push(root);
  const a = await project(root, "A");
  const b = await project(root, "B");
  const managedBase = path.join(root, "managed");
  await runtime.importModule("config/all-settings.ts");
  const { Settings } = await runtime.importModule<any>("config/settings.ts");
  const settings = Settings.isolated({
    "worktree.base": managedBase,
    "worktree.clone": true,
    "isolation.backend": "auto",
  });
  let cwd = a;
  let grants: string[] = [];
  let agents: string[] = [];
  const nav = new WorkspaceNavigation(customRuntime, {
    initialCwd: a,
    getCwd: () => cwd,
    getWorkspaceRoots: () => grants,
    getLiveAgentCwds: () => agents,
    getSettings: () => settings,
  });
  return {
    root,
    a,
    b,
    nav,
    settings,
    managedBase,
    move: (directory: string) => {
      cwd = directory;
    },
    grant: (...directories: string[]) => {
      grants = directories;
    },
    agents: (...directories: string[]) => {
      agents = directories;
    },
  };
}

describe("accepted roots and project identity", () => {
  test("canonical boundaries do not authorize symlink escapes or visited/revoked projects", async () => {
    const f = await fixture();
    await expect(f.nav.validateMove(f.b)).rejects.toThrow("permission");
    const link = path.join(f.a, "escape");
    await fs.symlink(f.b, link);
    await expect(f.nav.validateMove(link)).rejects.toThrow("permission");
    f.grant(f.b);
    expect(await f.nav.validateMove(link)).toBe(f.b);
    f.move(f.b);
    f.grant();
    await expect(f.nav.listWorktrees()).rejects.toThrow("permission");
    expect(await f.nav.validateMove(f.a)).toBe(f.a);
    expect(pathIsWithin(f.a, `${f.a}-other`)).toBe(false);
    expect(pathIsWithin(f.a, path.join(f.a, "..valid"))).toBe(true);
  });

  test("linked worktrees belong to their primary project including matching subdirectories", async () => {
    const f = await fixture();
    f.grant(f.b);
    f.move(f.b);
    const wt = await f.nav.createWorktree({
      branch: "b-work",
      path: path.join(f.root, "managed", "b-work"),
    });
    const identity = await resolveProjectIdentity(runtime, wt.path);
    expect(identity.mainRoot).toBe(f.b);
    expect(identity.bankPath).toBe(f.b);
    await fs.mkdir(path.join(wt.path, "nested"));
    expect((await resolveProjectIdentity(runtime, path.join(wt.path, "nested"))).bankPath).toBe(
      path.join(f.b, "nested"),
    );
    expect((await resolveProjectIdentity(runtime, path.join(f.a))).bankPath).toBe(f.a);
    f.move(f.a);
    expect(await f.nav.validateMove(wt.path)).toBe(wt.path);
    f.grant();
    await expect(f.nav.validateMove(wt.path)).rejects.toThrow("permission");
  });

  test("separate source and accepted project Git directories reject even ordinary aliases inside grants", async () => {
    const f = await fixture();
    await f.nav.validateMove(f.a);
    const sourceMetadata = path.join(f.root, "source-metadata");
    const acceptedMetadata = path.join(f.root, "accepted-metadata");
    await git(f.a, "init", `--separate-git-dir=${sourceMetadata}`);
    await git(f.b, "init", `--separate-git-dir=${acceptedMetadata}`);
    f.grant(f.root, f.b);
    await fs.symlink(sourceMetadata, path.join(f.a, "source-alias"));
    await fs.symlink(acceptedMetadata, path.join(f.a, "accepted-alias"));
    for (const target of [
      sourceMetadata,
      path.join(sourceMetadata, "objects"),
      acceptedMetadata,
      path.join(f.a, "source-alias"),
      path.join(f.a, "accepted-alias", "objects"),
    ]) {
      await expect(f.nav.validateMove(target)).rejects.toThrow("Git metadata");
    }
    await expect(
      f.nav.createWorktree({
        branch: "metadata-child",
        path: path.join(acceptedMetadata, "child"),
      }),
    ).rejects.toThrow("Git metadata");
    expect(await git(f.a, "branch", "--list", "metadata-child")).toBe("");
  });
});

describe("worktree creation", () => {
  test("an exact nested path preserves dirty source, ignores locally, and disables clone", async () => {
    const calls: Record<string, unknown>[] = [];
    const instrumented: NavigationRuntime = {
      async importModule<T>(specifier: string): Promise<T> {
        const module = await runtime.importModule<any>(specifier);
        if (specifier !== "@oh-my-pi/pi-natives/vcs") {
          return module;
        }
        return {
          ...module,
          git(cwd: string) {
            const repo = module.git(cwd);
            return repo
              ? new Proxy(repo, {
                  get(target, key) {
                    if (key === "worktreeAdd") {
                      return async (
                        location: string,
                        ref: string,
                        options: Record<string, unknown>,
                      ) => {
                        calls.push(options);
                        return await target.worktreeAdd(location, ref, options);
                      };
                    }
                    const value = Reflect.get(target, key);
                    return typeof value === "function" ? value.bind(target) : value;
                  },
                })
              : null;
          },
        } as T;
      },
    };
    const f = await fixture(instrumented);
    await fs.writeFile(path.join(f.a, "tracked.txt"), "dirty\n");
    await fs.writeFile(path.join(f.a, "untracked.txt"), "source only\n");
    const before = await git(f.a, "status", "--porcelain");
    const wt = await f.nav.createWorktree({
      branch: "feature/test",
      path: ".claude/worktree/exact name",
    });
    expect(wt.path).toBe(path.join(f.a, ".claude/worktree/exact name"));
    expect(calls[0]?.clone).toBe(false);
    expect(calls[0]?.keepChanges).toBe(false);
    expect(await fs.readFile(path.join(wt.path, "tracked.txt"), "utf8")).toBe("original\n");
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
    expect(await git(f.a, "status", "--porcelain")).toBe(before);
    expect(await fs.readFile(path.join(f.a, ".git/info/exclude"), "utf8")).toContain(
      "/.claude/worktree/exact\\ name/",
    );
    f.move(wt.path);
    await fs.writeFile(path.join(wt.path, "tracked.txt"), "worktree commit\n");
    await git(wt.path, "add", "tracked.txt");
    await git(wt.path, "commit", "-m", "worktree-only fixture");
    const second = await f.nav.createWorktree({ branch: "next", path: ".claude/worktree/second" });
    expect(second.path).toBe(path.join(f.a, ".claude/worktree/second"));
    expect(second.baseCommit).toBe(await git(wt.path, "rev-parse", "HEAD"));
    expect(await fs.readFile(path.join(second.path, "tracked.txt"), "utf8")).toBe(
      "worktree commit\n",
    );
    expect(await f.nav.validateExit()).toBe(f.a);
    expect((await f.nav.listWorktrees()).map((entry) => entry.path)).toContain(second.path);
    const { cfgWorktreeBase, cfgWorktreeClone } =
      await runtime.importModule<any>("task/settings.ts");
    const selectedBase = path.join(f.root, "selected-via-native-handle");
    cfgWorktreeBase.override(f.settings, selectedBase);
    cfgWorktreeClone.override(f.settings, false);
    expect(typeof f.settings.get).toBe("undefined");
    const nativeConfigured = await f.nav.createWorktree({ branch: "native-settings" });
    expect(path.dirname(nativeConfigured.path)).toBe(selectedBase);
    expect(calls.at(-1)?.clone).toBe(false);
  });

  test("explicit ref is respected; existing branches are preserved and default path uses managed base", async () => {
    const f = await fixture();
    const initial = await git(f.a, "rev-parse", "HEAD");
    await fs.writeFile(path.join(f.a, "tracked.txt"), "new commit\n");
    await git(f.a, "add", "tracked.txt");
    await git(f.a, "commit", "-m", "second");
    const wt = await f.nav.createWorktree({ branch: "old", ref: initial });
    expect(path.dirname(wt.path)).toBe(f.managedBase);
    expect(await git(wt.path, "rev-parse", "HEAD")).toBe(initial);
    await f.nav.removeWorktree(wt.path);
    const destination = path.join(f.root, "managed", "recreated");
    await expect(f.nav.createWorktree({ branch: "old", path: destination })).rejects.toThrow(
      "Branch already exists",
    );
    await expect(
      f.nav.createWorktree({ branch: "old", path: destination, ref: "HEAD" }),
    ).rejects.toThrow("Branch already exists");
    expect(await git(f.a, "rev-parse", "refs/heads/old")).toBe(initial);
    expect(await fs.stat(destination).catch(() => undefined)).toBeUndefined();
  });

  test("rejects occupied, metadata, symlink, missing-ref, and overlapping destinations without branch changes", async () => {
    const f = await fixture();
    const occupied = path.join(f.a, "occupied");
    await fs.mkdir(occupied);
    await fs.writeFile(path.join(occupied, "keep.txt"), "keep");
    const link = path.join(f.a, "outside");
    await fs.symlink(f.b, link);
    const dangling = path.join(f.a, "dangling");
    await fs.symlink(path.join(f.root, "absent"), dangling);
    for (const location of [
      occupied,
      f.a,
      path.join(f.a, ".git/wt"),
      path.join(link, "wt"),
      path.join(dangling, "wt"),
      f.b,
    ]) {
      await expect(f.nav.createWorktree({ branch: "reject", path: location })).rejects.toThrow();
      expect(await git(f.a, "branch", "--list", "reject")).toBe("");
    }
    await expect(
      f.nav.createWorktree({
        branch: "bad-ref",
        path: ".claude/worktree/missing",
        ref: "no-such-ref",
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(occupied, "keep.txt"), "utf8")).toBe("keep");
    const wt = await f.nav.createWorktree({ branch: "first", path: ".claude/worktree/first" });
    await expect(
      f.nav.createWorktree({ branch: "inside", path: path.join(wt.path, "nested") }),
    ).rejects.toThrow("overlaps");
    await expect(f.nav.createWorktree({ branch: "registered", path: wt.path })).rejects.toThrow(
      "overlaps",
    );
  });

  test("pre-existing empty directory is accepted and its path is exact", async () => {
    const f = await fixture();
    const empty = path.join(f.a, "empty");
    await fs.mkdir(empty);
    const before = await fs.stat(empty);
    const wt = await f.nav.createWorktree({ branch: "empty", path: empty });
    expect(wt.path).toBe(empty);
    expect((await fs.stat(empty)).ino).toBe(before.ino);
    expect(await git(empty, "status", "--porcelain")).toBe("");
  });

  test("tilde paths stay exact and a symlinked local exclude file is never modified", async () => {
    const f = await fixture();
    const { homedir } = await import("node:os");
    const exact = path.join(f.root, "managed", "tilde");
    const wt = await f.nav.createWorktree({
      branch: "tilde",
      path: `~/${path.relative(homedir(), exact)}`,
    });
    expect(wt.path).toBe(exact);
    const external = path.join(f.root, "external-exclude");
    await fs.writeFile(external, "keep\n");
    const local = path.join(f.a, ".git/info/exclude");
    await fs.unlink(local);
    await fs.symlink(external, local);
    await expect(
      f.nav.createWorktree({ branch: "exclude-link", path: ".claude/worktree/exclude-link" }),
    ).rejects.toThrow("regular file");
    expect(await fs.readFile(external, "utf8")).toBe("keep\n");
    expect(await git(f.a, "branch", "--list", "exclude-link")).toBe("");
  });

  test("creation failure rolls back only its unchanged worktree and preserves concurrent exclude edits", async () => {
    let failAfterCreate = true;
    let appendForeignExclude = false;
    const instrumented: NavigationRuntime = {
      async importModule<T>(specifier: string): Promise<T> {
        const module = await runtime.importModule<any>(specifier);
        if (specifier !== "@oh-my-pi/pi-natives/vcs") {
          return module;
        }
        return {
          ...module,
          git(cwd: string) {
            const repo = module.git(cwd);
            return repo
              ? new Proxy(repo, {
                  get(target, key) {
                    if (key === "worktreeAdd") {
                      return async (
                        location: string,
                        ref: string,
                        options: Record<string, unknown>,
                      ) => {
                        if (failAfterCreate) {
                          await target.worktreeAdd(location, ref, options);
                        }
                        if (appendForeignExclude) {
                          await fs.appendFile(
                            path.join(target.info().commonDir, "info", "exclude"),
                            "/foreign-entry/\n",
                          );
                        }
                        throw new Error("injected backend failure");
                      };
                    }
                    const value = Reflect.get(target, key);
                    return typeof value === "function" ? value.bind(target) : value;
                  },
                })
              : null;
          },
        } as T;
      },
    };
    const f = await fixture(instrumented);
    const exclude = path.join(f.a, ".git/info/exclude");
    const original = await fs.readFile(exclude, "utf8");
    await expect(
      f.nav.createWorktree({ branch: "rollback", path: ".claude/worktree/rollback" }),
    ).rejects.toThrow(/injected backend failure.*retained harmless exact ignore rule/);
    expect(await git(f.a, "branch", "--list", "rollback")).toBe("");
    expect(await fs.readFile(exclude, "utf8")).toBe(`${original}\n/.claude/worktree/rollback/\n`);
    expect(
      await fs.stat(path.join(f.a, ".claude/worktree/rollback")).catch(() => undefined),
    ).toBeUndefined();
    expect((await f.nav.listWorktrees()).length).toBe(1);
    failAfterCreate = false;
    appendForeignExclude = true;
    await expect(
      f.nav.createWorktree({ branch: "concurrent", path: ".claude/worktree/concurrent" }),
    ).rejects.toThrow("injected backend failure");
    expect(await fs.readFile(exclude, "utf8")).toContain("/foreign-entry/\n");
    expect(await git(f.a, "branch", "--list", "concurrent")).toBe("");
  });

  test("failure retains a worktree changed during creation and the branch that protects it", async () => {
    const instrumented: NavigationRuntime = {
      async importModule<T>(specifier: string): Promise<T> {
        const module = await runtime.importModule<any>(specifier);
        if (specifier !== "@oh-my-pi/pi-natives/vcs") {
          return module;
        }
        return {
          ...module,
          git(cwd: string) {
            const repo = module.git(cwd);
            return repo
              ? new Proxy(repo, {
                  get(target, key) {
                    if (key === "worktreeAdd") {
                      return async (
                        location: string,
                        ref: string,
                        options: Record<string, unknown>,
                      ) => {
                        await target.worktreeAdd(location, ref, options);
                        await fs.writeFile(
                          path.join(location, "someone-elses-file.txt"),
                          "preserve",
                        );
                        throw new Error("injected failure after foreign edit");
                      };
                    }
                    const value = Reflect.get(target, key);
                    return typeof value === "function" ? value.bind(target) : value;
                  },
                })
              : null;
          },
        } as T;
      },
    };
    const f = await fixture(instrumented);
    const target = path.join(f.a, ".claude/worktree/retained");
    await expect(f.nav.createWorktree({ branch: "retained", path: target })).rejects.toThrow(
      "retained destination",
    );
    expect(await fs.readFile(path.join(target, "someone-elses-file.txt"), "utf8")).toBe("preserve");
    expect(await git(f.a, "branch", "--list", "retained")).toContain("retained");
    expect((await f.nav.listWorktrees()).length).toBe(2);
  });

  test("external clone starts from clean HEAD without carrying dirty and untracked source state", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.a, "tracked.txt"), "dirty tracked\n");
    await fs.writeFile(path.join(f.a, "source-untracked.txt"), "dirty untracked\n");
    const before = await git(f.a, "status", "--porcelain");
    const wt = await f.nav.createWorktree({ branch: "cloned" });
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
    expect(await fs.readFile(path.join(wt.path, "tracked.txt"), "utf8")).toBe("original\n");
    expect(
      await fs.stat(path.join(wt.path, "source-untracked.txt")).catch(() => undefined),
    ).toBeUndefined();
    expect(await git(f.a, "status", "--porcelain")).toBe(before);
  });
});

describe("safe worktree removal", () => {
  test("blocks primary, current, live child, dirty, untracked, locked and detached worktrees, then preserves branch", async () => {
    const f = await fixture();
    const wt = await f.nav.createWorktree({ branch: "remove", path: ".claude/worktree/remove" });
    await expect(f.nav.removeWorktree(f.a)).rejects.toThrow();
    f.move(wt.path);
    await expect(f.nav.removeWorktree(wt.path)).rejects.toThrow("current");
    f.move(f.a);
    f.agents(path.join(wt.path, "src"));
    await expect(f.nav.removeWorktree(wt.path)).rejects.toThrow("subagent");
    f.agents();
    await fs.writeFile(path.join(wt.path, "tracked.txt"), "dirty");
    await expect(f.nav.removeWorktree(wt.path)).rejects.toThrow("clean");
    await git(wt.path, "restore", "tracked.txt");
    await fs.writeFile(path.join(wt.path, "untracked"), "keep");
    expect((await f.nav.listWorktrees()).find((entry) => entry.path === wt.path)?.untracked).toBe(
      true,
    );
    await expect(f.nav.removeWorktree(wt.path)).rejects.toThrow("clean");
    await fs.unlink(path.join(wt.path, "untracked"));
    const vcs = await runtime.importModule<any>("@oh-my-pi/pi-natives/vcs");
    const locked = path.join(vcs.git(wt.path).info().gitDir, "locked");
    await fs.writeFile(locked, "test lock");
    expect((await f.nav.listWorktrees()).find((entry) => entry.path === wt.path)?.locked).toBe(
      true,
    );
    await expect(f.nav.removeWorktree(wt.path)).rejects.toThrow("unlocked");
    await fs.unlink(locked);
    await git(wt.path, "checkout", "--detach");
    await expect(f.nav.removeWorktree(wt.path)).rejects.toThrow("attached");
    await git(wt.path, "checkout", "remove");
    const removed = await f.nav.removeWorktree(wt.path);
    expect(removed.branch).toBe("remove");
    expect(await git(f.a, "branch", "--list", "remove")).toContain("remove");
    expect(await fs.stat(path.dirname(wt.path))).toBeDefined();
    expect((await f.nav.listWorktrees()).some((entry) => entry.path === wt.path)).toBe(false);
  });

  test("enter accepts only registered worktrees of the current project", async () => {
    const f = await fixture();
    await expect(f.nav.validateEnter(f.a)).rejects.toThrow();
    const a = await f.nav.createWorktree({ branch: "a-wt", path: ".claude/worktree/a" });
    expect(await f.nav.validateEnter(a.path)).toBe(a.path);
    f.grant(f.b);
    f.move(f.b);
    const b = await f.nav.createWorktree({ branch: "b-wt", path: ".claude/worktree/b" });
    f.move(f.a);
    await expect(f.nav.validateEnter(b.path)).rejects.toThrow("current project");
    await expect(f.nav.removeWorktree(b.path)).rejects.toThrow("current project");
  });
});
