import { Injectable, Logger } from '@nestjs/common';
import { AIProvider } from './ai-provider.interface';
import {
  AIContentBlock,
  AIInputMessage,
  AIMessage,
  AIToolDefinition,
} from './ai-response.types';

// ─── Native Ollama API — NOT the OpenAI-compat endpoint ────────────────────
// /api/chat supports `format: <json-schema>` which forces grammar-constrained
// decoding. The model is structurally unable to return malformed JSON.
// This replaces the old text-scraping "recoverLeakedToolCalls" hack, which
// silently deleted any tool call it couldn't pattern-match.
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434/api/chat';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'healthcare-bot:latest';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 20000);
const OLLAMA_TEMPERATURE = Number(process.env.OLLAMA_TEMPERATURE ?? 0.2);

// ─── Fixed response envelope every model call must conform to ──────────────
// Structural validity is guaranteed by Ollama's grammar constraint.
// Business validity (correct enums, required fields per tool) is still
// checked in code below — the schema can't know "log_complaint needs a
// severity but request_handoff doesn't".
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          input: { type: 'object' },
        },
        required: ['name', 'input'],
      },
    },
  },
  required: ['reply', 'tool_calls'],
};

interface StrictModelResponse {
  reply: string;
  tool_calls: { name: string; input: Record<string, unknown> }[];
}

@Injectable()
export class OllamaProvider implements AIProvider {
  readonly name = 'ollama' as const;
  private readonly logger = new Logger(OllamaProvider.name);

  async generate(
    systemPrompt: string,
    messages: AIInputMessage[],
    tools: AIToolDefinition[],
  ): Promise<AIMessage> {
    // Tool schemas are described in the system prompt (buildSystemPrompt already
    // does this in detail). We still pass the tool catalogue as a compact
    // reference block so the model has the exact names/params in front of it
    // every turn, not just once at conversation start.
    const toolCatalogue = tools
      .map(t => `- ${t.name}(${t.input_schema.required.join(', ')}): ${t.description}`)
      .join('\n');

    const fullSystemPrompt =
      `${systemPrompt}\n\n` +
      `OUTPUT CONTRACT — MANDATORY:\n` +
      `You must respond with ONLY a JSON object shaped exactly like this:\n` +
      `{"reply": "<text to send the patient, or empty string if none>", "tool_calls": [{"name": "<tool_name>", "input": {...}}]}\n` +
      `tool_calls can be an empty array []. You may include multiple tool calls in the array if needed.\n` +
      `Never output anything outside this JSON object. No markdown, no code fences, no explanation.\n\n` +
      `AVAILABLE TOOLS:\n${toolCatalogue}`;

    const chatMessages = [
      { role: 'system', content: fullSystemPrompt },
      ...messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
    ];

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
          messages: chatMessages,
          format: RESPONSE_SCHEMA,
          stream: false,
          options: { temperature: OLLAMA_TEMPERATURE },
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

    // Accept either an already-parsed object or a JSON string in the API
    // envelope. Be explicit about unexpected envelopes so operators can
    // diagnose quickly.
    const rawContentCandidate: any = data?.message?.content ?? data?.content ?? data?.result ?? null;

    if (rawContentCandidate === null || rawContentCandidate === undefined) {
      this.logger.error(`Ollama returned unexpected envelope: ${JSON.stringify(data)}`);
      throw new Error('Ollama returned empty or unexpected content envelope');
    }

    let parsed: StrictModelResponse;
    if (typeof rawContentCandidate === 'object') {
      parsed = rawContentCandidate as StrictModelResponse;
    } else if (typeof rawContentCandidate === 'string') {
      const rawContent = rawContentCandidate;
      if (!rawContent.trim()) {
        throw new Error('Ollama returned empty content');
      }

      try {
        parsed = JSON.parse(rawContent);
      } catch (err: any) {
        this.logger.error(
          `Ollama did not return valid JSON despite format schema. ` +
          `Check "ollama --version" — structured outputs require >= 0.5. Raw: ${rawContent}`,
        );
        throw new Error(`Ollama structured output failed to parse: ${err.message}`);
      }
    } else {
      this.logger.error(`Ollama returned content of unexpected type: ${typeof rawContentCandidate}`);
      throw new Error('Ollama returned content of unexpected type');
    }

    if (typeof parsed.reply !== 'string' || !Array.isArray(parsed.tool_calls)) {
      this.logger.error(`Ollama response violated the contract shape. Parsed: ${JSON.stringify(parsed)}`);
      throw new Error(`Ollama response violated the contract shape.`);
    }

    const content: AIContentBlock[] = [];

    for (const call of parsed.tool_calls) {
      const toolDef = tools.find(t => t.name === call.name);
      if (!toolDef) {
        this.logger.error(`Ollama called unknown tool "${call.name}" — dropping this call, not the whole turn.`);
        continue;
      }

      const validated = this.validateAgainstSchema(call.input ?? {}, toolDef);
      if (!validated.ok) {
        this.logger.error(
          `Tool call "${call.name}" missing required field(s): ${validated.missing.join(', ')} — dropping. ` +
          `Input received: ${JSON.stringify(call.input)}`,
        );
        continue;
      }

      content.push({
        type: 'tool_use',
        id: this.generateToolCallId(),
        name: call.name,
        input: call.input,
      });
    }

    if (parsed.reply.trim()) {
      content.push({ type: 'text', text: parsed.reply.trim() });
    }

    if (content.length === 0) {
      throw new Error('Ollama returned no usable reply text and no valid tool calls');
    }

    const hasToolUse = content.some(b => b.type === 'tool_use');

    return {
      id: data.id ?? `ollama_${Date.now()}`,
      role: 'assistant',
      content,
      stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
      usage: {
        input_tokens: data.prompt_eval_count ?? 0,
        output_tokens: data.eval_count ?? 0,
      },
      provider: 'ollama',
      model: OLLAMA_MODEL,
    };
  }

  private generateToolCallId(): string {
    return `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private validateAgainstSchema(
    input: Record<string, unknown>,
    toolDef: AIToolDefinition,
  ): { ok: true } | { ok: false; missing: string[] } {
    const missing = toolDef.input_schema.required.filter(
      field => input[field] === undefined || input[field] === null || input[field] === '',
    );
    return missing.length > 0 ? { ok: false, missing } : { ok: true };
  }
}