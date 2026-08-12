import { AIInputMessage, AIMessage, AIToolDefinition } from './ai-response.types';

/**
 * Every AI backend (Anthropic, Ollama, future providers) implements this.
 * The orchestrator only ever talks to this interface — it never knows
 * provider-specific details like API shapes or auth headers.
 */
export interface AIProvider {
  readonly name: 'anthropic' | 'ollama';

  generate(
    systemPrompt: string,
    messages: AIInputMessage[],
    tools: AIToolDefinition[],
  ): Promise<AIMessage>;
}
