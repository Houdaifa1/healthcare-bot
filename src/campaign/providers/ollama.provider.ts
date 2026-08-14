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

// Lower than a "creative" temperature on purpose. qwen2.5-instruct's own
// function-calling guidance recommends a low temperature for structured/
// tool output — 0.6 was measurably too high and is the most likely reason
// the model was drifting off the tool_calls schema and free-writing
// pseudo tool-call syntax directly into message content instead.
// Override via env if you've tuned this differently for your Modelfile.
const OLLAMA_TEMPERATURE = Number(process.env.OLLAMA_TEMPERATURE ?? 0.2);

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
          temperature: OLLAMA_TEMPERATURE,
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

    // ── Properly-formed native tool_calls (the happy path) ──────────────────
    for (const toolCall of choice.message?.tool_calls ?? []) {
      const toolDef = tools.find(t => t.name === toolCall.function?.name);
      const parsedInput = this.parseAndValidateToolCall(toolCall, toolDef);
      content.push({
        type: 'tool_use',
        id: toolCall.id ?? this.generateToolCallId(),
        name: toolCall.function.name,
        input: parsedInput,
      });
    }

    // ── Text content: recover any leaked tool call BEFORE stripping ─────────
    // qwen2.5:7b-instruct via Ollama's OpenAI-compat endpoint does not
    // always populate tool_calls reliably — it can write the call directly
    // into message content instead, sometimes with garbled/mangled prefixes
    // (observed in production: "_vlog_complaint{...}" instead of a clean
    // tool_calls entry for "log_complaint"). Losing that call silently is
    // unacceptable for a healthcare bot — a dropped HIGH-severity complaint
    // or handoff request is a patient-safety issue, not a cosmetic one.
    // So: try to recover a real tool_use block from the leaked text first,
    // and only fall back to plain stripping if recovery fails.
    if (choice.message?.content?.trim()) {
      const rawText: string = choice.message.content;
      const recovered = this.recoverLeakedToolCalls(rawText, tools);

      for (const rec of recovered.calls) {
        this.logger.error(
          `RECOVERED leaked tool call "${rec.name}" from raw text for model ${OLLAMA_MODEL}. ` +
          `This means the model failed to use native tool_calls — investigate the Modelfile TEMPLATE ` +
          `and consider lowering temperature further. Raw fragment: ${rec.rawFragment}`,
        );
        content.push({
          type: 'tool_use',
          id: this.generateToolCallId(),
          name: rec.name,
          input: rec.input,
        });
      }

      const remainingText = recovered.cleanedText.trim();
      if (remainingText) {
        content.push({ type: 'text', text: remainingText });
      }
    }

    if (content.length === 0) throw new Error('Ollama returned empty content (no text, no tool calls)');

    const hasToolUse = content.some(b => b.type === 'tool_use');

    return {
      id: data.id ?? `ollama_${Date.now()}`,
      role: 'assistant',
      content,
      stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 }, // local inference — not metered
      provider: 'ollama',
      model: OLLAMA_MODEL,
    };
  }

  private generateToolCallId(): string {
    return `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

    return this.validateAgainstSchema(input, toolDef, toolCall.function?.name);
  }

  private validateAgainstSchema(
    input: Record<string, unknown>,
    toolDef: AIToolDefinition | undefined,
    calledName: string | undefined,
  ): Record<string, unknown> {
    if (!toolDef) {
      throw new Error(`Ollama called unknown tool: ${calledName}`);
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
   * Scans raw text content for a tool name occurring anywhere — NOT
   * anchored to a word boundary, since observed leaks include mangled
   * prefixes like "_vlog_complaint" where a strict `\bname\b` match fails
   * (there's no word boundary between "v" and "l" in "vlog_complaint",
   * so a naive regex silently misses it — this was the exact bug that let
   * a real leak through to a patient in testing).
   *
   * For each match, finds the next "{" after the tool name and walks
   * forward with brace-depth counting to extract a syntactically complete
   * JSON object (handles nested braces correctly, unlike a single greedy
   * regex). Attempts to parse and schema-validate it as that tool's input.
   * On success, the call is treated exactly like a native tool_calls entry.
   * On failure, that fragment is left for plain stripping so it never
   * reaches the patient, but the failure is logged at error level since it
   * likely represents an unrecoverable dropped action.
   */
  private recoverLeakedToolCalls(
    text: string,
    tools: AIToolDefinition[],
  ): { calls: { name: string; input: Record<string, unknown>; rawFragment: string }[]; cleanedText: string } {
    const calls: { name: string; input: Record<string, unknown>; rawFragment: string }[] = [];
    let working = text;

    for (const tool of tools) {
      let searchFrom = 0;

      // Loop in case the same tool name leaks more than once in one response.
      while (true) {
        const nameIdx = working.toLowerCase().indexOf(tool.name.toLowerCase(), searchFrom);
        if (nameIdx === -1) break;

        const braceStart = working.indexOf('{', nameIdx);
        // No JSON object follows within a reasonable window — likely just the
        // model narrating the tool name in prose, not an actual leaked call.
        // Bail out of the loop for this tool; the bare-name stripping pass
        // below still removes it from patient-facing text.
        if (braceStart === -1 || braceStart - nameIdx > 20) {
          searchFrom = nameIdx + tool.name.length;
          continue;
        }

        const braceEnd = this.findMatchingBrace(working, braceStart);
        if (braceEnd === -1) {
          searchFrom = nameIdx + tool.name.length;
          continue;
        }

        const jsonFragment = working.slice(braceStart, braceEnd + 1);
        const fullFragment = working.slice(nameIdx, braceEnd + 1);

        try {
          const parsedInput = JSON.parse(jsonFragment);
          const validated = this.validateAgainstSchema(parsedInput, tool, tool.name);
          calls.push({ name: tool.name, input: validated, rawFragment: fullFragment });
          // Remove the recovered fragment entirely from the working text.
          working = working.slice(0, nameIdx) + working.slice(braceEnd + 1);
          searchFrom = nameIdx; // re-scan from same point in the shortened string
        } catch (err: any) {
          this.logger.error(
            `Found leaked "${tool.name}" call pattern but failed to recover it (${err.message}). ` +
            `This action was likely LOST — check if the patient's request needs manual follow-up. ` +
            `Fragment: ${fullFragment}`,
          );
          // Leave it in place; the bare-name + brace stripping pass below
          // will still remove it from what the patient sees, even though
          // we couldn't recover the structured call.
          searchFrom = braceEnd + 1;
        }
      }
    }

    // Final cleanup pass: strip any remaining bare tool-name mentions or
    // unrecovered JSON-ish fragments so nothing resembling a tool call can
    // ever reach the patient, even if recovery above didn't fully succeed.
    for (const tool of tools) {
      const bareNamePattern = new RegExp(tool.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      working = working.replace(bareNamePattern, '');
    }
    // Strip any leftover standalone JSON-object-looking fragments.
    working = working.replace(/\{[^{}]*\}/g, '');
    working = working.replace(/\s{2,}/g, ' ').replace(/\n{2,}/g, '\n').trim();

    return { calls, cleanedText: working };
  }

  /** Walks forward from an opening brace index, tracking depth, and returns
   * the index of its matching closing brace, or -1 if unbalanced/not found. */
  private findMatchingBrace(text: string, openIdx: number): number {
    let depth = 0;
    for (let i = openIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }
}