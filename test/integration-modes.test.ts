import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

const temporary: string[] = [];
afterEach(async () => {
  while (temporary.length) {
    await fs.rm(temporary.pop()!, { recursive: true, force: true });
  }
});

async function git(cwd: string, ...args: string[]): Promise<string> {
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

async function fixture(mode: "tui" | "rpc") {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), `omp-nav-${mode}-`)));
  temporary.push(root);
  const a = join(root, "A");
  const b = join(root, "B");
  const agentDir = join(root, "agent");
  const worktree = join(a, ".claude", "worktree", "integration");
  const report = join(root, "report.json");
  const config = join(root, "config.yml");
  await fs.mkdir(agentDir);
  await fs.writeFile(
    config,
    "memory:\n  backend: off\nsetupVersion: 2\nstartup:\n  quiet: true\n  setupWizard: false\n  showSplash: false\n  checkUpdate: false\nmarketplace:\n  autoUpdate: false\nlsp:\n  shared: false\nskills:\n  enableAgentsUser: false\n  enablePiUser: false\n  enableCodexUser: false\n  enableClaudeUser: false\n",
  );
  for (const [cwd, marker, timeout] of [
    [a, "A", 60],
    [b, "B", 70],
  ] as const) {
    await fs.mkdir(join(cwd, ".omp", "skills", `scope-${marker}`), { recursive: true });
    await fs.mkdir(join(cwd, ".omp", "commands"), { recursive: true });
    await fs.writeFile(
      join(cwd, "AGENTS.md"),
      `Only PROJECT_${marker}_INTEGRATION instructions apply here.`,
    );
    await fs.writeFile(
      join(cwd, ".omp", "skills", `scope-${marker}`, "SKILL.md"),
      `---\nname: scope-${marker}\ndescription: Scope ${marker} integration skill\n---\nIntegration skill ${marker}.\n`,
    );
    await fs.writeFile(join(cwd, ".omp", "commands", `command-${marker}.md`), `Command ${marker}.`);
    await fs.writeFile(join(cwd, ".omp", "config.yml"), `tools:\n  maxTimeout: ${timeout}\n`);
    await fs.writeFile(
      join(cwd, "go.mod"),
      `module example.invalid/navigation${marker}\n\ngo 1.27\n`,
    );
    await fs.writeFile(join(cwd, "fixture.go"), "package navigation\n\nvar Marker int = 1\n");
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
      "integration fixture",
    );
  }
  const fixturePath = join(root, "fixture.ts");
  const callsPath = join(root, "calls.jsonl");
  const nextToolsPath = join(root, "next-tools.json");
  const btwStartedPath = join(root, "btw-started");
  const btwReleasePath = join(root, "btw-release");
  await fs.writeFile(
    fixturePath,
    `import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { getActiveClients, getActiveOrPendingClient } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { getConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";
export default async function(pi) {
  let runtime, bridge, readSetting, startupError;
  let owner;
  const calls = () => fsSync.existsSync(${JSON.stringify(callsPath)}) ? fsSync.readFileSync(${JSON.stringify(callsPath)}, "utf8").trim().split("\\n").map(JSON.parse) : [];
  const lastCall = () => calls().at(-1).context;
  const originalInit = pi.pi.InteractiveMode.prototype.init;
  pi.pi.InteractiveMode.prototype.init = async function(...args) { owner = this; return await originalInit.apply(this, args); };
  let session;
  const snapshot = async (context) => { const cwd = session.sessionManager.getCwd(); const client = await getActiveOrPendingClient(getConfig(cwd).servers.gopls, cwd); return { id: session.sessionManager.getSessionId(), cwd, file: session.sessionManager.getSessionFile(), prompt: context?.systemPrompt ?? session.agent.state.systemPrompt, skills: session.skills.map(skill => skill.name), commands: session.slashCommands.map(command => command.name), timeout: await readSetting(runtime, session.settings, "tools.maxTimeout"), clients: getActiveClients(), goplsCwd: client?.cwd }; };
  const mock = createMockModel({ id: "fixture", provider: "integration-fixture", handler: async context => {
    if (startupError) throw new Error(String(startupError));
    session = pi.pi.AgentRegistry.global().list().find(ref => ref.kind === "main" && ref.session).session;
    fsSync.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ context, snapshot: await snapshot(context) }) + "\\n");
    if (calls().length > 40) throw new Error("Unexpected extra model calls");
    if (JSON.stringify(context.messages.at(-1)).includes("BTW_HELD_INTEGRATION")) { await fs.writeFile(${JSON.stringify(btwStartedPath)}, "started"); while (!await fs.exists(${JSON.stringify(btwReleasePath)})) await Bun.sleep(5); return { content: ["BTW fixture answer"] }; }
    if (fsSync.existsSync(${JSON.stringify(nextToolsPath)})) { const tools = JSON.parse(fsSync.readFileSync(${JSON.stringify(nextToolsPath)}, "utf8")); fsSync.unlinkSync(${JSON.stringify(nextToolsPath)}); return { content: tools }; }
    return { content: ["INTEGRATION_FAKE_RESPONSE"] };
  } });
  pi.registerProvider("integration-fixture", { api: "integration-fixture-api", apiKey: "fixture-unused", baseUrl: "mock://", streamSimple: (_model, context, options) => mock.stream(mock, context, options), models: [{ id: "fixture", name: "Integration", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32000 }] });
  try {
    const modules = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "runtime.ts"))});
    runtime = modules.createRuntime(pi.pi); readSetting = modules.readSetting;
    const { installHostBridge } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "host.ts"))});
    bridge = await installHostBridge(runtime);
  } catch (error) { startupError = error; }
  pi.on("session_start", (_event, ctx) => { session = pi.pi.AgentRegistry.global().get(ctx.agent.id).session; registerCustomApi("integration-fixture-api", (_model, context, options) => mock.stream(mock, context, options), "integration-fixture-test", (_model, context, options) => mock.stream(mock, context, options)); });
  pi.registerCommand("integration-run", { description: "Run isolated runtime checks", handler: async (_args, ctx) => {
    try {
    if (startupError) throw startupError;
    session = pi.pi.AgentRegistry.global().get(ctx.agent.id).session;
    const results = { mode: ctx.mode, ownerMatches: owner?.session === session };
    const tool = async (name, args) => {
      await fs.writeFile(${JSON.stringify(nextToolsPath)}, JSON.stringify([{ type: "toolCall", name, arguments: { ...args, i: "Run this isolated navigation integration check." } }]));
      await session.prompt("Run the next fixture tool.");
      const messages = lastCall().messages;
      return messages.filter(message => message.role === "toolResult").at(-1);
    };
    const move = async dir => { let receipt; let error; try { receipt = await bridge.coordinator(ctx).request({ action: "move", dir }); } catch (failure) { error = String(failure); } await session.prompt("Apply fixture context transition."); return { receipt, error, state: await snapshot() }; };
    results.before = await snapshot();
    if (ctx.mode === "tui") await owner.handleBtwCommand("BTW_HELD_INTEGRATION");
    { const deadline = Date.now() + 5000; while (!await fs.exists(${JSON.stringify(btwStartedPath)})) { if (Date.now() > deadline) throw new Error("BTW fake provider did not start"); await Bun.sleep(5); } }
    try {
      results.btwReceipt = await bridge.coordinator(ctx).request({ action: "move", dir: ${JSON.stringify(b)} });
      await bridge.coordinator(ctx).applyPending();
      results.btwBusy = { state: await snapshot(), messages: structuredClone(session.agent.state.messages) };
    } finally { await fs.writeFile(${JSON.stringify(btwReleasePath)}, "released"); }
    await Bun.sleep(25);
    if (ctx.mode === "tui") { const deadline = Date.now() + 5000; while (!owner.canCopyBtw()) { if (Date.now() > deadline) throw new Error("BTW fake provider did not settle"); await Bun.sleep(5); } owner.handleBtwEscape(); }
    if (await fs.realpath(session.sessionManager.getCwd()) !== ${JSON.stringify(a)}) await move(${JSON.stringify(a)});
    results.projectMove = await tool("session_move", { dir: ${JSON.stringify(b)} });
    results.inB = await snapshot();
    results.returned = await move(${JSON.stringify(a)});
    results.primaryWorkspace = await tool("lsp", { action: "diagnostics", file: "*" });
    results.primaryGopls = await tool("lsp", { action: "diagnostics", file: "*.go", timeout: 30 });
    results.primaryLsp = await snapshot();
    results.created = await tool("worktree_create", { branch: "integration", path: ".claude/worktree/integration" });
    results.afterCreate = await snapshot();
    results.list = await bridge.coordinator(ctx).navigation.listWorktrees();
    await fs.writeFile(${JSON.stringify(join(worktree, "fixture.go"))}, "package navigation\\n\\nvar Marker int = MissingOnlyInWorktree\\n");
    const runGit = async args => { const p = Bun.spawn(["git", ...args], { cwd: ${JSON.stringify(worktree)}, stdout: "pipe", stderr: "pipe" }); const [code, _out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]); if (code) throw new Error(err); };
    await runGit(["add", "fixture.go"]);
    await runGit(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "branch-specific diagnostic"]);
    results.entered = await tool("worktree_enter", { path: ${JSON.stringify(worktree)} });
    results.inWorktree = await snapshot();
    results.worktreeWorkspace = await tool("lsp", { action: "diagnostics", file: "*" });
    results.worktreeGopls = await tool("lsp", { action: "diagnostics", file: "*.go", timeout: 30 });
    results.worktreeLsp = await snapshot();
    results.exited = await tool("worktree_exit", {});
    results.afterExit = await snapshot();
    results.returnedGopls = await tool("lsp", { action: "diagnostics", file: "*.go", timeout: 30 });
    results.returnedLsp = await snapshot();
    results.worktreeStillExists = await fs.stat(${JSON.stringify(worktree)}).then(stat => stat.isDirectory());
    results.removed = await tool("worktree_remove", { path: ${JSON.stringify(worktree)} });
    results.afterRemove = await snapshot();
    results.worktreeRemoved = !await fs.exists(${JSON.stringify(worktree)});
    results.refused = await move(${JSON.stringify(join(root, "outside"))});
    const coordinator = bridge.coordinator(ctx);
    await bridge.coordinator(ctx).request({ action: "move", dir: ${JSON.stringify(b)} });
    await coordinator.cancel("Integration cancellation before apply.");
    await session.prompt("Verify cancelled transition.");
    results.cancelled = { state: await snapshot(), messages: lastCall().messages };
    await fs.writeFile(${JSON.stringify(nextToolsPath)}, JSON.stringify([{ type: "toolCall", name: "session_move", arguments: { dir: ${JSON.stringify(b)}, i: "Move" } }, { type: "toolCall", name: "write", arguments: { path: ${JSON.stringify(join(a, "mixed-must-not-exist"))}, content: "must not write", i: "Mixed write" } }]));
    await session.prompt("Reject this mixed fixture batch.");
    results.mixed = { state: await snapshot(), messages: lastCall().messages, writeExists: await fs.exists(${JSON.stringify(join(a, "mixed-must-not-exist"))}) };
    results.fakeCalls = calls().length;
    results.snapshots = calls().map(call => call.snapshot);
    await fs.writeFile(${JSON.stringify(report)}, JSON.stringify(results));
    } catch (error) { await fs.writeFile(${JSON.stringify(report)}, JSON.stringify({ fixtureError: String(error) })); }
    finally { ctx.shutdown(); }
  } });
}`,
  );
  await fs.mkdir(join(root, "outside"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CONFIG_DIR: relative(homedir(), join(root, "configuration")),
    TERM: "xterm-256color",
    GOTOOLCHAIN: "local",
    GOPROXY: "off",
    GOSUMDB: "off",
    GOCACHE: join(root, "go-cache"),
    GOPATH: join(root, "go-path"),
  };
  delete env.OMP_PROFILE;
  delete env.PI_PROFILE;
  delete env.PI_CONFIG_FILES;
  delete env.OMP_AGENT_NAV_RUNTIME_ROOT;
  for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
    const target = join(root, key.toLowerCase());
    await fs.mkdir(join(target, "omp"), { recursive: true });
    env[key] = target;
  }
  await fs.appendFile(
    config,
    `extensions:\n  - ${JSON.stringify(join(import.meta.dir, "..", "src", "index.ts"))}\n  - ${JSON.stringify(fixturePath)}\n`,
  );
  const args = [
    Bun.which("omp")!,
    "--model",
    "integration-fixture/fixture",
    "--api-key",
    "fixture-unused",
    "--add-dir",
    b,
    "--config",
    config,
  ];
  return { root, a, b, worktree, report, env, args };
}

async function run(mode: "tui" | "rpc") {
  const f = await fixture(mode);
  let args: string[];
  if (mode === "tui") {
    const driver = join(f.root, "tui-driver.py");
    await fs.writeFile(
      driver,
      `import os,subprocess,json,pty,select,time,fcntl,termios,struct,sys
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,140,0,0))
child=subprocess.Popen(json.loads(sys.argv[1]),stdin=slave,stdout=slave,stderr=slave)
os.close(slave)
output=bytearray()
deadline=time.monotonic()+75
try:
 while child.poll() is None and time.monotonic()<deadline:
  ready,_,_=select.select([master],[],[],0.2)
  if ready:
   try: chunk=os.read(master,65536)
   except OSError: break
   if not chunk: break
   output.extend(chunk)
 if child.poll() is None: child.kill()
 child.wait()
 while select.select([master],[],[],0)[0]:
  try:
   chunk=os.read(master,65536)
   if not chunk: break
   output.extend(chunk)
  except OSError: break
finally: os.close(master)
sys.stdout.buffer.write(output)
sys.exit(child.returncode)
`,
    );
    args = ["python3", driver, JSON.stringify([...f.args, "/integration-run"])];
  } else {
    args = [...f.args, "--mode", "rpc"];
  }
  const child = Bun.spawn(args, {
    cwd: f.a,
    env: f.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (mode === "rpc") {
    child.stdin.write(
      `${JSON.stringify({ id: "btw", type: "btw", question: "BTW_HELD_INTEGRATION" })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ id: "integration", type: "prompt", message: "/integration-run" })}\n`,
    );
  }
  const reportWatcher =
    mode === "rpc"
      ? setInterval(async () => {
          if (await fs.exists(f.report)) {
            clearInterval(reportWatcher);
            child.stdin.end();
          }
        }, 50)
      : undefined;
  const timeout = setTimeout(() => {
    child.stdin.end();
    child.kill();
  }, 80_000);
  let code: number;
  let stdout: string;
  let stderr: string;
  try {
    [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
  } finally {
    clearTimeout(timeout);
    clearInterval(reportWatcher);
    child.stdin.end();
  }
  if (code || !(await fs.exists(f.report))) {
    throw new Error(`${mode} integration failed (${code}): ${stderr}\n${stdout.slice(-6000)}`);
  }
  expect(stderr).not.toContain("Failed to load extension");
  const result = JSON.parse(await fs.readFile(f.report, "utf8"));
  if (result.fixtureError) {
    throw new Error(result.fixtureError);
  }
  expect(result.mode).toBe(mode);
  if (mode === "tui") {
    expect(result.ownerMatches).toBe(true);
  }
  for (const snapshot of result.snapshots) {
    expect(snapshot.id).toBe(result.before.id);
  }
  expect(result.btwBusy.state.cwd).toBe(result.before.cwd);
  expect(result.btwBusy.state.file).toBe(result.before.file);
  expect(JSON.stringify(result.btwBusy.messages)).toContain("BTW");
  expect(JSON.stringify(result.btwBusy.messages)).toContain('\\"status\\":\\"failed\\"');
  expect(result.inB.cwd).toBe(f.b);
  expect(JSON.stringify(result.inB.prompt)).toContain("PROJECT_B_INTEGRATION");
  expect(JSON.stringify(result.inB.prompt)).not.toContain("PROJECT_A_INTEGRATION");
  expect(result.inB.skills).toContain("scope-B");
  expect(result.inB.skills).not.toContain("scope-A");
  expect(result.inB.commands).toContain("command-B");
  expect(result.inB.commands).not.toContain("command-A");
  expect(result.inB.timeout).toBe(70);
  expect(result.inB.file).not.toBe(result.before.file);
  expect(result.returned.state.cwd).toBe(f.a);
  expect(result.returned.state.file).toBe(result.before.file);
  expect(result.returned.state.timeout).toBe(60);
  expect(result.returned.state.skills).toContain("scope-A");
  expect(result.returned.state.commands).toContain("command-A");
  expect(JSON.stringify(result.returned.state.prompt)).toContain("PROJECT_A_INTEGRATION");
  expect(JSON.stringify(result.returned.state.prompt)).not.toContain("PROJECT_B_INTEGRATION");
  expect(JSON.stringify(result.primaryWorkspace)).toContain("No issues found");
  expect(JSON.stringify(result.primaryGopls)).not.toContain("MissingOnlyInWorktree");
  expect(
    result.primaryLsp.clients.some((client: { name: string }) => client.name.includes("gopls")),
  ).toBe(true);
  expect(result.afterCreate.cwd).toBe(f.a);
  expect(result.list.some((entry: { path: string }) => entry.path === f.worktree)).toBe(true);
  expect(result.inWorktree.cwd).toBe(f.worktree);
  expect(JSON.stringify(result.worktreeWorkspace)).toContain("MissingOnlyInWorktree");
  expect(JSON.stringify(result.worktreeGopls)).toContain("MissingOnlyInWorktree");
  expect(result.worktreeGopls.details.serverName).toBe("gopls");
  expect(result.worktreeLsp.goplsCwd).toBe(f.worktree);
  expect(result.afterExit.cwd).toBe(f.a);
  expect(JSON.stringify(result.returnedGopls)).not.toContain("MissingOnlyInWorktree");
  expect(result.returnedGopls.details.serverName).toBe("gopls");
  expect(result.returnedLsp.goplsCwd).toBe(f.a);
  expect(result.worktreeStillExists).toBe(true);
  expect(result.worktreeRemoved).toBe(true);
  expect(await git(f.a, "rev-parse", "integration")).not.toBe(await git(f.a, "rev-parse", "main"));
  expect(await git(f.a, "show", "integration:fixture.go")).toContain("MissingOnlyInWorktree");
  expect(await git(f.a, "show", "main:fixture.go")).not.toContain("MissingOnlyInWorktree");
  const persisted = (await fs.readFile(result.afterRemove.file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const header = persisted.find((entry) => entry.type === "session");
  expect(header.id).toBe(result.before.id);
  expect(header.cwd).toBe(f.a);
  expect(await git(f.a, "status", "--porcelain")).toBe("");
  expect(result.refused.state.cwd).toBe(f.a);
  expect(result.refused.error).toContain("permission");
  expect(result.cancelled.state.cwd).toBe(f.a);
  expect(JSON.stringify(result.cancelled.messages)).toContain('\\"status\\":\\"cancelled\\"');
  expect(result.mixed.state.cwd).toBe(f.a);
  expect(result.mixed.writeExists).toBe(false);
  if (mode === "rpc") {
    expect(stdout).toContain('"command":"prompt","success":true');
  }
}

test("ordinary omp TUI moves A/B/A, runs gopls against the worktree branch and safely removes it", async () => {
  await run("tui");
}, 90_000);
test("ordinary omp RPC exposes the same navigation contract, context and worktree lifecycle", async () => {
  await run("rpc");
}, 90_000);
