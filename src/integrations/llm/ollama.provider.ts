import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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

// Sized to absorb a cold model reload (observed 12-20s for this ~30B q4
// model), not just a warm generation (~2-3s). This is the actual fix for
// cold-start failures — keep_alive below only decides how OFTEN a reload
// happens, not whether the patient ever sees a broken/canned reply when one
// does. If a reload is ever needed mid-conversation, the patient just waits
// a bit longer for a real answer instead of getting an error.
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 45_000);
const OLLAMA_TEMPERATURE = Number(process.env.OLLAMA_TEMPERATURE ?? 0.2);

// Deliberately short: this model is ~20GB on GPU, and a real patient
// conversation is a handful of messages over a few minutes, not a
// half-hour-long chat. Holding it resident for 30m+ after the patient goes
// quiet just burns GPU memory for a reply that (per this campaign's own
// design — aiMaxTurns, farewell-after-limit) usually isn't coming. 10m
// comfortably covers back-to-back replies in one sitting; anything longer
// pays one cold reload on the next message, bounded by OLLAMA_TIMEOUT_MS
// above rather than failing.
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? '10m';

// Cold-loading a ~30B q4 model from disk can take well over a minute — far
// longer than the 20s per-turn conversation timeout above, which is sized for
// a *warm* model. Left uncovered, the very first turn of every session (or
// any turn after a 30m+ gap) reliably timed out and fell back to a canned
// reply instead of a real one. This is generous on purpose: it only bounds
// the one-time background warm-up at boot, never a real patient turn.
const OLLAMA_WARMUP_TIMEOUT_MS = 120_000;

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
export class OllamaProvider implements AIProvider, OnModuleInit {
  readonly name = 'ollama' as const;
  private readonly logger = new Logger(OllamaProvider.name);

  /**
   * Fires a background warm-up request the moment the app boots, so the
   * model is already resident in memory before the first real patient
   * message arrives instead of paying the cold-load cost on that message's
   * 20s turn timeout. Deliberately not awaited here — Nest would otherwise
   * delay "Nest application successfully started" (and accepting webhook
   * traffic) by however long the cold load takes.
   */
  onModuleInit(): void {
    this.warmUp().catch(() => { /* already logged inside warmUp */ });
  }

  private async warmUp(): Promise<void> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), OLLAMA_WARMUP_TIMEOUT_MS);

    try {
      // Per Ollama's documented warm-up idiom: an empty `messages` array loads
      // the model into memory without generating any tokens.
      const res = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: [],
          keep_alive: OLLAMA_KEEP_ALIVE,
        }),
      });

      if (!res.ok) {
        throw new Error(`Ollama error ${res.status}: ${await res.text().catch(() => '')}`);
      }

      this.logger.log(`Warmed up model "${OLLAMA_MODEL}" in ${Date.now() - startedAt}ms`);
    } catch (err: any) {
      const reason = err.name === 'AbortError'
        ? `timed out after ${OLLAMA_WARMUP_TIMEOUT_MS}ms`
        : err.message;
      this.logger.warn(
        `Warm-up failed for model "${OLLAMA_MODEL}" — first real conversation turn may cold-start instead: ${reason}`,
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

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
          keep_alive: OLLAMA_KEEP_ALIVE,
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
    const rawContent: string | undefined = data?.message?.content;

    if (!rawContent || !rawContent.trim()) {
      throw new Error('Ollama returned empty content');
    }

    let parsed: StrictModelResponse;
    try {
      parsed = JSON.parse(rawContent);
    } catch (err: any) {
      // With format-constrained decoding this should never happen. If it does,
      // it means the Ollama version doesn't actually support structured
      // outputs (pre-0.5) and silently ignored the `format` field — fail loud,
      // don't try to guess-recover.
      this.logger.error(
        `Ollama did not return valid JSON despite format schema. ` +
        `Check "ollama --version" — structured outputs require >= 0.5. Raw: ${rawContent}`,
      );
      throw new Error(`Ollama structured output failed to parse: ${err.message}`);
    }

    if (typeof parsed.reply !== 'string' || !Array.isArray(parsed.tool_calls)) {
      throw new Error(`Ollama response violated the contract shape. Raw: ${rawContent}`);
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