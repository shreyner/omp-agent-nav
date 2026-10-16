import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Database } from "bun:sqlite";
import { installMemoryBridge } from "../src/memory";
import { createRuntime, findInstalledOmp } from "../src/runtime";
import type { HostNamespace, RegistryRef, SessionLike, SettingsLike } from "../src/types";

const runtime = createRuntime({} as HostNamespace, findInstalledOmp());
const { AgentRegistry } = await runtime.importModule<{ AgentRegistry: { global(): { register(ref: RegistryRef): void; unregister(id: string): void; list(): RegistryRef[]; get(id: string): RegistryRef | undefined } } }>("registry/agent-registry.ts");
runtime.host.AgentRegistry = AgentRegistry;
const memory = await installMemoryBridge(runtime);
const { Settings } = await runtime.importModule<{ Settings: { loadIsolated(options: Record<string, unknown>): Promise<SettingsLike & { getCwd(): string }> } }>("config/settings.ts");
const { computeMnemopiBankScope } = await runtime.importModule<{ computeMnemopiBankScope(prefix: string, cwd: string, mode: string): { bank: string; recallBanks: string[] } }>("mnemopi/config.ts");
const { mnemopiBackend } = await runtime.importModule<{ mnemopiBackend: { save(context: Record<string, unknown>, input: Record<string, unknown>): Promise<{ stored: number }>; clear(agentDir: string, cwd: string, session: SessionLike): Promise<void> } }>("mnemopi/backend.ts");
const temporary: string[] = [];
const sessions: SessionLike[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) { await memory.close(session); AgentRegistry.global().unregister(session.sessionId); }
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function root() {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "omp-nav-memory-")));
  temporary.push(dir);
  return dir;
}
async function session(cwd: string, database: string, kind: "main" | "sub" = "main", mode = "per-project") {
  const settings = await Settings.loadIsolated({ cwd, agentDir: join(dirname(database), "agent"), readOnly: true, overrides: {
    "memory.backend": "mnemopi", "mnemopi.dbPath": database, "mnemopi.bank": "test-prefix",
    "mnemopi.scoping": mode, "mnemopi.noEmbeddings": true, "mnemopi.llmMode": "none", "mnemopi.autoRecall": false,
    "mnemopi.autoRetain": kind === "sub",
  } });
  const value = {
    settings, sessionId: `memory-${sessions.length}`, modelRegistry: { getApiKeyForProvider: async () => undefined },
    sessionManager: { getCwd: () => cwd, getSessionId: () => value.sessionId, getBranch: () => [], appendCustomEntry: () => {} },
    agent: { addBeforeModelCallHook: () => () => {}, state: { messages: [] } },
    addDisposer: () => {}, subscribe: () => () => {}, getXdevToolEntries: () => [],
  } as unknown as SessionLike;
  sessions.push(value);
  AgentRegistry.global().register({ id: value.sessionId, kind, status: "idle", session: value });
  return value;
}
import { dirname } from "node:path";

describe("native Mnemopi scope and owned lifetime", () => {
  test("primary and linked worktrees share canonical bank; same-bank child owns independent writable state", async () => {
    const dir = await root();
    const primary = join(dir, "primary"); const wt = join(dir, "wt"); const wt2 = join(dir, "wt2"); const other = join(dir, "other");
    await fs.mkdir(primary); await fs.mkdir(other);
    const git = promisify(execFile);
    await git("git", ["init", primary]);
    await git("git", ["-C", primary, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
    await git("git", ["-C", primary, "worktree", "add", "-b", "wt", wt]);
    await git("git", ["-C", primary, "worktree", "add", "-b", "wt2", wt2]);
    const database = join(dir, "memory", "mnemopi.db");
    const oldBank = computeMnemopiBankScope("test-prefix", wt, "per-project").bank;
    const oldBankDirectory = join(dir, "memory", "banks", oldBank);
    await fs.mkdir(oldBankDirectory, { recursive: true });
    const legacy = new Database(join(oldBankDirectory, "mnemopi.db"));
    legacy.exec("CREATE TABLE working_memory(metadata_json TEXT)");
    legacy.prepare("INSERT INTO working_memory VALUES(?)").run(JSON.stringify({ cwd: wt }));
    legacy.close();
    const main = await session(primary, database); const child = await session(wt, database, "sub"); const secondChild = await session(wt2, database, "sub"); const b = await session(other, database, "sub");
    await Promise.all([memory.ensure(main), memory.ensure(child), memory.ensure(secondChild), memory.ensure(b)]);
    const mainState = memory.getState(main)!; const childState = memory.getState(child)!;
    expect(mainState).not.toBe(childState);
    expect(childState.aliasOf).toBeUndefined();
    expect(childState.config.bank).toBe(mainState.config.bank);
    expect(memory.getState(secondChild)!.config.bank).toBe(mainState.config.bank);
    expect(memory.getState(secondChild)).not.toBe(childState);
    expect(memory.getState(secondChild)!.aliasOf).toBeUndefined();
    expect(childState.config.autoRetain).toBe(false);
    expect(memory.getState(b)!.config.bank).not.toBe(mainState.config.bank);
    expect(mainState.config.bank).toBe(computeMnemopiBankScope("test-prefix", primary, "per-project").bank);
    expect(childState.config.recallBanks).not.toContain(oldBank);
    expect(mainState.config.recallBanks).not.toContain(oldBank);
    expect(await fs.stat(join(oldBankDirectory, "mnemopi.db"))).toBeDefined();
    await memory.ensure(child);
    expect(memory.getState(child)).toBe(childState);
    expect((await mnemopiBackend.save({ session: child, cwd: wt, agentDir: join(dir, "agent") }, { content: "explicit child memory" })).stored).toBe(1);
    await memory.close(child);
    expect(memory.getState(main)).toBe(mainState);
    expect((await mnemopiBackend.save({ session: main, cwd: primary, agentDir: join(dir, "agent") }, { content: "main is still open" })).stored).toBe(1);
  });

  test("global/tagged scoping and plain folder bank IDs preserve the native prefix", async () => {
    const dir = await root();
    for (const mode of ["global", "per-project", "per-project-tagged"]) {
      const main = await session(dir, join(dir, mode, "mnemopi.db"), "main", mode);
      await memory.ensure(main);
      const expected = computeMnemopiBankScope("test-prefix", dir, mode);
      const state = memory.getState(main)!;
      expect(state.config.bank).toBe(expected.bank);
      expect(state.config.recallBanks).toEqual(expected.recallBanks);
    }
  });

  test("mandatory backend opening failure rejects startup instead of silently borrowing parent memory", async () => {
    const dir = await root();
    const block = join(dir, "file"); await fs.writeFile(block, "not a directory");
    const child = await session(dir, join(block, "mnemopi.db"), "sub");
    await expect(memory.ensure(child)).rejects.toThrow("Mnemopi startup failed");
    expect(memory.getState(child)).toBeUndefined();
  });

  test("clear protects shared live handles and adopts its replacement state in the source harness", async () => {
    const dir = await root();
    const database = join(dir, "memory", "mnemopi.db"), agentDir = join(dir, "agent");
    const main = await session(dir, database), child = await session(dir, database, "sub");
    await Promise.all([memory.ensure(main), memory.ensure(child)]);
    const state = memory.getState(main);
    await expect(mnemopiBackend.clear(agentDir, dir, child)).rejects.toThrow("another session owns");
    expect(memory.getState(main)).toBe(state);
    expect((await mnemopiBackend.save({ session: main, cwd: dir, agentDir }, { content: "shared refusal preserves writes" })).stored).toBe(1);
    await memory.close(child);
    await mnemopiBackend.clear(agentDir, dir, main);
    expect(memory.getState(main)).not.toBe(state);
    expect((await mnemopiBackend.save({ session: main, cwd: dir, agentDir }, { content: "solo clear reopens storage" })).stored).toBe(1);
    await memory.ensure(child);
    await expect(mnemopiBackend.clear(agentDir, dir, child)).rejects.toThrow("another session owns");
  });
});
