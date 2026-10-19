# omp-agent-nav

An [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) extension that lets the agent change
projects and git worktrees **inside one session**, and run subagents in another project.

A shell `cd` only changes the directory of one command. It does not switch the session's
instructions, settings, skills, MCP servers, LSP or memory. With this extension a move keeps the
session ID and history, and everything above follows the new directory before the next model
request.

> Status: personal project, experimental. It relies on omp internals (see
> [Compatibility](#compatibility)). Not affiliated with oh-my-pi.

## Tools

All navigation tools are available to the main session only; subagents do not see them.

| Tool | What it does |
|---|---|
| `session_move {dir}` | Move the session into an allowed directory. Session ID and history are kept; cwd, session storage, AGENTS/rules, settings, skills, commands, project MCP, LSP and memory are re-scoped. |
| `worktree_list {}` | List the primary checkout and registered worktrees with `dirty`, `untracked`, `inUse`, `available`. |
| `worktree_create {branch, path?, ref?}` | Create a clean worktree on a **new** branch from `ref` (default `HEAD`). An explicit `path` is used exactly; relative paths start at the primary checkout, and a path outside omp's managed worktree base must lie inside an allowed root. Without `path` the worktree goes to the managed base (`OMP_WORKTREE_DIR` / `worktree.base`). Uncommitted changes are not carried over, and the session does not enter the worktree. |
| `worktree_enter {path}` / `worktree_exit {}` | Enter a registered worktree of the current project / return to the primary checkout. |
| `worktree_remove {path}` | Remove a clean, unused, attached worktree. The branch and its commits are kept; there is no force mode. |
| `workspace_grant {dirs}` | Add existing directories to the allowed workspace roots after an explicit approval dialog. A worktree path resolves to its primary checkout. |
| `task` + `cwd` | The built-in `task` tool gains a `cwd` parameter (per item in batch mode). The subagent loads the target project's AGENTS, agents, settings, skills, extensions, MCP and memory bank before its first model request. |

The six mutating tools (`session_move`, `worktree_create/enter/exit/remove`, `workspace_grant`)
must be called alone in a tool batch. `workspace_grant` applies immediately and returns
`{granted, skipped, roots}`. The others return a `queued` receipt; the operation is applied after
the batch and before the next model request, and the final `applied` / `failed` / `cancelled`
result is added to the conversation. A failed move is rolled back to the previous directory.

A human can also run `/nav-move <dir>` while the session is idle.

## Install

Requirements:

- [Bun](https://bun.sh) >= 1.3.14
- `@oh-my-pi/pi-coding-agent` >= 18.11.0 and < 19 installed globally, with `omp` on `PATH`
  (`npm i -g @oh-my-pi/pi-coding-agent` or `bun add -g @oh-my-pi/pi-coding-agent`)

Clone the repository and add the extension to `~/.omp/agent/config.yml`:

```yaml
extensions:
  - "~/omp-agent-nav/src/index.ts"
```

The clone directory also works as the path (`package.json` declares `omp.extensions`). A
project-level `extensions` list replaces the global one, so such a project has to list this path
too.

For a one-off run: `omp -e ~/omp-agent-nav/src/index.ts`.

## Usage

Start in project A and allow project B:

```sh
omp --add-dir /path/to/project-b
```

Without `--add-dir` (or `/add-dir`, or `workspace_grant`), navigation is limited to the starting
project. In the TUI, `session_move` into a directory outside the allowed roots asks for approval
and grants the target's primary checkout. Without an interactive UI (print mode, RPC) both that
approval and `workspace_grant` fail closed, so allow directories up front with `--add-dir`.

Subagent in another project:

```json
{"agent":"worker","task":"Check the handler in B","solutionSpace":"mechanical","cwd":"/path/to/project-b"}
```

With `task.batch=true`, `cwd` goes into each `tasks[]` item instead.

Memory: a primary checkout and its worktrees share one Mnemopi bank; different projects stay
separate under the default `mnemopi.scoping: per-project`. Each session and subagent owns its own
memory backend.

## Limitations

- Workspace roots guard navigation and `task.cwd` only. They are **not** a sandbox: omp file and
  shell tools are not restricted by them.
- After a move, the main session keeps the JS/TS extensions and custom tools it loaded at startup;
  extensions of the target project are not loaded. New subagents load the target's extensions.
- Worktree busy-state is tracked within one omp process; another omp process may still use a
  worktree.
- Pure Jujutsu workspaces are not supported by the worktree tools.

## Compatibility

The extension hooks into omp internals: non-public modules of `@oh-my-pi/pi-coding-agent`,
prototype wrappers around session classes, and Mnemopi library modules from the installed package.
Upgrades of omp can break it even within a major version.

- Verified: omp 18.11.0 – 18.12.1 (`SUPPORTED_OMP_VERSIONS` in [src/runtime.ts](src/runtime.ts)).
- Other 18.x versions >= 18.11.0 load with a warning; older versions, pre-release / non-semver
  versions and the next major are rejected at startup.

## Development

```sh
bun install        # Biome only; omp is an optional peer and is not installed locally
bun run check      # bundle with external packages + Biome gate
bun run test       # full suite (~1 min)
bun run matrix     # run the suite against every verified omp version (npm installs under /tmp)
```

The test suite runs the real installed omp with a fake model provider in temporary fixtures. It
needs `omp` on `PATH` (in the supported range), `git`, Go with `gopls` (LSP scenario) and
`python3` (TUI scenario). Results so far come from macOS arm64.

Design, behaviour contracts and verification records live in [spec/](spec/README.md) (in Russian).

## License

[MIT](LICENSE)
