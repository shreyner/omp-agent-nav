import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";

test("normal bundled omp config owns independent Mnemopi banks, native tools and embedding lifetime", async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "omp-nav-bundled-memory-")));
  try {
    const primary = join(root, "primary"),
      wt = join(root, "wt"),
      wt2 = join(root, "wt2"),
      other = join(root, "other"),
      agentDir = join(root, "agent");
    await Promise.all([primary, other, agentDir].map((path) => fs.mkdir(path)));
    const git = promisify(execFile);
    await git("git", ["init", primary]);
    await git("git", [
      "-C",
      primary,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    await git("git", ["-C", primary, "worktree", "add", "-b", "one", wt]);
    await git("git", ["-C", primary, "worktree", "add", "-b", "two", wt2]);
    const fixture = join(root, "fixture.ts"),
      config = join(root, "config.yml"),
      report = join(root, "report.json");
    await fs.writeFile(
      fixture,
      `
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import {join} from "node:path";
import {Database} from "bun:sqlite";
import {SessionManager} from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {resolveMemoryBackend} from "@oh-my-pi/pi-coding-agent/memory-backend/resolve";
import {registerCustomApi} from "@oh-my-pi/pi-ai/api-registry";
import * as utils from "@oh-my-pi/pi-utils";
import {createRuntime} from ${JSON.stringify(relative(root, join(import.meta.dir, "..", "src", "runtime.ts")))};
import {installMemoryBridge} from ${JSON.stringify(relative(root, join(import.meta.dir, "..", "src", "memory.ts")))};
const root=${JSON.stringify(root)}, primary=${JSON.stringify(primary)}, wt=${JSON.stringify(wt)}, wt2=${JSON.stringify(wt2)}, other=${JSON.stringify(other)};
export default async function(pi) {
  const runtime=createRuntime(pi.pi);
  const ownEmbed=await runtime.importLibraryModule("mnemopi/embed-client.ts");
  const ownStateModule=await runtime.importLibraryModule("mnemopi/state.ts");
  let synthetic, clientTerminates=0;
  const originalTerminate=ownEmbed.mnemopiEmbedClient.terminate.bind(ownEmbed.mnemopiEmbedClient);
  ownEmbed.mnemopiEmbedClient.terminate=async()=>{clientTerminates++;await synthetic?.terminate();await originalTerminate();};
  let shutdown; const nativeImport=runtime.importModule.bind(runtime);
  runtime.importModule=async key=>key==="@oh-my-pi/pi-utils"?{...utils,postmortem:{register(_name,dispose){shutdown=dispose;}}}:await nativeImport(key);
  const memory=await installMemoryBridge(runtime);
  const {createMockModel}=await import(Bun.resolveSync("@oh-my-pi/pi-ai/providers/mock",runtime.packageRoot));
  const mock=createMockModel({id:"fixture",provider:"memory-fixture",handler:()=>({content:["MEMORY_FIXTURE_OK"]})});
  const stream=(_model,context,options)=>mock.stream(mock,context,options);
  pi.registerProvider("memory-fixture", {api:"memory-fixture-api",apiKey:"unused",baseUrl:"mock://",streamSimple:stream,models:[{id:"fixture",name:"Fixture",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:32000}]});
  pi.on("session_start",()=>registerCustomApi("memory-fixture-api",stream,"memory-fixture",stream));
  pi.registerCommand("nav-memory-proof",{description:"Own memory runtime fixture",handler:async(_args,ctx)=>{
    let step="initial";
    try {
    const main=pi.pi.AgentRegistry.global().get(ctx.agent.id).session;
    const database=join(root,"memory","mnemopi.db");
    const overrides={"memory.backend":"mnemopi","mnemopi.dbPath":database,"mnemopi.bank":"fixture-prefix","mnemopi.noEmbeddings":true,"mnemopi.llmMode":"none","mnemopi.autoRecall":false,"mnemopi.autoRetain":false,"async.enabled":false,"lsp.enabled":false,"autolearn.enabled":false};
    await main.prompt("First main turn must await configured memory startup.");
    const startupProviderCalls=mock.calls.length;assert.equal(startupProviderCalls,1);assert.ok(main.getMnemopiSessionState());
    const configModule=await runtime.importLibraryModule("mnemopi/config.ts");
    const oldBank=configModule.computeMnemopiBankScope("fixture-prefix",wt,"per-project").bank;
    const oldDir=join(root,"memory","banks",oldBank);await fs.mkdir(oldDir,{recursive:true});
    const old=new Database(join(oldDir,"mnemopi.db"));old.exec("CREATE TABLE working_memory(metadata_json TEXT)");old.prepare("INSERT INTO working_memory VALUES (?)").run(JSON.stringify({cwd:wt}));old.close();
    main.settings=main.settings.overlay(overrides);
    await memory.ensure(main,primary);
    const mainState=memory.getState(main);assert.ok(mainState);assert.equal(main.getMnemopiSessionState(),mainState);
    const children=[];
    const child=async(cwd,id,extra={},created=()=>{})=>{
      const settings=(await main.settings.cloneForCwd(cwd)).overlay({...overrides,...extra});
      const result=await pi.pi.createAgentSession({cwd,agentDir:${JSON.stringify(agentDir)},settings,modelRegistry:main.modelRegistry,authStorage:main.authStorage,model:main.model,getApiKey:async()=>"unused",sessionManager:SessionManager.inMemory(cwd),agentId:id,taskDepth:1,parentMnemopiSessionState:mainState,toolNames:[],restrictToolNames:true,enableMCP:false,enableLsp:false,hasUI:false,skipPythonPreflight:true,disableExtensionDiscovery:true});
      children.push(result.session);created(result.session);await memory.ensure(result.session,cwd);return result.session;
    };
    const one=await child(wt,"One"), two=await child(wt2,"Two"), b=await child(other,"B");
    for(const target of [one,two]) {assert.notEqual(memory.getState(target),mainState);assert.equal(memory.getState(target).config.bank,mainState.config.bank);assert.equal(memory.getState(target).aliasOf,undefined);assert.equal(memory.getState(target).config.autoRetain,false);assert.ok(!memory.getState(target).config.recallBanks.includes(oldBank));}
    assert.notEqual(memory.getState(b).config.bank,mainState.config.bank);assert.ok(await fs.stat(join(oldDir,"mnemopi.db")));
    for(const mode of ["global","per-project-tagged"]) {
      const scoped=await child(other,"Scope-"+mode,{"mnemopi.scoping":mode});
      const expected=configModule.computeMnemopiBankScope("fixture-prefix",other,mode);
      assert.equal(memory.getState(scoped).config.bank,expected.bank);assert.deepEqual(memory.getState(scoped).config.recallBanks,expected.recallBanks);
      await scoped.dispose();
    }
    const backend=await resolveMemoryBackend(main.settings);
    await assert.rejects(backend.clear(${JSON.stringify(agentDir)},wt,one),/another session owns/);
    const save=await backend.save({session:one,cwd:wt,agentDir:${JSON.stringify(agentDir)}},{content:"native save sees own bank"});assert.equal(save.stored,1);
    const status=await backend.status({session:one,cwd:wt,agentDir:${JSON.stringify(agentDir)}});assert.equal(status.active,true);assert.equal(status.retainBank,mainState.config.bank);
    const stats=await backend.stats(${JSON.stringify(agentDir)},wt,one);assert.ok(stats);
    const soloDir=join(root,"solo");await fs.mkdir(soloDir);
    const solo=await child(soloDir,"Solo");
    const originalSoloState=memory.getState(solo);
    const clearingEntered=Promise.withResolvers(), allowClear=Promise.withResolvers();
    const disposeSolo=originalSoloState.dispose.bind(originalSoloState);
    originalSoloState.dispose=async options=>{clearingEntered.resolve();await allowClear.promise;await disposeSolo(options);};
    const clearing=backend.clear(${JSON.stringify(agentDir)},soloDir,solo);
    await clearingEntered.promise;
    const peerCreated=Promise.withResolvers();
    const peerStarting=child(soloDir,"RacePeer",{},peerCreated.resolve);
    const racePeer=await peerCreated.promise;assert.equal(racePeer.getMnemopiSessionState(),undefined);
    allowClear.resolve();await clearing;await peerStarting;
    assert.equal((await backend.save({session:racePeer,cwd:soloDir,agentDir:${JSON.stringify(agentDir)}},{content:"opening waits for full clear transaction"})).stored,1);
    await racePeer.dispose();
    assert.notEqual(memory.getState(solo),originalSoloState);assert.equal(solo.getMnemopiSessionState(),memory.getState(solo));
    const soloPeer=await child(soloDir,"SoloPeer");
    await assert.rejects(backend.clear(${JSON.stringify(agentDir)},soloDir,soloPeer),/another session owns/);
    assert.equal((await backend.save({session:solo,cwd:soloDir,agentDir:${JSON.stringify(agentDir)}},{content:"rehydrated owner remains writable"})).stored,1);
    await soloPeer.dispose();
    await backend.clear(${JSON.stringify(agentDir)},soloDir,solo);
    assert.equal((await backend.save({session:solo,cwd:soloDir,agentDir:${JSON.stringify(agentDir)}},{content:"clear is allowed after peer closes"})).stored,1);
    await solo.dispose();assert.equal(ownStateModule.getMnemopiSessionState(solo),undefined);assert.equal(solo.getMnemopiSessionState(),undefined);
    const llm=await child(other,"LLM",{"mnemopi.llmMode":"smol","modelRoles.memory":"memory-fixture/fixture"});
    const configuredLlm=memory.getState(llm).config.providerOptions.llm;
    const complete=typeof configuredLlm==="function"?configuredLlm:configuredLlm.complete;assert.equal(typeof complete,"function");
    const beforeLlm=mock.calls.length;
    assert.equal(await complete("Use the registered native fake provider."),"MEMORY_FIXTURE_OK");
    const llmCalls=mock.calls.length-beforeLlm;assert.equal(llmCalls,1);
    step="failed backend";
    const blocked=join(root,"blocked");await fs.writeFile(blocked,"file");
    const beforeFailure=mock.calls.length;
    const failedSettings=(await main.settings.cloneForCwd(other)).overlay({...overrides,"mnemopi.dbPath":join(blocked,"db")});
    const failed=(await pi.pi.createAgentSession({cwd:other,agentDir:${JSON.stringify(agentDir)},settings:failedSettings,modelRegistry:main.modelRegistry,model:main.model,getApiKey:async()=>"unused",sessionManager:SessionManager.inMemory(other),agentId:"Broken",taskDepth:1,toolNames:[],restrictToolNames:true,enableMCP:false,enableLsp:false,hasUI:false,skipPythonPreflight:true,disableExtensionDiscovery:true})).session;children.push(failed);
    await assert.rejects(failed.prompt("must not reach provider"),/Mnemopi startup failed/);assert.equal(mock.calls.length,beforeFailure);
    step="main rebind";
    await main.settings.reloadForCwd(other);await memory.ensure(main,other);assert.equal(memory.getState(main).config.bank,memory.getState(b).config.bank);assert.equal(memory.getState(two).config.bank,mainState.config.bank);
    step="embedding";
    let message, receive, transportTerminates=0;
    synthetic=new ownEmbed.MnemopiEmbedClient(()=>({send(value){message=value;},onMessage(fn){receive=fn;return()=>{};},onError(){return()=>{};},ref(){},unref(){},async terminate(){transportTerminates++;}}),10000);
    const originalEmbed=ownEmbed.mnemopiEmbedClient.embed.bind(ownEmbed.mnemopiEmbedClient);
    ownEmbed.mnemopiEmbedClient.embed=synthetic.embed.bind(synthetic);
    const pending=ownEmbed.mnemopiEmbedClient.embed("synthetic",undefined,["held while native child closes"],1);
    await one.dispose();assert.equal(clientTerminates,0);assert.equal(transportTerminates,0);assert.equal(memory.getState(one),undefined);
    assert.equal(ownStateModule.getMnemopiSessionState(one),undefined);
    await main.applyMemoryBackend({retainMnemopi:false});await memory.ensure(main,other);assert.equal(clientTerminates,0);assert.equal(memory.getState(main).config.bank,memory.getState(b).config.bank);
    receive({type:"vectors",id:message.id,vectors:[[1,2,3]]});assert.deepEqual(await pending,[[1,2,3]]);
    await backend.save({session:two,cwd:wt2,agentDir:${JSON.stringify(agentDir)}},{content:"another agent is still writable"});
    for(const value of children) await value.dispose();
    await main.dispose();assert.equal(clientTerminates,0);await shutdown();assert.equal(clientTerminates,1);assert.equal(transportTerminates,1);
    ownEmbed.mnemopiEmbedClient.embed=originalEmbed;ownEmbed.mnemopiEmbedClient.terminate=originalTerminate;
    await fs.writeFile(${JSON.stringify(report)},JSON.stringify({banks:4,startupProviderCalls,llmCalls,nativeStored:save.stored,failedProviderCalls:mock.calls.length-beforeFailure,heldEmbedding:true,clientTerminates,transportTerminates,nativeStats:true}));
    } catch(error) {
      const current=pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session;
      const {lookup}=await runtime.importModule("config/registry.ts");
      const logs=await fs.readdir(join(root,"configuration","logs")).catch(()=>[]);
      const logText=await Promise.all(logs.map(file=>fs.readFile(join(root,"configuration","logs",file),"utf8")));
      await fs.writeFile(join(root,"failure.json"),JSON.stringify({step,error:String(error),stack:error.stack,db:current&&lookup("mnemopi.dbPath").get(current.settings),logText:logText.join("\\n").split("\\n").filter(line=>line.includes("Mnemopi"))}));throw error;
    }
  }});
}
`,
    );
    // The normal CLI reads extensions from config; no source CLI or launcher is invoked.
    await fs.writeFile(
      config,
      `extensions:\n  - ${JSON.stringify(fixture)}\nmemory:\n  backend: mnemopi\nmnemopi:\n  dbPath: ${JSON.stringify(join(root, "memory", "mnemopi.db"))}\n  bank: fixture-prefix\n  noEmbeddings: true\n  llmMode: none\n  autoRecall: false\n  autoRetain: false\nasync:\n  enabled: false\nlsp:\n  enabled: false\nautolearn:\n  enabled: false\nsetupVersion: 2\nstartup:\n  quiet: true\n  setupWizard: false\n  checkUpdate: false\nmarketplace:\n  autoUpdate: false\n`,
    );
    const env: Record<string, string | undefined> = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CONFIG_DIR: relative(homedir(), join(root, "configuration")),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
    };
    delete env.OMP_PROFILE;
    delete env.PI_PROFILE;
    delete env.PI_CONFIG_FILES;
    const proc = Bun.spawn(
      [
        Bun.which("omp")!,
        "-p",
        "--model",
        "memory-fixture/fixture",
        "--api-key",
        "unused",
        "--no-session",
        "--no-skills",
        "--config",
        config,
        "/nav-memory-proof",
      ],
      { cwd: primary, env, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (code || !(await fs.exists(report))) {
      throw new Error(
        `Bundled memory fixture failed (${code}): ${stderr}\n${stdout}\n${await fs.readFile(join(root, "failure.json"), "utf8").catch(() => "")}`,
      );
    }
    expect(code).toBe(0);
    expect(stderr).not.toContain("Failed to load extension");
    expect(JSON.parse(await fs.readFile(report, "utf8"))).toEqual({
      banks: 4,
      startupProviderCalls: 1,
      llmCalls: 1,
      nativeStored: 1,
      failedProviderCalls: 0,
      heldEmbedding: true,
      clientTerminates: 1,
      transportTerminates: 1,
      nativeStats: true,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30000);
