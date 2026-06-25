import { platform, release, hostname } from 'os';
import type { AgentConfig, Message, ToolDefinition } from '../types.js';

function buildSystemPrompt(config: AgentConfig): string {
  return `You are Book, an AI coding agent. You help users write, fix, and understand code.

You are running on: ${platform()} ${release()} (${hostname()})
Workspace: ${config.workspace}
Current date: ${new Date().toISOString().split('T')[0]}

You have access to tools for reading/writing files, running shell commands,
searching code, and interacting with git. Use them to help the user.

Be concise and direct. Write code when asked. Explain only when asked.`;
}

export function buildMessages(
  config: AgentConfig,
  history: Message[],
  tools: ToolDefinition[],
): { role: string; content: string | null }[] {
  const messages: { role: string; content: string | null }[] = [];

  messages.push({ role: 'system', content: buildSystemPrompt(config) });

  for (const msg of history) {
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: msg.content || null,
      });
    }
  }

  return messages;
}
