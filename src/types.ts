export type WorkspaceRequest =
  | { action: "move"; dir: string }
  | { action: "create"; branch: string; path?: string; ref?: string }
  | { action: "enter"; path: string }
  | { action: "exit" }
  | { action: "remove"; path: string };

export interface WorkspaceResult {
  action: WorkspaceRequest["action"];
  cwd?: string;
  error?: string;
  id: string;
  result?: unknown;
  status: "queued" | "applied" | "failed" | "cancelled";
  target?: string;
}

export interface SettingsLike {
  cloneForCwd?(cwd: string): Promise<SettingsLike>;
  flush(): Promise<void>;
  reloadForCwd(cwd: string): Promise<void>;
}

export interface SessionManagerLike {
  appendMessage(message: unknown): unknown;
  captureState(): { cwd: string; [key: string]: unknown };
  flush(): Promise<void>;
  getAdditionalDirectories(): string[];
  getCwd(): string;
  getSessionId(): string;
  rollbackMove(state: ReturnType<SessionManagerLike["captureState"]>): Promise<void>;
  setCwdWithoutRelocation(cwd: string): void;
}

export interface ToolCallContext {
  assistantMessage: { content: Array<{ type: string; name?: string }> };
  toolCall: { id: string; name: string; arguments: unknown };
  [key: string]: unknown;
}

export type ToolCallGate = (
  context: ToolCallContext,
  signal?: AbortSignal,
) =>
  | Promise<{ block?: boolean; reason?: string; [key: string]: unknown } | undefined>
  | { block?: boolean; reason?: string }
  | undefined;

/** The agent loop's live context; pushing to `messages` reaches this and later model calls. */
export interface ModelCallContext {
  messages: unknown[];
}

export interface SessionLike {
  addDisposer(dispose: () => void): void;
  agent: {
    beforeToolCall?: ToolCallGate;
    addBeforeModelCallHook(
      hook: (signal: AbortSignal | undefined, context: ModelCallContext) => Promise<void>,
    ): () => void;
    appendMessage(message: unknown): void;
    setSystemPrompt(prompt: string[]): void;
    state: { tools: unknown[]; systemPrompt: string[]; messages: unknown[] };
  };
  isCompacting: boolean;
  moveSession(cwd: string): Promise<void>;
  refreshBaseSystemPrompt(commitIf?: () => boolean): Promise<void>;
  refreshSkillsAndCommands(): Promise<void>;
  sessionId: string;
  sessionManager: SessionManagerLike;
  settings: SettingsLike;
  settleMemoryBackend(): Promise<void>;
}

export interface RegistryRef {
  id: string;
  kind: "main" | "sub" | "advisor";
  session: SessionLike | null;
  status: string;
}

export interface InteractiveOwner {
  applyCwdChange(cwd: string): Promise<boolean>;
  init(...args: unknown[]): Promise<unknown>;
  reloadTodos(): Promise<void>;
  session: SessionLike;
  sessionManager: SessionManagerLike;
  ui: { requestRender(): void };
  updateEditorBorderColor(): void;
  withBtwSessionMove(operation: () => Promise<boolean>): Promise<boolean>;
}

export interface ExtensionContextLike {
  agent: { id: string; kind: "main" | "sub"; [key: string]: unknown };
  cwd: string;
  mode: string;
  sessionManager: SessionManagerLike;
  [key: string]: unknown;
}

export interface HostNamespace {
  AgentRegistry: { global(): { get(id: string): RegistryRef | undefined; list(): RegistryRef[] } };
  ExtensionRunner: { prototype: object };
  InteractiveMode: { prototype: InteractiveOwner };
  [key: string]: unknown;
}

export interface RuntimeModules {
  host: HostNamespace;
  importLibraryModule<T>(specifier: string): Promise<T>;
  importModule<T>(specifier: string): Promise<T>;
  mode: "host" | "source-test";
  packageRoot: string;
}

export interface ToolApprovalDecisionLike {
  override?: boolean;
  policy?: "allow" | "deny" | "prompt";
  policyKey?: string;
  reason?: string;
  tier: "read" | "write" | "exec";
}
export type ToolApprovalLike =
  | "read"
  | "write"
  | "exec"
  | ToolApprovalDecisionLike
  | ((args: unknown) => "read" | "write" | "exec" | ToolApprovalDecisionLike);
export interface ToolDefinitionLike {
  approval?: ToolApprovalLike;
  description: string;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: unknown,
    ctx: ExtensionContextLike,
  ): Promise<unknown>;
  formatApprovalDetails?: (args: unknown) => string | string[] | undefined;
  label: string;
  loadMode?: "essential" | "discoverable";
  name: string;
  parameters: unknown;
}

export interface ExtensionApiLike {
  on(
    event: string,
    handler: (
      event: { type: string; [key: string]: unknown },
      ctx: ExtensionContextLike,
    ) => Promise<void> | void,
  ): void;
  pi: HostNamespace;
  registerCommand(
    name: string,
    command: {
      description: string;
      handler(args: string, ctx: ExtensionContextLike): Promise<void>;
    },
  ): void;
  registerTool(tool: ToolDefinitionLike): void;
  [key: string]: unknown;
}
