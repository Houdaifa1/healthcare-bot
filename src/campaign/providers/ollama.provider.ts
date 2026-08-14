import { Injectable, Logger } from '@nestjs/common';
import { AIProvider } from './ai-provider.interface';
import {
  AIContentBlock,
  AIInputMessage,
  AIMessage,
  AIToolDefinition,
} from './ai-response.types';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434/v1/chat/completions';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'healthcare-bot';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 8000);

@Injectable()
export class OllamaProvider implements AIProvider {
  readonly name = 'ollama' as const;
  private readonly logger = new Logger(OllamaProvider.name);

  async generate(
    systemPrompt: string,
    messages: AIInputMessage[],
    tools: AIToolDefinition[],
  ): Promise<AIMessage> {
    const openaiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({
        role: m.role,
        // Local model gets flattened text for continuity — it doesn't need
        // to parse Anthropic-shaped content blocks from prior turns, just
        // enough context to understand what already happened.
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
    ];

    const openaiTools = tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: openaiMessages,
          tools: openaiTools,
          temperature: 0.6,
          stream: false,
        }),
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`Ollama timed out after ${OLLAMA_TIMEOUT_MS}ms`);
      }
      throw new Error(`Ollama unreachable: ${err.message}`);
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${await res.text().catch(() => '')}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice) throw new Error('Ollama returned no choices');

    const content: AIContentBlock[] = [];

    if (choice.message?.content?.trim()) {
      const cleanedText = this.stripLeakedToolSyntax(choice.message.content, tools);
      if (cleanedText) {
        content.push({ type: 'text', text: cleanedText });
      }
    }

    for (const toolCall of choice.message?.tool_calls ?? []) {
      const toolDef = tools.find(t => t.name === toolCall.function?.name);
      const parsedInput = this.parseAndValidateToolCall(toolCall, toolDef);
      content.push({
        type: 'tool_use',
        id: toolCall.id ?? `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: toolCall.function.name,
        input: parsedInput,
      });
    }

    if (content.length === 0) throw new Error('Ollama returned empty content (no text, no tool calls)');

    return {
      id: data.id ?? `ollama_${Date.now()}`,
      role: 'assistant',
      content,
      stop_reason: choice.message?.tool_calls?.length ? 'tool_use' : 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 }, // local inference — not metered
      provider: 'ollama',
      model: OLLAMA_MODEL,
    };
  }

  /**
   * Local models are meaningfully less reliable at strict JSON schema
   * adherence than Claude. This is the single biggest risk of running a
   * smaller local model for tool-heavy conversation flows — validate every
   * tool call against its declared schema BEFORE it ever reaches business
   * logic. A malformed call here throws, which the orchestrator treats as
   * a provider failure and falls back to Anthropic for this turn.
   */
  private parseAndValidateToolCall(
    toolCall: any,
    toolDef: AIToolDefinition | undefined,
  ): Record<string, unknown> {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(toolCall.function.arguments);
    } catch {
      throw new Error(`Ollama produced malformed tool call arguments for ${toolCall.function?.name}`);
    }

    if (!toolDef) {
      throw new Error(`Ollama called unknown tool: ${toolCall.function?.name}`);
    }

    const missing = toolDef.input_schema.required.filter(
      field => input[field] === undefined || input[field] === null || input[field] === '',
    );

    if (missing.length > 0) {
      this.logger.warn(
        `Ollama tool call "${toolDef.name}" missing required field(s): ${missing.join(', ')} — rejecting`,
      );
      throw new Error(`Ollama tool call "${toolDef.name}" missing required fields: ${missing.join(', ')}`);
    }

    return input;
  }

  /**
   * Safety net for local model unreliability: strips any leaked tool-call
   * syntax the model may have written directly into patient-facing text
   * instead of using a proper structured tool_calls field (e.g. the model
   * outputs "log_complaint {...}" as plain text). A patient must NEVER see
   * this regardless of how rare the leak is — this is not optional even
   * with a stronger model, since no local model is 100% reliable here.
   */
  private stripLeakedToolSyntax(text: string, tools: AIToolDefinition[]): string {
    let cleaned = text;

    for (const tool of tools) {
      // Matches patterns like: I log_complaint {...}  OR  log_complaint({...})
      // OR bare tool_name followed by a JSON-like object anywhere in the text.
      const leakPattern = new RegExp(
        `\\b(?:I\\s+)?${tool.name}\\s*[:(]?\\s*\\{[\\s\\S]*?\\}\\)?`,
        'gi',
      );
      cleaned = cleaned.replace(leakPattern, '').trim();
    }

    // Also catch a bare tool name mentioned with no JSON (rarer, but still
    // a leak — e.g. model writes "Calling log_complaint..." as prose).
    for (const tool of tools) {
      const bareNamePattern = new RegExp(`\\b${tool.name}\\b`, 'gi');
      cleaned = cleaned.replace(bareNamePattern, '').trim();
    }

    // Collapse any double spaces/newlines left behind by the removal.
    cleaned = cleaned.replace(/\s{2,}/g, ' ').replace(/\n{2,}/g, '\n').trim();

    if (cleaned !== text) {
      this.logger.warn(`Stripped leaked tool-call syntax from Ollama response text`);
    }

    return cleaned;
  }
}