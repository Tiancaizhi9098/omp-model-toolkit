import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface Bindings { version: 1; bindings: Record<string, string>; }
export const MAX_PROMPT_BYTES = 512 * 1024;
export const configPath = (agentDir: string) => join(agentDir, "model-append-system.json");

export function readBindings(agentDir: string): Bindings {
  let text: string;
  try { text = readFileSync(configPath(agentDir), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, bindings: {} }; throw e; }
  const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型提示词配置必须是 JSON 对象。");
  const c = value as Record<string, unknown>;
  if (c.version !== 1 || !c.bindings || typeof c.bindings !== "object" || Array.isArray(c.bindings)) throw new Error("模型提示词配置格式错误（需要 version: 1 和 bindings）。");
  for (const [key, path] of Object.entries(c.bindings)) {
    if (!key.includes("/") || typeof path !== "string" || !path.trim()) throw new Error(`无效的模型提示词绑定：${key}`);
  }
  return { version: 1, bindings: Object.fromEntries(Object.entries(c.bindings)) as Record<string, string> };
}

export function atomicWrite(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
}

export function bind(agentDir: string, key: string, path: string | undefined) {
  // Re-read immediately before a synchronous read/modify/write: no async UI gap loses bindings.
  const config = readBindings(agentDir);
  if (path === undefined) delete config.bindings[key];
  else Object.defineProperty(config.bindings, key, { value: path, enumerable: true, writable: true, configurable: true });
  atomicWrite(configPath(agentDir), `${JSON.stringify(config, null, 2)}\n`);
}

export function absolutePath(input: string, base: string) {
  const expanded = input === "~" ? homedir() : /^~[/\\]/.test(input) ? join(homedir(), input.slice(2)) : input;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

export function defaultPromptPath(agentDir: string, key: string) {
  const label = key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 70);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return join(agentDir, "model-prompts", `${label}-${hash}`, "APPEND_SYSTEM.md");
}

export function readPrompt(path: string) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_PROMPT_BYTES) throw new Error(`提示词必须是小于 512 KiB 的 UTF-8 文件：${path}`);
  const buffer = readFileSync(path);
  if (buffer.length > MAX_PROMPT_BYTES) throw new Error(`提示词超过 512 KiB：${path}`);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, "");
  if (text.includes("<!-- omp:model-append-system:")) throw new Error("提示词中不能包含插件保留的 omp:model-append-system 标记。");
  return text;
}

export function resolvePrompt(agentDir: string, key: string) {
  const input = readBindings(agentDir).bindings[key];
  if (!input) return undefined;
  const path = absolutePath(input, agentDir);
  return { path, text: readPrompt(path) };
}

// Backslashes in Windows paths are literal, not shell escapes.
export function parseArgs(text: string): string[] {
  const tokens: string[] = [];
  let current = "", quote = "", started = false;
  for (const char of text) {
    if (quote) { if (char === quote) quote = ""; else current += char; started = true; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { tokens.push(current); current = ""; started = false; } }
    else { current += char; started = true; }
  }
  if (quote) throw new Error("路径引号没有闭合。");
  if (started) tokens.push(current);
  return tokens;
}
