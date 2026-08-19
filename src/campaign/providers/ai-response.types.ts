// ═══════════════════════════════════════════════════════════════════════════
// SHARED AI RESPONSE TYPES
// Both providers (Anthropic + Ollama) normalize their responses into this
// exact shape. Nothing downstream (conversation.service.ts, tool execution)
// ever needs to know which provider actually generated a response.
// ═══════════════════════════════════════════════════════════════════════════

export interface AITextBlock {
  type: 'text';
  text: string;
}

export interface AIToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type AIContentBlock = AITextBlock | AIToolUseBlock;

export interface AIMessage {
  id: string;
  role: 'assistant';
  content: AIContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | string;
  usage: { input_tokens: number; output_tokens: number };
  /** Which provider actually generated this — for logging/cost tracking. */
  provider: 'anthropic' | 'ollama';
  model: string;
}

/** Provider-agnostic tool definition. Each provider adapts this to its own API shape. */
export interface AIToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export type AIRole = 'user' | 'assistant';

export interface AIInputMessage {
  role: AIRole;
  content: unknown;
}