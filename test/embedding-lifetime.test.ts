import { expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("actual native session disposal leaves the process embedding singleton alive until shutdown", async () => {
  const runtimeFile = pathToFileURL(join(import.meta.dir, "..", "src", "runtime.ts")).href;
  const memoryFile = pathToFileURL(join(import.meta.dir, "..", "src", "memory.ts")).href;
  const script = `
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createRuntime,findInstalledOmp} from ${JSON.stringify(runtimeFile)};
import {installMemoryBridge} from ${JSON.stringify(memoryFile)};
const runtime=createRuntime({},findInstalledOmp());
runtime.host.AgentRegistry=(await runtime.importModule("registry/agent-registry.ts")).AgentRegistry;
const utils=await runtime.importModule("@oh-my-pi/pi-utils");
const {mnemopiEmbedClient}=await runtime.importModule("mnemopi/embed-client.ts");
let terminations=0;
const original=mnemopiEmbedClient.terminate.bind(mnemopiEmbedClient);
mnemopiEmbedClient.terminate=async()=>{terminations++;await original();};
let shutdown;
const importModule=runtime.importModule.bind(runtime);
runtime.importModule=async specifier=>specifier==="@oh-my-pi/pi-utils"?{...utils,postmortem:{register(_name,callback){shutdown=callback;}}}:await importModule(specifier);
await installMemoryBridge(runtime);
const root=await fs.mkdtemp(join(tmpdir(),"omp-nav-lifetime-"));
const agentDir=join(root,"agent");await fs.mkdir(agentDir);utils.setAgentDir(agentDir);
const {Settings}=await importModule("config/settings.ts");
const settings=await Settings.loadReadOnly({cwd:root,agentDir,overrides:{"memory.backend":"off","async.enabled":false,"lsp.enabled":false,"autolearn.enabled":false}});
const {AuthStorage}=await importModule("@oh-my-pi/pi-ai");
const auth=await AuthStorage.create(join(root,"auth.db"));
const {ModelRegistry}=await importModule("config/model-registry.ts");
const {createMockModel,registerMockApi}=await importModule("@oh-my-pi/pi-ai/providers/mock");registerMockApi();
const model=createMockModel({handler:()=>({content:["alive"]})});
const registry=new ModelRegistry(auth,join(root,"models.yml"),{cacheDbPath:join(root,"cache.db"),settings});
Object.assign(registry,{refresh:async()=>{},getAll:()=>[model],getAvailable:()=>[model],find:()=>model,getApiKey:async()=>"test"});
const {SessionManager}=await importModule("session/session-manager.ts");
const {createAgentSession}=await importModule("sdk.ts");
const create=async(id,taskDepth)=>(await createAgentSession({cwd:root,agentDir,settings:await settings.cloneForCwd(root),modelRegistry:registry,authStorage:auth,model,getApiKey:async()=>"test",sessionManager:SessionManager.inMemory(root),agentId:id,taskDepth,toolNames:[],restrictToolNames:true,enableMCP:false,enableLsp:false,hasUI:false,skipPythonPreflight:true,disableExtensionDiscovery:true})).session;
const main=await create("Main",0);const one=await create("One",1);const two=await create("Two",1);
await one.dispose();assert.equal(terminations,0);
await main.applyMemoryBackend({retainMnemopi:false});assert.equal(terminations,0);
await two.prompt("still alive with main");
await main.dispose();assert.equal(terminations,0);
await two.prompt("still alive after main closes");
await two.dispose();assert.equal(terminations,0);
await shutdown();assert.equal(terminations,1);assert.equal(model.calls.length,2);
await auth.close();await fs.rm(root,{recursive:true,force:true});
process.stdout.write(JSON.stringify({passed:true,terminations,mockCalls:model.calls.length}));
`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  // A host newer than the verified matrix adds one expected warning line.
  expect(
    stderr.replace(/^omp-agent-nav: host \S+ is newer than the verified matrix.*\n/m, ""),
  ).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ passed: true, terminations: 1, mockCalls: 2 });
}, 30000);
