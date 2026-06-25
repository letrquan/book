export type PermissionMode = 'default' | 'auto' | 'plan' | 'accept-edits';

export type PermissionResult = 'allow' | 'deny' | 'always';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  success: boolean;
  output: string;
  error?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  timestamp: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  workspaceRoot: string;
  env: Record<string, string>;
}

export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTurns: number;
  workspace: string;
  animation: {
    typewriterSpeed: number;
    spinnerStyle: 'braille' | 'dots';
  };
  tools: {
    browser: { enabled: boolean; headless: boolean };
    design: { enabled: boolean };
  };
}

export interface ProviderStreamEvent {
  type: 'text' | 'tool_call' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  error?: string;
}

export interface AgentLoopCallbacks {
  onText: (text: string) => void;
  onToolCall: (call: ToolCall) => void;
  onToolResult: (result: ToolResult) => void;
  onError: (error: string) => void;
  onTurnStart: (turn: number) => void;
  onDone: () => void;
  onPermissionRequired: (toolCall: ToolCall) => Promise<'allow' | 'deny' | 'always'>;
  onTokenCount: (count: number) => void;
}
