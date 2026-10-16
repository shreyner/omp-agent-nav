export type WorkspaceRequest =
  | { action: "move"; dir: string }
  | { action: "create"; branch: string; path?: string; ref?: string }
  | { action: "enter"; path: string }
  | { action: "exit" }
  | { action: "remove"; path: string };

export interface WorkspaceResult {
  id: string;
  status: "queued" | "applied" | "failed" | "cancelled";
  action: WorkspaceRequest["action"];
  target?: string;
  cwd?: string;
  error?: string;
  result?: unknown;
}

export interface SettingsLike {
  flush(): Promise<void>;
  reloadForCwd(cwd: string): Promise<void>;
  cloneForCwd?(cwd: string): Promise<SettingsLike>;
}

export interface SessionManagerLike {
  getCwd(): string;
  getSessionId(): string;
  getAdditionalDirectories(): string[];
  captureState(): { cwd: string; [key: string]: unknown };
  rollbackMove(state: ReturnType<SessionManagerLike["captureState"]>): Promise<void>;
  flush(): Promise<void>;
  setCwdWithoutRelocation(cwd: string): void;
  appendMessage(message: unknown): unknown;
}

export interface ToolCallContext {
  toolCall: { id: string; name: string; arguments: unknown };
  assistantMessage: { content: Array<{ type: string; name?: string }> };
  [key: string]: unknown;
}

export type ToolCallGate = (
  context: ToolCallContext,
  signal?: AbortSignal,
) =>
  | Promise<{ block?: boolean; reason?: string; [key: string]: unknown } | undefined>
  | { block?: boolean; reason?: string }
  | undefined;

export interface SessionLike {
  sessionManager: SessionManagerLike;
  settings: SettingsLike;
  sessionId: string;
  isStreaming: boolean;
  isCompacting: boolean;
  agent: {
    beforeToolCall?: ToolCallGate;
    addBeforeModelCallHook(hook: (signal?: AbortSignal) => Promise<void>): () => void;
    addBeforeModelCall(
      hook: (
        context: { messages: Array<{ role: string; content: unknown }> },
        signal?: AbortSignal,
      ) => Promise<void>,
    ): () => void;
    appendMessage(message: unknown): void;
    setSystemPrompt(prompt: string[]): void;
    state: { tools: unknown[]; systemPrompt: string[]; messages: unknown[] };
  };
  moveSession(cwd: string): Promise<void>;
  refreshSkillsAndCommands(): Promise<void>;
  refreshBaseSystemPrompt(commitIf?: () => boolean): Promise<void>;
  settleMemoryBackend(): Promise<void>;
  applyMemoryBackend(options?: { retainMnemopi?: boolean }): Promise<void>;
  addDisposer(dispose: () => void): void;
  subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void;
}

export interface RegistryRef {
  id: string;
  kind: "main" | "sub" | "advisor";
  status: string;
  session: SessionLike | null;
}

export interface InteractiveOwner {
  session: SessionLike;
  sessionManager: SessionManagerLike;
  init(...args: unknown[]): Promise<unknown>;
  applyCwdChange(cwd: string): Promise<boolean>;
  withBtwSessionMove(operation: () => Promise<boolean>): Promise<boolean>;
  reloadTodos(): Promise<void>;
  updateEditorBorderColor(): void;
  ui: { requestRender(): void };
}

export interface ExtensionContextLike {
  cwd: string;
  mode: string;
  agent: { id: string; kind: "main" | "sub"; [key: string]: unknown };
  sessionManager: SessionManagerLike;
  requestWorkspaceChange?: (request: WorkspaceRequest) => Promise<WorkspaceResult>;
  listWorktrees?: () => Promise<unknown>;
  [key: string]: unknown;
}

export interface HostNamespace {
  AgentRegistry: { global(): { get(id: string): RegistryRef | undefined; list(): RegistryRef[] } };
  ExtensionRunner: { prototype: { createContext(...args: unknown[]): ExtensionContextLike } };
  InteractiveMode: { prototype: InteractiveOwner };
  [key: string]: unknown;
}

export interface RuntimeModules {
  packageRoot: string;
  host: HostNamespace;
  mode: "host" | "source-test";
  importLibraryModule<T>(specifier: string): Promise<T>;
  importModule<T>(specifier: string): Promise<T>;
}

export interface ToolApprovalDecisionLike {
  tier: "read" | "write" | "exec";
  reason?: string;
  override?: boolean;
  policy?: "allow" | "deny" | "prompt";
  policyKey?: string;
}
export type ToolApprovalLike =
  | "read"
  | "write"
  | "exec"
  | ToolApprovalDecisionLike
  | ((args: unknown) => "read" | "write" | "exec" | ToolApprovalDecisionLike);
export interface ToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  approval?: ToolApprovalLike;
  formatApprovalDetails?: (args: unknown) => string | string[] | undefined;
  loadMode?: "essential" | "discoverable";
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: unknown,
    ctx: ExtensionContextLike,
  ): Promise<unknown>;
}

export interface ExtensionApiLike {
  pi: HostNamespace;
  registerTool(tool: ToolDefinitionLike): void;
  registerCommand(
    name: string,
    command: {
      description: string;
      handler(args: string, ctx: ExtensionContextLike): Promise<void>;
    },
  ): void;
  on(
    event: string,
    handler: (
      event: { type: string; [key: string]: unknown },
      ctx: ExtensionContextLike,
    ) => Promise<void> | void,
  ): void;
  [key: string]: unknown;
}
