const BEGIN = "<!-- omp:model-append-system:begin -->";
const END = "<!-- omp:model-append-system:end -->";
const BLOCK = /\n{0,2}<!-- omp:model-append-system:begin -->[\s\S]*?<!-- omp:model-append-system:end -->/g;
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => !!v && typeof v === "object" && !Array.isArray(v);
export const stripAppend = (text: string) => text.replace(BLOCK, "");
export const appendBlock = (text?: string) => text?.trim() ? `${BEGIN}\n${text.trim()}\n${END}` : "";

export function replaceText(base: string, text?: string) {
  const clean = stripAppend(base);
  const block = appendBlock(text);
  return block ? `${clean}${clean ? "\n\n" : ""}${block}` : clean;
}

export function replaceSystem(base: string[] | string, text?: string): string[] {
  const blocks = (Array.isArray(base) ? base : [base]).map(stripAppend).filter(s => s.trim());
  const addition = appendBlock(text);
  return addition ? [...blocks, addition] : blocks;
}

function cleanParts(parts: unknown[]): unknown[] {
  return parts.flatMap(part => {
    if (typeof part === "string") { const clean = stripAppend(part); return clean ? [clean] : []; }
    if (!object(part) || typeof part.text !== "string") return [part];
    const clean = stripAppend(part.text);
    return clean ? [{ ...part, text: clean }] : [];
  });
}

function content(value: unknown, text?: string, type?: string): unknown {
  if (typeof value === "string") return replaceText(value, text);
  const block = appendBlock(text);
  if (Array.isArray(value)) {
    const clean = cleanParts(value);
    return block ? [...clean, type ? { type, text: block } : { text: block }] : clean;
  }
  if (object(value) && Array.isArray(value.parts)) return { ...value, parts: content(value.parts, text) };
  throw new Error("不支持的 system 内容格式。");
}

/** Modify system fields only; never scan user/tool messages or mutate the original payload. */
export function patchPayload(payload: unknown, text?: string): { payload: unknown; supported: boolean } {
  if (!object(payload)) return { payload, supported: false };
  // Responses HTTP and Codex WebSocket response.create share top-level instructions.
  if (typeof payload.instructions === "string") return { payload: { ...payload, instructions: replaceText(payload.instructions, text) }, supported: true };
  // Anthropic and Bedrock Converse use string or text-block system fields.
  if (typeof payload.system === "string" || Array.isArray(payload.system)) {
    const anthropic = Array.isArray(payload.system) && payload.system.some(p => object(p) && p.type === "text");
    return { payload: { ...payload, system: content(payload.system, text, anthropic ? "text" : undefined) }, supported: true };
  }
  // Google SDK parameters and Gemini CLI/Antigravity request envelopes.
  if (object(payload.config) && payload.config.systemInstruction !== undefined) {
    return { payload: { ...payload, config: { ...payload.config, systemInstruction: content(payload.config.systemInstruction, text) } }, supported: true };
  }
  if (payload.systemInstruction !== undefined) return { payload: { ...payload, systemInstruction: content(payload.systemInstruction, text) }, supported: true };
  if (object(payload.request)) {
    const nested = patchPayload(payload.request, text);
    if (nested.supported) return { payload: { ...payload, request: nested.payload }, supported: true };
  }
  // OpenAI Chat Completions, Ollama, and Responses input system/developer items.
  for (const field of ["messages", "input"] as const) {
    const messages = payload[field];
    if (!Array.isArray(messages)) continue;
    const systemIndexes = messages.flatMap((m, i) => object(m) && (m.role === "system" || m.role === "developer") ? [i] : []);
    if (!systemIndexes.length) continue;
    const cleaned = messages.flatMap((m, i) => {
      if (!object(m) || !systemIndexes.includes(i)) return [m];
      const clean = content(m.content, undefined, field === "input" ? "input_text" : "text");
      // A separate, plugin-only system message disappears entirely on unbind.
      if (clean === "" || (Array.isArray(clean) && clean.length === 0)) return [];
      return [{ ...m, content: clean }];
    });
    const last = cleaned.findLastIndex(m => object(m) && (m.role === "system" || m.role === "developer"));
    if (last < 0 && appendBlock(text)) {
      cleaned.unshift({ role: "system", content: field === "input" ? [{ type: "input_text", text: appendBlock(text) }] : appendBlock(text) });
      return { payload: { ...payload, [field]: cleaned }, supported: true };
    }
    return {
      payload: {
        ...payload,
        [field]: cleaned.map((m, i) => {
          if (!object(m) || i !== last) return m;
          return { ...m, content: content(m.content, i === last ? text : undefined, field === "input" ? "input_text" : "text") };
        }),
      },
      supported: true,
    };
  }
  return { payload, supported: false };
}
