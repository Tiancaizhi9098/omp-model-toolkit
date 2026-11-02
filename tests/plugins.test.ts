import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appendBlock, patchPayload, replaceSystem } from "../src/prompt";
import { absolutePath, bind, configPath, defaultPromptPath, parseArgs, readBindings, readPrompt, resolvePrompt } from "../src/storage";
import { AllowedModelPicker } from "../src/picker";

const plainTheme = { label: (s: string) => s, value: (s: string) => s, description: (s: string) => s, hint: (s: string) => s, cursor: "> " };

const work = resolve(process.env.OMP_PLUGIN_TEST_DIR ?? "work/plugin-tests");
mkdirSync(work, { recursive: true });
const scratch = () => mkdtempSync(join(work, "case-"));

describe("prompt storage", () => {
  test("two providers with the same model ID keep separate files and bindings", () => {
    const dir = scratch();
    const a = defaultPromptPath(dir, "one/same");
    const b = defaultPromptPath(dir, "two/same");
    expect(a).not.toBe(b);
    mkdirSync(resolve(a, ".."), { recursive: true });
    mkdirSync(resolve(b, ".."), { recursive: true });
    writeFileSync(a, "甲模型规则"); writeFileSync(b, "乙模型规则");
    bind(dir, "one/same", a); bind(dir, "two/same", b);
    expect(resolvePrompt(dir, "one/same")?.text).toBe("甲模型规则");
    expect(resolvePrompt(dir, "two/same")?.text).toBe("乙模型规则");
    bind(dir, "one/same", undefined);
    expect(resolvePrompt(dir, "one/same")).toBeUndefined();
    expect(readFileSync(a, "utf8")).toBe("甲模型规则");
    expect(resolvePrompt(dir, "two/same")?.text).toBe("乙模型规则");
  });
  test("manual prompt edits apply on the next read and missing bindings do not fall back", () => {
    const dir = scratch(), file = join(dir, "APPEND_SYSTEM.md");
    writeFileSync(file, "旧内容"); bind(dir, "test/a", file);
    expect(resolvePrompt(dir, "test/a")?.text).toBe("旧内容");
    writeFileSync(file, "新内容");
    expect(resolvePrompt(dir, "test/a")?.text).toBe("新内容");
    expect(resolvePrompt(dir, "test/b")).toBeUndefined();
  });
  test("Windows backslashes and quoted paths with spaces survive command parsing", () => {
    expect(parseArgs('bind provider/model "C:\\我的提示词\\a b\\APPEND_SYSTEM.md"')).toEqual(["bind", "provider/model", "C:\\我的提示词\\a b\\APPEND_SYSTEM.md"]);
    expect(() => parseArgs('bind x "unfinished')).toThrow();
    expect(absolutePath("./a b/APPEND_SYSTEM.md", work)).toBe(resolve(work, "a b/APPEND_SYSTEM.md"));
  });
  test("invalid configuration is reported without rewriting it", () => {
    const dir = scratch();
    writeFileSync(configPath(dir), '{"version":2,"bindings":{}}');
    expect(() => bind(dir, "test/a", "a.md")).toThrow();
    expect(readFileSync(configPath(dir), "utf8")).toBe('{"version":2,"bindings":{}}');
  });
  test("UTF-8 BOM works; invalid bytes and reserved delimiters are rejected", () => {
    const dir = scratch(), file = join(dir, "APPEND_SYSTEM.md");
    writeFileSync(file, "\uFEFF中文"); expect(readPrompt(file)).toBe("中文");
    writeFileSync(file, Buffer.from([0xff])); expect(() => readPrompt(file)).toThrow();
    writeFileSync(file, appendBlock("content")); expect(() => readPrompt(file)).toThrow();
    writeFileSync(file, Buffer.alloc(512 * 1024 + 1)); expect(() => readPrompt(file)).toThrow();
  });
});

describe("system prompt replacement", () => {
  test("base prompt, global append, and other extensions survive switch/unbind", () => {
    const base = ["Host system", "Global APPEND_SYSTEM.md", "Another extension"];
    const a = replaceSystem(base, "A only");
    const b = replaceSystem(a, "B only");
    expect(b.slice(0, 3)).toEqual(base);
    expect(b.join()).not.toContain("A only");
    expect(replaceSystem(b)).toEqual(base);
    expect(replaceSystem(b, "B only")).toEqual(b);
    expect(base).toHaveLength(3);
  });
  const payloads: Array<[string, unknown]> = [
    ["Responses HTTP", { instructions: "base", input: [{ role: "user", content: "hello" }] }],
    ["Codex WebSocket", { type: "response.create", instructions: "base", input: [] }],
    ["Anthropic", { system: [{ type: "text", text: "base", cache_control: { type: "ephemeral" } }], messages: [] }],
    ["Bedrock", { system: [{ text: "base" }], messages: [] }],
    ["Chat Completions", { messages: [{ role: "system", content: "base" }, { role: "user", content: "hello" }] }],
    ["Chat developer content parts", { messages: [{ role: "developer", content: [{ type: "text", text: "base" }] }] }],
    ["Responses input", { input: [{ role: "developer", content: [{ type: "input_text", text: "base" }] }] }],
    ["Google SDK string", { contents: [], config: { systemInstruction: "base", temperature: 0.5 } }],
    ["Google SDK Content", { contents: [], config: { systemInstruction: { role: "system", parts: [{ text: "base" }] } } }],
    ["Gemini CLI", { request: { systemInstruction: { parts: [{ text: "base" }] }, contents: [] }, project: "test" }],
  ];
  for (const [name, original] of payloads) test(`${name}: fallback replaces, retries deduplicate, unbind restores`, () => {
    const snapshot = structuredClone(original);
    const a = patchPayload(original, "A only");
    expect(a.supported).toBe(true);
    const b = patchPayload(a.payload, "B only");
    expect(JSON.stringify(b.payload)).not.toContain("A only");
    expect(JSON.stringify(b.payload).split("B only")).toHaveLength(2);
    expect(patchPayload(b.payload, "B only").payload).toEqual(b.payload);
    expect(patchPayload(b.payload).payload).toEqual(original);
    expect(original).toEqual(snapshot);
  });
  test("removes plugin-only system messages while preserving user content verbatim", () => {
    const marked = appendBlock("OLD");
    const payload = { messages: [{ role: "system", content: "base" }, { role: "system", content: marked }, { role: "user", content: marked }] };
    expect(patchPayload(payload).payload).toEqual({ messages: [{ role: "system", content: "base" }, { role: "user", content: marked }] });
  });
  test("unknown provider payloads are left intact and reported unsupported", () => {
    const original = { customWire: "base" };
    expect(patchPayload(original, "extra")).toEqual({ payload: original, supported: false });
  });
});

// Real installed OMP loader, event runner, settings, and model matcher; no model inference.
describe("oh-my-pi 18.15 host integration", () => {
  let host: Awaited<ReturnType<typeof importHost>>;
  const runners: Array<{ clearManagedTimers(): void }> = [];
  afterEach(() => { for (const runner of runners.splice(0)) runner.clearManagedTimers(); });
  beforeAll(async () => { host = await importHost(); }, 30_000);
  async function importHost() {
    const spec = (pkg: string, subpath: string) => process.env.OMP_TEST_HOST_MODULES
      ? pathToFileURL(join(process.env.OMP_TEST_HOST_MODULES, "@oh-my-pi", pkg, "src", `${subpath}.ts`)).href
      : `@oh-my-pi/${pkg}/${subpath === "index" ? "" : subpath}`.replace(/\/$/, "");
    return {
      ...await import(spec("pi-coding-agent", "extensibility/extensions/loader")),
      ...await import(spec("pi-coding-agent", "extensibility/extensions/runner")),
      ...await import(spec("pi-coding-agent", "config/settings")),
      ...await import(spec("pi-coding-agent", "config/model-settings")),
      ...await import(spec("pi-coding-agent", "session/session-manager")),
      ...await import(spec("pi-catalog", "models")),
      ...await import(spec("pi-utils", "index")),
    };
  }
  async function harness(options: { dir?: string; scope?: any; models?: any[]; subagent?: boolean } = {}) {
    const dir = options.dir ?? scratch();
    host.setAgentDir(dir);
    const loaded = await host.loadExtensions([resolve(import.meta.dir, "../src/index.ts")], dir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    const scope = options.scope ?? host.Settings.isolated();
    const a = { ...host.getBundledModel("openai", "gpt-4.1"), provider: "test", id: "a", name: "Test A" };
    const b = { ...a, id: "b", name: "Test B" };
    let current = a, aborts = 0, idle = true, pending = false;
    const notices: string[] = [], errors: unknown[] = [], picks: (string | undefined)[] = [];
    const menus: string[][] = [], inputs: string[] = [], renders: string[] = [];
    const models = options.models ?? [a, b];
    const registry = { getAvailable: () => [...models], getAll: () => [...models], isBackgroundRefreshPending: () => pending };
    const runner = new host.ExtensionRunner(loaded.extensions, loaded.runtime, dir, host.SessionManager.inMemory(dir), registry as never, undefined, scope,
      undefined, undefined, options.subagent ? { kind: "sub", id: "child", name: "child", depth: 1, parentId: "main" } : undefined);
    runners.push(runner);
    const ui = {
      ...runner.createContext().ui,
      select: async (_title: string, options: string[]) => { menus.push(options); return picks.shift(); },
      notify: (m: string) => notices.push(m), editor: async () => undefined,
      custom: async (factory) => {
        let completed = false, result;
        const component = await factory({ requestRender() {} }, { fg: (_color, s) => s }, {}, value => { completed = true; result = value; });
        while (inputs.length && !completed) { component.handleInput(inputs.shift()); renders.push(component.render(100).join("\n")); }
        if (!completed) throw new Error("Test UI did not save or cancel");
        return result;
      },
    };
    runner.onError(e => errors.push(e));
    runner.initialize({
      sendMessage: () => {}, sendUserMessage: () => {}, appendEntry: () => {},
      getActiveTools: () => [], getAllTools: () => [], setActiveTools: async () => {}, getCommands: () => [],
      setModel: async m => { current = m as typeof a; return true; }, getThinkingLevel: () => undefined,
      setThinkingLevel: () => {}, getSessionName: () => undefined, setSessionName: async () => {},
    }, {
      getModel: () => current as never, isIdle: () => idle, abort: () => { aborts++; }, hasPendingMessages: () => false,
      shutdown: () => {}, getContextUsage: () => undefined, compact: async () => {}, getSystemPrompt: () => ["base"],
    }, undefined, ui, "tui");
    const command = (name: string, args: string) => runner.runScoped(() => runner.getCommand(name)!.handler(args, runner.createCommandContext()));
    return { dir, runner, scope, a, b, models, ui, notices, errors, picks, menus, inputs, renders, command,
      setIdle: (value: boolean) => { idle = value; }, setPending: (value: boolean) => { pending = value; },
      current: () => current, aborts: () => aborts };
  }
  test("actual extension loader registers both commands", async () => {
    const h = await harness();
    expect(h.runner.getCommand("allowed-models")).toBeDefined();
    expect(h.runner.getCommand("model-prompts")).toBeDefined();
    await h.runner.emit({ type: "session_start" });
    expect(h.errors).toEqual([]);
  });
  test("saving allowlist uses native settings and switches an excluded current model", async () => {
    const h = await harness();
    await h.command("allowed-models", "set test/b");
    expect(host.cfgEnabledModels.get(h.scope)).toEqual(["test/b"]);
    expect(h.current().id).toBe("b");
    await h.command("allowed-models", "set test/nonexistent");
    expect(host.cfgEnabledModels.get(h.scope)).toEqual(["test/b"]);
    await h.command("allowed-models", "reset");
    expect(host.cfgEnabledModels.get(h.scope)).toEqual([]);
  });
  test("canceling picker never changes the saved scope; an empty selection cannot be saved", async () => {
    const h = await harness();
    await h.command("allowed-models", "set test/a");
    h.inputs.push("\r", "\x13", "\x1b"); // toggle initial model off, Ctrl+S, cancel
    await h.command("allowed-models", "");
    expect(host.cfgEnabledModels.get(h.scope)).toEqual(["test/a"]);
    expect(h.renders.some(m => m.includes("至少选择"))).toBe(true);
  });
  test("runtime settings override is respected and its precedence is shown", async () => {
    const h = await harness();
    host.cfgEnabledModels.override(h.scope, ["test/a"]);
    await h.command("allowed-models", "set test/b");
    expect(host.cfgEnabledModels.get(h.scope)).toEqual(["test/a"]);
    expect(h.notices.some(m => m.includes("优先级更高"))).toBe(true);
  });
  test("actual hooks follow the request model during fallback and do not accumulate", async () => {
    const h = await harness();
    const fileA = join(h.dir, "A APPEND_SYSTEM.md"), fileB = join(h.dir, "B APPEND_SYSTEM.md");
    writeFileSync(fileA, "A only"); writeFileSync(fileB, "B only");
    await h.command("model-prompts", `bind test/a "${fileA}"`);
    await h.command("model-prompts", `bind test/b "${fileB}"`);
    const initial = await h.runner.emitBeforeAgentStart("hello", undefined, ["base", "global append"]);
    expect(initial?.systemPrompt?.join("\n")).toContain("A only");
    const payload = { instructions: initial!.systemPrompt!.join("\n\n"), input: [] };
    const fallback = await h.runner.emitBeforeProviderRequest(payload, h.b as never);
    expect(JSON.stringify(fallback)).toContain("B only");
    expect(JSON.stringify(fallback)).not.toContain("A only");
    expect(JSON.stringify(fallback)).toContain("global append");
    expect(h.current().id).toBe("a");
    await h.command("model-prompts", "unbind test/b");
    const unbound = await h.runner.emitBeforeProviderRequest(payload, h.b as never);
    expect(JSON.stringify(unbound)).not.toContain("A only");
    expect(JSON.stringify(unbound)).not.toContain("B only");
    expect(h.errors).toEqual([]);
  });
  test("missing files surface a diagnostic and request abort; no stale prompt survives", async () => {
    const h = await harness();
    bind(h.dir, "test/a", join(h.dir, "missing.md"));
    const result = await h.runner.emitBeforeAgentStart("hello", undefined, ["base", appendBlock("stale")]);
    expect(h.aborts()).toBe(1);
    expect(result?.systemPrompt).toEqual(["base"]);
    expect(h.notices.some(m => m.includes("读取模型提示词失败"))).toBe(true);
  });

  test("prompt menu, list and direct binding follow saved enabledModels immediately", async () => {
    const h = await harness();
    const file = join(h.dir, "fixture.md"); writeFileSync(file, "B only");
    await h.command("model-prompts", `bind test/b "${file}"`);
    await h.command("allowed-models", "set test/a");
    await h.command("model-prompts", "");
    expect(h.menus.at(-1)).toEqual(["★ test/a"]);
    await h.command("model-prompts", "list");
    expect(h.notices.at(-1)).toContain("test/a");
    expect(h.notices.at(-1)).not.toContain("test/b");
    await h.command("model-prompts", `bind test/b "${file}"`);
    expect(h.notices.at(-1)).toContain("未启用或当前不可用");
    expect(readBindings(h.dir).bindings["test/b"]).toBe(file);
    const inactive = await h.runner.emitBeforeProviderRequest({ instructions: replaceSystem(["base"], "stale").join("\n"), input: [] }, h.b);
    expect(inactive.instructions).toBe("base");
    await h.command("allowed-models", "set test/b");
    await h.command("model-prompts", "");
    expect(h.menus.at(-1)).toEqual(["★ test/b  [已绑定]"]);
    const active = await h.runner.emitBeforeProviderRequest({ instructions: "base", input: [] }, h.b);
    expect(active.instructions).toContain("B only");
    expect(h.errors).toEqual([]);
  });

  test("disabled current model and old bindings cannot bypass runtime scope; no matches never expands to all", async () => {
    const h = await harness();
    bind(h.dir, "test/a", join(h.dir, "missing-disabled.md"));
    bind(h.dir, "offline/old", join(h.dir, "old.md"));
    host.cfgEnabledModels.override(h.scope, ["test/b"]);
    await h.command("model-prompts", "");
    expect(h.menus.at(-1)).toEqual(["test/b"]);
    await h.command("model-prompts", "edit");
    expect(h.notices.at(-1)).toContain("未启用或当前不可用");
    const start = await h.runner.emitBeforeAgentStart("hello", undefined, ["base", appendBlock("stale")]);
    expect(start.systemPrompt).toEqual(["base"]);
    expect(h.aborts()).toBe(0); // Disabled binding is never read.
    host.cfgEnabledModels.override(h.scope, ["missing/no-match"]);
    const oldMenuCount = h.menus.length;
    await h.command("model-prompts", "");
    expect(h.menus).toHaveLength(oldMenuCount);
    expect(h.notices.at(-1)).toContain("没有已启用");
    await h.command("model-prompts", "unbind offline/old");
    expect(readBindings(h.dir).bindings["offline/old"]).toBeUndefined();
    expect(h.errors).toEqual([]);
  });

  test("native wildcard matching and reset are shared by both commands", async () => {
    const h = await harness();
    host.cfgEnabledModels.set(h.scope, ["test/b*"]);
    await h.command("model-prompts", "");
    expect(h.menus.at(-1)).toEqual(["test/b"]);
    await h.command("allowed-models", "reset");
    await h.command("model-prompts", "");
    expect(h.menus.at(-1)).toEqual(["★ test/a", "test/b"]);
  });

  test("a new gateway is appended once and is immediately offered for prompt binding", async () => {
    const h = await harness();
    host.cfgEnabledModels.set(h.scope, ["test/a", "offline/kept"]);
    await h.command("allowed-models", "list"); // First upgrade records existing providers.
    expect(host.cfgEnabledModels.get(h.scope)).toEqual(["test/a", "offline/kept"]);
    h.models.push({ ...h.a, provider: "new-gateway" }, { ...h.b, provider: "new-gateway" });
    await h.command("model-prompts", "");
    expect(h.menus.at(-1)).toEqual(["new-gateway/a", "new-gateway/b", "★ test/a"]);
    expect(host.cfgEnabledModels.get(h.scope)).toEqual(["test/a", "offline/kept", "new-gateway/a", "new-gateway/b"]);
    await h.command("allowed-models", "list");
    expect(host.cfgEnabledModels.get(h.scope)).toHaveLength(4);
    expect(readBindings(h.dir).bindings).toEqual({});
  });

  test("deselection survives catalog disappearance, plugin reload, and new models on a known gateway", async () => {
    const h = await harness();
    await h.command("allowed-models", "set test/a");
    const added = { ...h.a, provider: "new-gateway" };
    h.models.push(added);
    await h.command("allowed-models", "list");
    expect(host.cfgEnabledModels.get(h.scope)).toEqual(["test/a", "new-gateway/a"]);
    await h.command("allowed-models", "set test/a");
    h.models.pop();
    await h.command("allowed-models", "list");
    const restarted = await harness({ dir: h.dir, scope: h.scope, models: [...h.models, added, { ...h.b, provider: "new-gateway" }] });
    await restarted.command("model-prompts", "");
    expect(restarted.menus.at(-1)).toEqual(["★ test/a"]);
    expect(host.cfgEnabledModels.get(h.scope)).toEqual(["test/a"]);
  });

  test("first upgrade and all-models mode never re-enable old exclusions or introduce a restriction", async () => {
    const h = await harness();
    h.models.push({ ...h.b, provider: "old-excluded" });
    host.cfgEnabledModels.set(h.scope, ["test/a"]);
    await h.command("model-prompts", "");
    expect(h.menus.at(-1)).toEqual(["★ test/a"]);
    await h.command("allowed-models", "reset");
    h.models.push({ ...h.a, provider: "later" });
    await h.command("model-prompts", "");
    expect(host.cfgEnabledModels.get(h.scope)).toEqual([]);
    expect(h.menus.at(-1)).toContain("later/a");
  });

  test("automatic global additions respect runtime overrides and preserve path-scoped global arrays", async () => {
    const h = await harness();
    await h.command("allowed-models", "set test/a");
    host.cfgEnabledModels.override(h.scope, ["test/b"]);
    h.models.push({ ...h.a, provider: "new-gateway" });
    await h.command("model-prompts", "");
    expect(h.menus.at(-1)).toEqual(["test/b"]);
    expect(h.scope.getGlobalSettings().enabledModels).toEqual(["test/a", "new-gateway/a"]);
    const conditional = ["test/a", { path: "/special/**", models: ["test/b"] }];
    h.scope.writeValue(host.cfgEnabledModels, conditional, "global");
    h.models.push({ ...h.a, provider: "another" });
    await h.command("allowed-models", "list");
    expect(h.scope.getGlobalSettings().enabledModels).toEqual(conditional);
  });

  test("concurrent discovery and manual saves keep the final explicit deselection", async () => {
    const h = await harness();
    await h.command("allowed-models", "set test/a");
    h.models.push({ ...h.b, provider: "new-gateway" });
    await Promise.all([h.command("model-prompts", "list"), h.command("allowed-models", "list")]);
    expect(host.cfgEnabledModels.get(h.scope)).toEqual(["test/a", "new-gateway/b"]);
    await Promise.all([h.command("allowed-models", "set test/a"), h.command("model-prompts", "list")]);
    await h.command("allowed-models", "list");
    expect(host.cfgEnabledModels.get(h.scope)).toEqual(["test/a"]);
    expect(h.errors).toEqual([]);
  });

  test("a stale open picker cannot overwrite an automatically added gateway", async () => {
    const h = await harness();
    await h.command("allowed-models", "set test/a");
    h.ui.custom = async () => {
      h.models.push({ ...h.a, provider: "new-gateway" });
      await h.command("model-prompts", "list");
      return ["test/b"];
    };
    await h.command("allowed-models", "");
    expect(host.cfgEnabledModels.get(h.scope)).toEqual(["test/a", "new-gateway/a"]);
    expect(h.notices.at(-1)).toContain("重新打开");
  });

  test("invalid discovery state is reported without overwriting it or the model selection", async () => {
    const h = await harness();
    await h.command("allowed-models", "set test/a");
    const file = join(h.dir, "model-toolkit-state.json");
    writeFileSync(file, '{"version":999}');
    h.models.push({ ...h.a, provider: "new-gateway" });
    await h.command("allowed-models", "set test/b");
    expect(host.cfgEnabledModels.get(h.scope)).toEqual(["test/a"]);
    expect(readFileSync(file, "utf8")).toBe('{"version":999}');
    expect(h.notices.at(-1)).toContain("网关记录");
  });

  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 4500;
    while (!predicate() && Date.now() < deadline) await Bun.sleep(25);
    expect(predicate()).toBe(true);
  };

  test("session start discovers new gateways without opening either plugin command", async () => {
    const h = await harness();
    await h.command("allowed-models", "set test/a");
    h.models.push({ ...h.a, provider: "startup-gateway" });
    await h.runner.emit({ type: "session_start" });
    expect(host.cfgEnabledModels.get(h.scope)).toEqual(["test/a", "startup-gateway/a"]);
    expect(h.errors).toEqual([]);
  });

  test("idle polling waits for busy turns and catalog refreshes, then stops on shutdown", async () => {
    const h = await harness();
    await h.command("allowed-models", "set test/a");
    await h.runner.emit({ type: "session_start" });
    h.setIdle(false);
    h.models.push({ ...h.a, provider: "live-gateway" });
    await Bun.sleep(2200);
    expect(host.cfgEnabledModels.get(h.scope)).toEqual(["test/a"]);
    h.setPending(true); h.setIdle(true);
    await h.command("model-prompts", "list");
    expect(host.cfgEnabledModels.get(h.scope)).toEqual(["test/a"]);
    h.models.push({ ...h.b, provider: "live-gateway" });
    h.setPending(false);
    await until(() => host.cfgEnabledModels.get(h.scope).length === 3);
    expect(host.cfgEnabledModels.get(h.scope)).toEqual(["test/a", "live-gateway/a", "live-gateway/b"]);
    await h.runner.emit({ type: "session_shutdown" });
    h.models.push({ ...h.a, provider: "after-shutdown" });
    await Bun.sleep(2200);
    expect(host.cfgEnabledModels.get(h.scope)).toHaveLength(3);
    expect(h.errors).toEqual([]);
  }, 12_000);

  test("polling captures the owning profile instead of another session's ambient settings", async () => {
    const one = await harness();
    await one.command("allowed-models", "set test/a");
    await one.runner.emit({ type: "session_start" });
    const two = await harness();
    await two.command("allowed-models", "set test/b");
    await two.runner.emit({ type: "session_start" });
    one.models.push({ ...one.a, provider: "one-only" });
    await until(() => host.cfgEnabledModels.get(one.scope).length === 2);
    expect(host.cfgEnabledModels.get(one.scope)).toEqual(["test/a", "one-only/a"]);
    expect(host.cfgEnabledModels.get(two.scope)).toEqual(["test/b"]);
    expect(one.errors).toEqual([]); expect(two.errors).toEqual([]);
  }, 7000);

  test("subagents never expand the parent's model scope", async () => {
    const parent = await harness();
    await parent.command("allowed-models", "set test/a");
    const child = await harness({ dir: parent.dir, scope: parent.scope, subagent: true,
      models: [...parent.models, { ...parent.a, provider: "child-only" }] });
    await child.runner.emit({ type: "session_start" });
    await child.command("model-prompts", "list");
    expect(host.cfgEnabledModels.get(parent.scope)).toEqual(["test/a"]);
    const state = JSON.parse(readFileSync(join(parent.dir, "model-toolkit-state.json"), "utf8"));
    expect(state.knownProviders).toEqual(["test"]);
  });

  test("a stale persisted session merges new gateways into the latest saved selection", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "config.yml"), 'enabledModels:\n  - test/a\n');
    const first = await host.Settings.loadIsolated({ cwd: dir, agentDir: dir });
    const second = await host.Settings.loadIsolated({ cwd: dir, agentDir: dir });
    const one = await harness({ dir, scope: first });
    const two = await harness({ dir, scope: second, models: one.models });
    await one.command("allowed-models", "set test/b");
    expect(host.cfgEnabledModels.get(second)).toEqual(["test/a"]); // A genuinely stale settings instance.
    one.models.push({ ...one.a, provider: "late-gateway" });
    await two.command("allowed-models", "list");
    expect(host.cfgEnabledModels.get(second)).toEqual(["test/b", "late-gateway/a"]);
    const saved = Bun.YAML.parse(readFileSync(join(dir, "config.yml"), "utf8")) as any;
    expect(saved.enabledModels).toEqual(["test/b", "late-gateway/a"]);
    await one.command("allowed-models", "set test/b");
    await two.command("allowed-models", "list");
    expect(host.cfgEnabledModels.get(second)).toEqual(["test/b"]);
  });

  test.skipIf(process.platform !== "win32")("a denied gateway-state rename leaves the persisted selection untouched", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "config.yml"), 'enabledModels:\n  - test/a\n');
    const settings = await host.Settings.loadIsolated({ cwd: dir, agentDir: dir });
    const h = await harness({ dir, scope: settings });
    await h.command("allowed-models", "list");
    h.models.push({ ...h.a, provider: "new-gateway" });
    const file = join(dir, "model-toolkit-state.json");
    expect(spawnSync("attrib", ["+R", file], { windowsHide: true }).status).toBe(0);
    try {
      await h.command("allowed-models", "list");
      expect(h.notices.at(-1)).toContain("EPERM");
      expect(host.cfgEnabledModels.get(settings)).toEqual(["test/a"]);
      const saved = Bun.YAML.parse(readFileSync(join(dir, "config.yml"), "utf8")) as any;
      expect(saved.enabledModels).toEqual(["test/a"]);
    } finally { spawnSync("attrib", ["-R", file], { windowsHide: true }); }
    await h.command("allowed-models", "list");
    expect(host.cfgEnabledModels.get(settings)).toEqual(["test/a", "new-gateway/a"]);
    await h.command("allowed-models", "set test/a");
    await h.command("allowed-models", "list");
    expect(host.cfgEnabledModels.get(settings)).toEqual(["test/a"]);
  });

  test("a failed settings flush never leaves a discovered gateway eligible to restore later deselections", async () => {
    const h = await harness();
    await h.command("allowed-models", "set test/a");
    h.models.push({ ...h.a, provider: "new-gateway" });
    const originalFlush = h.scope.flush.bind(h.scope);
    // Simulate failure at the persistence boundary; settings, discovery, state and commands remain real.
    h.scope.flush = async () => { throw new Error("fixture: disk full"); };
    try {
      await h.command("allowed-models", "list");
      expect(h.notices.at(-1)).toContain("disk full");
      const state = JSON.parse(readFileSync(join(h.dir, "model-toolkit-state.json"), "utf8"));
      expect(state.knownProviders).toContain("new-gateway");
    } finally { h.scope.flush = originalFlush; }
    host.cfgEnabledModels.set(h.scope, ["test/a"]); // A later native/manual choice has final say.
    await h.scope.flush();
    await h.command("allowed-models", "list");
    expect(host.cfgEnabledModels.get(h.scope)).toEqual(["test/a"]);
  });

  test("a stale all-models picker cannot exclude a gateway it never displayed", async () => {
    const h = await harness();
    await h.command("allowed-models", "reset");
    h.ui.custom = async () => {
      h.models.push({ ...h.a, provider: "new-gateway" });
      await h.command("model-prompts", "list");
      return ["test/a"];
    };
    await h.command("allowed-models", "");
    expect(host.cfgEnabledModels.get(h.scope)).toEqual([]);
    expect(h.notices.at(-1)).toContain("重新打开");
  });

  test("first-upgrade baseline remembers unavailable providers from existing qualified selectors", async () => {
    const h = await harness();
    host.cfgEnabledModels.set(h.scope, ["test/a", "offline/a", "sleeping/b*"]);
    await h.command("allowed-models", "list");
    h.models.push({ ...h.a, provider: "offline" }, { ...h.b, provider: "offline" },
      { ...h.a, provider: "sleeping" }, { ...h.b, provider: "sleeping" });
    await h.command("model-prompts", "");
    expect(host.cfgEnabledModels.get(h.scope)).toEqual(["test/a", "offline/a", "sleeping/b*"]);
    expect(h.menus.at(-1)).toEqual(["offline/a", "sleeping/b", "★ test/a"]);
  });
});

describe("persistent model picker regression", () => {
  test("164 models: repeated toggles preserve focus, scroll position and search query", () => {
    const keys = Array.from({ length: 164 }, (_, i) => `provider/model-${String(i).padStart(3, "0")}`);
    let saved: string[] | undefined;
    const picker = new AllowedModelPicker(keys.map(key => ({ key })), keys, plainTheme, result => { saved = result; }, () => {}, keys[100]);
    const before = picker.render(100);
    picker.handleInput("\r");
    expect(picker.list.getSelectedItem()?.id).toBe(`model:${keys[100]}`);
    expect(picker.list.getSelectedItem()?.currentValue).toContain("[ ]");
    expect(picker.render(100).findIndex(line => line.includes(keys[100]!))).toBe(before.findIndex(line => line.includes(keys[100]!)));
    picker.handleInput("\x1b[B");
    picker.handleInput(" ");
    expect(picker.list.getSelectedItem()?.id).toBe(`model:${keys[101]}`);
    for (const char of "model-15") picker.handleInput(char);
    const state = picker.list.debugState();
    picker.handleInput(" ");
    expect(picker.list.debugState()).toEqual(state);
    picker.handleInput("\r");
    expect(picker.list.debugState()).toEqual(state);
    expect(picker.list.getSearchQuery()).toBe("model-15");
    picker.handleInput("\x13");
    expect(saved).toHaveLength(162);
    expect(saved).not.toContain(keys[100]);
    expect(saved).not.toContain(keys[101]);
  });

  test("filtered Escape first clears search; cancel never returns draft changes", () => {
    const results: (string[] | undefined)[] = [];
    const picker = new AllowedModelPicker([{ key: "test/a" }], ["test/a"], plainTheme, result => results.push(result), () => {}, "test/a");
    picker.handleInput("a"); picker.handleInput(" "); picker.handleInput("\x1b");
    expect(results).toHaveLength(0);
    expect(picker.list.getSearchQuery()).toBe("");
    picker.handleInput("\x1b");
    expect(results).toEqual([undefined]);
  });
});
