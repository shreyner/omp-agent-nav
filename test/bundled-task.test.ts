import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code) {
    throw new Error(error);
  }
  return output.trim();
}

test("configured ordinary omp task pins target context and owned memory through batch, main move and revival", async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "omp-nav-bundled-task-")));
  try {
    const a = join(root, "A"),
      b = join(root, "B"),
      c = join(root, "C"),
      wt = join(root, "B-worktree"),
      agentDir = join(root, "agent");
    const fixture = join(root, "fixture.ts"),
      config = join(root, "config.yml"),
      report = join(root, "report.json"),
      calls = join(root, "calls.jsonl");
    const held = join(root, "held"),
      release = join(root, "release"),
      nextTask = join(root, "next-task.json");
    await fs.mkdir(agentDir);
    for (const [cwd, marker, timeout] of [
      [a, "A", 60],
      [b, "B", 70],
      [c, "C", 80],
    ] as const) {
      await fs.mkdir(join(cwd, ".omp", "agents"), { recursive: true });
      await fs.mkdir(join(cwd, ".omp", "skills", `scope-${marker}`), { recursive: true });
      await fs.writeFile(join(cwd, "AGENTS.md"), `PROJECT_${marker}_BUNDLED_TASK rules only.`);
      await fs.writeFile(
        join(cwd, ".omp", "agents", "target.md"),
        `---\nname: target\ndescription: Target ${marker}\nmodel: bundled-task/${marker}\nthinking-level: off\nspawns: '*'\n---\nAGENT_${marker}_BUNDLED_TASK instructions.`,
      );
      await fs.writeFile(
        join(cwd, ".omp", "skills", `scope-${marker}`, "SKILL.md"),
        `---\nname: scope-${marker}\ndescription: Bundled task scope ${marker}\n---\nSkill ${marker}.`,
      );
      await fs.writeFile(join(cwd, ".omp", "config.yml"), `tools:\n  maxTimeout: ${timeout}\n`);
      const server = join(root, `${marker}-mcp.ts`);
      await fs.writeFile(
        server,
        `import {createInterface} from "node:readline";\ncreateInterface({input:process.stdin}).on("line",line=>{const request=JSON.parse(line);if(request.id===undefined)return;let result={};if(request.method==="initialize")result={protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"fixture-${marker}",version:"1"}};if(request.method==="tools/list")result={tools:[{name:"marker_${marker}",description:"Project ${marker} only",inputSchema:{type:"object",properties:{}}}]};if(request.method==="tools/call")result={content:[{type:"text",text:"${marker}"}]};process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");});\n`,
      );
      await fs.writeFile(
        join(cwd, ".mcp.json"),
        JSON.stringify({
          mcpServers: { [`project${marker}`]: { command: process.execPath, args: [server] } },
        }),
      );
      await git(cwd, "init", "-b", "main");
      await git(cwd, "add", ".");
      await git(
        cwd,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "bundled target fixture",
      );
    }
    await git(b, "worktree", "add", "-b", "bundled-target", wt);
    await fs.writeFile(
      fixture,
      `
import * as fs from "node:fs/promises";
import * as sync from "node:fs";
import {createMockModel} from "@oh-my-pi/pi-ai/providers/mock";
import {registerCustomApi} from "@oh-my-pi/pi-ai/api-registry";
import {AgentLifecycleManager} from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
export default async function(pi) {
  let runtime, ownedState, readSetting, startupError;
  const ledger=()=>sync.existsSync(${JSON.stringify(calls)})?sync.readFileSync(${JSON.stringify(calls)},"utf8").trim().split("\\n").map(JSON.parse):[];
  const stream=(model,context,options)=>{
    const mock=createMockModel({id:model.id,provider:"bundled-task",handler:async()=>{
      if(startupError) throw startupError;
      const registry=pi.pi.AgentRegistry.global();
      const ref=registry.list().find(ref=>ref.session&&(ref.session.agent.sessionId===options?.sessionId||ref.session.sessionId===options?.sessionId));
      if(!ref) throw new Error("Provider request has no native session: "+String(options?.sessionId));
      const session=ref.session, state=session.getMnemopiSessionState();
      if(!state||state!==ownedState.getMnemopiSessionState(session)) throw new Error("Native task state is not owned before provider: "+ref.id);
      const database=state.getScopedRetainTarget().memory.beam.db;
      const others=registry.list().filter(value=>value.session&&value.session!==session).map(value=>value.session.getMnemopiSessionState()).filter(Boolean);
      const entry={id:ref.id,kind:ref.kind,sessionId:session.sessionId,cwd:session.sessionManager.getCwd(),file:session.sessionManager.getSessionFile(),model:model.id,bank:state.config.bank,alias:!!state.aliasOf,autoRetain:state.config.autoRetain,sameState:others.includes(state),sameConnection:others.some(other=>other.getScopedRetainTarget().memory.beam.db===database),database:database.filename,skills:session.skills.map(skill=>skill.name),tools:session.getAllToolNames(),timeout:await readSetting(runtime,session.settings,"tools.maxTimeout"),roots:session.sessionManager.getAdditionalDirectories(),prompt:context.systemPrompt};
      sync.appendFileSync(${JSON.stringify(calls)},JSON.stringify(entry)+"\\n");
      if(ledger().length>30) throw new Error("Unexpected provider recursion");
      if(ref.kind==="main"&&sync.existsSync(${JSON.stringify(nextTask)})){const task=JSON.parse(sync.readFileSync(${JSON.stringify(nextTask)},"utf8"));sync.unlinkSync(${JSON.stringify(nextTask)});return {content:[{type:"toolCall",name:"task",arguments:{...task,i:"Checking bundled target scope"}}]};}
      if(ref.kind!=="main"&&JSON.stringify(context.messages.at(-1)).includes("RUNNING_HOLD_B")) { await fs.writeFile(${JSON.stringify(held)},"held");const deadline=Date.now()+15000;while(!await fs.exists(${JSON.stringify(release)})){if(Date.now()>deadline)throw new Error("Held B was not released");await Bun.sleep(5);} }
      return {content:[ref.kind==="main"?"MAIN_OK":"CHILD_FINISHED_IN_"+entry.cwd]};
    }});
    return mock.stream(mock,context,options);
  };
  pi.registerProvider("bundled-task",{api:"bundled-task-api",apiKey:"fixture-unused",baseUrl:"mock://",streamSimple:stream,models:["main","A","B","C"].map(id=>({id,name:id,reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:32000}))});
  try {
    const modules=await import(${JSON.stringify(relative(root, join(import.meta.dir, "..", "src", "runtime.ts")))});
    runtime=modules.createRuntime(pi.pi);readSetting=modules.readSetting;
    ownedState=await runtime.importLibraryModule("mnemopi/state.ts");
  } catch(error){startupError=error;}
  pi.on("session_start",()=>registerCustomApi("bundled-task-api",stream,"bundled-task-test",stream));
  pi.registerCommand("bundled-task-proof",{description:"Isolated configured task and memory check",handler:async(_args,ctx)=>{
    let step="initial";
    try {
      if(startupError) throw startupError;
      const registry=pi.pi.AgentRegistry.global(), main=registry.get(ctx.agent.id).session;
      const {lookup}=await runtime.importModule("config/registry.ts");
      await main.prompt("MAIN_SCOPE_A");
      const parentId=main.sessionId, bankA=main.getMnemopiSessionState().config.bank;
      const runTask=async(raw,label)=>{await fs.writeFile(${JSON.stringify(nextTask)},JSON.stringify(raw));await main.prompt("Run bundled task "+label);const result=main.agent.state.messages.filter(message=>message.role==="toolResult"&&message.toolName==="task").at(-1);if(!result)throw new Error("Registered task did not return a tool result");if(result.isError)throw new Error(JSON.stringify(result));return result;};
      step="single B";
      lookup("task.batch").override(main.settings,false);
      const single=await runTask({cwd:${JSON.stringify(b)},name:"single-B",agent:"target",task:"Inspect target B",solutionSpace:"mechanical"},"single B");
      const singleRef=registry.get("single-B"), singleState=singleRef.session.getMnemopiSessionState();
      const bankB=singleState.config.bank;
      const afterSingle={cwd:main.sessionManager.getCwd(),bank:main.getMnemopiSessionState().config.bank};
      step="batch A/B/worktree B";
      lookup("task.batch").override(main.settings,true);
      const batch=await runTask({context:"Shared fixture",tasks:[{cwd:${JSON.stringify(a)},name:"batch-A",agent:"target",task:"Inspect A",solutionSpace:"mechanical"},{cwd:${JSON.stringify(b)},name:"batch-B",agent:"target",task:"Inspect B",solutionSpace:"mechanical"},{cwd:${JSON.stringify(wt)},name:"batch-WT-B",agent:"target",task:"Inspect worktree B",solutionSpace:"mechanical"}]},"batch A B worktree B");
      const afterBatch={cwd:main.sessionManager.getCwd(),bank:main.getMnemopiSessionState().config.bank};
      step="running B and main move C";
      lookup("task.batch").override(main.settings,false);
      lookup("async.enabled").override(main.settings,true);
      const running=await runTask({cwd:${JSON.stringify(b)},name:"live-B",agent:"target",task:"RUNNING_HOLD_B",solutionSpace:"mechanical"},"running B");
      {const deadline=Date.now()+10000;while(!await fs.exists(${JSON.stringify(held)})){if(Date.now()>deadline)throw new Error("Running child B did not reach provider");await Bun.sleep(5);}}
      const live=registry.get("live-B"), originalFile=live.sessionFile, originalChildId=live.session.sessionId;
      const {installHostBridge}=await import(${JSON.stringify(relative(root, join(import.meta.dir, "..", "src", "host.ts")))});
      await (await installHostBridge(runtime)).coordinator(ctx).request({action:"move",dir:${JSON.stringify(c)}});
      await main.prompt("MAIN_AFTER_MOVE_C");
      const afterMove={id:main.sessionId,cwd:main.sessionManager.getCwd(),bank:main.getMnemopiSessionState().config.bank,childCwd:live.session.sessionManager.getCwd(),childBank:live.session.getMnemopiSessionState().config.bank,childFile:live.sessionFile};
      await fs.writeFile(${JSON.stringify(release)},"release");
      const {findNativeToolSession}=await import(${JSON.stringify(relative(root, join(import.meta.dir, "..", "src", "task.ts")))});
      const job=findNativeToolSession(main).asyncJobManager.getAllJobs().find(job=>job.agentId==="live-B");
      if(!job)throw new Error("Background B has no native job");
      await job.promise;
      const completed={status:job.status,resultText:job.resultText,errorText:job.errorText};
      await main.waitForIdle();
      const writtenAfterMove=await fs.readFile(originalFile,"utf8");
      step="park and revive B";
      await AgentLifecycleManager.global().park("live-B");
      const parked=registry.get("live-B").session===null;
      const mainBankAfterPark=main.getMnemopiSessionState().config.bank;
      const revived=await AgentLifecycleManager.global().ensureLive("live-B");
      await revived.prompt("REVIVE_B_PROOF");
      const revival={cwd:revived.sessionManager.getCwd(),bank:revived.getMnemopiSessionState().config.bank,id:revived.sessionId,file:registry.get("live-B").sessionFile,alias:!!revived.getMnemopiSessionState().aliasOf,autoRetain:revived.getMnemopiSessionState().config.autoRetain};
      const writtenAfterRevive=await fs.readFile(originalFile,"utf8");
      await fs.writeFile(${JSON.stringify(report)},JSON.stringify({parentId,bankA,bankB,single,batch,running,completed,afterSingle,afterBatch,afterMove,parked,mainBankAfterPark,originalFile,originalChildId,revival,writtenAfterMove,writtenAfterRevive,calls:ledger()}));
    } catch(error){await fs.writeFile(${JSON.stringify(report)},JSON.stringify({fixtureError:String(error),stack:error.stack,step,calls:ledger()}));}
  }});
}
`,
    );
    await fs.writeFile(
      config,
      `extensions:\n  - ${JSON.stringify(fixture)}\n  - ${JSON.stringify(join(import.meta.dir, "..", "src", "index.ts"))}\nmemory:\n  backend: mnemopi\nmnemopi:\n  dbPath: ${JSON.stringify(join(root, "memory", "mnemopi.db"))}\n  bank: task-fixture\n  noEmbeddings: true\n  llmMode: none\n  autoRecall: false\n  autoRetain: true\nasync:\n  enabled: false\ntask:\n  structured: false\n  enableLsp: false\n  maxConcurrency: 3\nlsp:\n  enabled: false\nautolearn:\n  enabled: false\nskills:\n  enableAgentsUser: false\n  enableCodexUser: false\n  enableClaudeUser: false\n  enablePiUser: false\nmodelRoles:\n  default: bundled-task/main\n  task: bundled-task/main\nsetupVersion: 2\nstartup:\n  quiet: true\n  setupWizard: false\n  showSplash: false\n  checkUpdate: false\nmarketplace:\n  autoUpdate: false\n`,
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
    const child = Bun.spawn(
      [
        Bun.which("omp")!,
        "-p",
        "--model",
        "bundled-task/main",
        "--api-key",
        "fixture-unused",
        "--add-dir",
        b,
        "--add-dir",
        c,
        "--config",
        config,
        "/bundled-task-proof",
      ],
      { cwd: a, env, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code || !(await fs.exists(report))) {
      throw new Error(
        `Configured bundled task fixture failed (${code}): ${stderr}\n${stdout.slice(-4000)}`,
      );
    }
    const result = JSON.parse(await fs.readFile(report, "utf8"));
    if (result.fixtureError) {
      throw new Error(
        `${result.step}: ${result.fixtureError}\n${result.stack}\n${JSON.stringify(result.calls.map((entry: { id: string; cwd: string; model: string; bank: string }) => ({ id: entry.id, cwd: entry.cwd, model: entry.model, bank: entry.bank })))}`,
      );
    }
    expect(stderr).not.toContain("Failed to load extension");
    expect(result.single.details.results[0].exitCode).toBe(0);
    expect(
      result.batch.details.results.map((entry: { exitCode: number }) => entry.exitCode),
    ).toEqual([0, 0, 0]);
    expect(result.running.details.async.state).toBe("running");
    expect(result.completed.status).toBe("completed");
    expect(result.completed.errorText).toBeUndefined();
    for (const item of [result.afterSingle, result.afterBatch]) {
      expect(await fs.realpath(item.cwd)).toBe(a);
      expect(item.bank).toBe(result.bankA);
    }
    expect(result.bankB).not.toBe(result.bankA);
    for (const [id, cwd, marker, bank, timeout] of [
      ["single-B", b, "B", result.bankB, 70],
      ["batch-A", a, "A", result.bankA, 60],
      ["batch-B", b, "B", result.bankB, 70],
      ["batch-WT-B", wt, "B", result.bankB, 70],
      ["live-B", b, "B", result.bankB, 70],
    ] as const) {
      const entry = result.calls.find((entry: { id: string }) => entry.id === id);
      expect(entry).toBeDefined();
      expect(entry.cwd).toBe(cwd);
      expect(entry.model).toBe(marker);
      expect(entry.bank).toBe(bank);
      expect(entry.alias).toBe(false);
      expect(entry.autoRetain).toBe(false);
      expect(entry.sameState).toBe(false);
      expect(entry.sameConnection).toBe(false);
      expect(entry.skills).toContain(`scope-${marker}`);
      expect(entry.timeout).toBe(timeout);
      expect(entry.roots).toEqual([]);
      expect(
        entry.tools.some((tool: string) => tool.includes(`marker_${marker.toLowerCase()}`)),
      ).toBe(true);
      expect(JSON.stringify(entry.prompt)).toContain(`PROJECT_${marker}_BUNDLED_TASK`);
      expect(JSON.stringify(entry.prompt)).toContain(`AGENT_${marker}_BUNDLED_TASK`);
      for (const other of ["A", "B", "C"].filter((other) => other !== marker)) {
        expect(JSON.stringify(entry.prompt)).not.toContain(`PROJECT_${other}_BUNDLED_TASK`);
        expect(entry.skills).not.toContain(`scope-${other}`);
        expect(
          entry.tools.some((tool: string) => tool.includes(`marker_${other.toLowerCase()}`)),
        ).toBe(false);
      }
    }
    expect(result.afterMove.id).toBe(result.parentId);
    expect(result.afterMove.cwd).toBe(c);
    expect(result.afterMove.bank).not.toBe(result.bankA);
    expect(result.afterMove.bank).not.toBe(result.bankB);
    expect(result.afterMove.childCwd).toBe(b);
    expect(result.afterMove.childBank).toBe(result.bankB);
    expect(result.afterMove.childFile).toBe(result.originalFile);
    expect(result.writtenAfterMove).toContain(`CHILD_FINISHED_IN_${b}`);
    expect(result.parked).toBe(true);
    expect(result.mainBankAfterPark).toBe(result.afterMove.bank);
    expect(result.revival).toEqual({
      cwd: b,
      bank: result.bankB,
      id: result.originalChildId,
      file: result.originalFile,
      alias: false,
      autoRetain: false,
    });
    expect(result.writtenAfterRevive).toContain("REVIVE_B_PROOF");
    const revivedCall = result.calls
      .filter((entry: { id: string }) => entry.id === "live-B")
      .at(-1);
    expect(revivedCall.bank).toBe(result.bankB);
    expect(revivedCall.model).toBe("B");
    expect(JSON.stringify(revivedCall.prompt)).toContain("PROJECT_B_BUNDLED_TASK");
    expect(JSON.stringify(revivedCall.prompt)).not.toContain("PROJECT_C_BUNDLED_TASK");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 60_000);
