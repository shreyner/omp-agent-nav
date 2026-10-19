import { expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// omp loads the extension again with a `?mtime=` tag for every subagent session. Each load is a
// fresh module graph, so the bridges must detect an earlier install process-wide. Bun keys
// modules by query only for path specifiers (a file:// URL ignores it), hence plain paths below.
test("re-imported extension graphs share one host and memory installation", async () => {
  const source = (file: string) => pathToFileURL(join(import.meta.dir, "..", "src", file)).href;
  const script = `
import assert from "node:assert/strict";
import {createRuntime,findInstalledOmp} from ${JSON.stringify(source("runtime.ts"))};
class ExtensionRunner { createContext() { return {}; } }
class InteractiveMode { async init() {} }
const root=findInstalledOmp();
const probe=createRuntime({},root);
const {AgentRegistry}=await probe.importModule("registry/agent-registry.ts");
const runtime=createRuntime({AgentRegistry,ExtensionRunner,InteractiveMode},root);
const {AgentSession}=await runtime.importModule("session/agent-session.ts");
const bridgeFile=${JSON.stringify(join(import.meta.dir, "..", "src", "host", "bridge.ts"))}, memoryFile=${JSON.stringify(join(import.meta.dir, "..", "src", "memory.ts"))};
const [hostA,hostB,memoryA,memoryB]=await Promise.all([
  import(bridgeFile+"?graph=a"),import(bridgeFile+"?graph=b"),import(memoryFile+"?graph=a"),import(memoryFile+"?graph=b"),
]);
assert.notEqual(hostA.installHostBridge,hostB.installHostBridge);
const bridges=await Promise.all([hostA.installHostBridge(runtime),hostB.installHostBridge(runtime)]);
assert.equal(bridges[0],bridges[1]);
const createContext=ExtensionRunner.prototype.createContext;
const ephemeral=AgentSession.prototype.runEphemeralTurn;
const refresh=AgentSession.prototype.refreshBaseSystemPrompt;
assert.equal(await hostA.installHostBridge(runtime),bridges[0]);
assert.equal(ExtensionRunner.prototype.createContext,createContext);
assert.equal(AgentSession.prototype.runEphemeralTurn,ephemeral);
assert.equal(AgentSession.prototype.refreshBaseSystemPrompt,refresh);
const memories=await Promise.all([memoryA.installMemoryBridge(runtime),memoryB.installMemoryBridge(runtime)]);
assert.equal(memories[0],memories[1]);
const prompt=AgentSession.prototype.prompt;
assert.equal(await memoryB.installMemoryBridge(runtime),memories[0]);
assert.equal(AgentSession.prototype.prompt,prompt);
process.stdout.write("ok");
`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(
    stderr.replace(/^omp-agent-nav: host \S+ is newer than the verified matrix.*\n/m, ""),
  ).toBe("");
  expect(code).toBe(0);
  expect(stdout).toBe("ok");
}, 30000);
