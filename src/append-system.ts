import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { patchPayload, replaceSystem } from "./prompt";
import { absolutePath, atomicWrite, bind, configPath, defaultPromptPath, parseArgs, readBindings, readPrompt, resolvePrompt } from "./storage";
import { enabledModels, isEnabledModel, modelKey, requireEnabledModel } from "./model-scope";
import type { GatewaySync } from "./gateway-sync";

export default function modelAppendSystem(pi: ExtensionAPI, gateways: GatewaySync) {
  const agentDir = (ctx: ExtensionContext) => findScopedSettings(ctx.cwd)?.getAgentDir() ?? pi.pi.getAgentDir();
  // State belongs to this factory/session; child sessions must not share prompt state.
  let preparedKey: string | undefined;
  const warned = new Set<string>();

  function report(ctx: ExtensionContext, message: string) {
    if (!warned.has(message)) { warned.add(message); ctx.ui.notify(message, "warning"); }
  }

  pi.on("before_agent_start", (event, ctx) => {
    if (event.reason === "revive") return;
    preparedKey = ctx.model ? modelKey(ctx.model) : undefined;
    try {
      const binding = preparedKey && isEnabledModel(ctx, preparedKey) ? resolvePrompt(agentDir(ctx), preparedKey) : undefined;
      ctx.ui.setStatus("model-append-system", binding ? "模型提示词: 已绑定" : undefined);
      return { systemPrompt: replaceSystem(event.systemPrompt, binding?.text) };
    } catch (error) {
      ctx.abort();
      report(ctx, `读取模型提示词失败，已请求中止当前操作：${error instanceof Error ? error.message : String(error)}`);
      return { systemPrompt: replaceSystem(event.systemPrompt) };
    }
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!ctx.model) return;
    const key = modelKey(ctx.model);
    try {
      const binding = isEnabledModel(ctx, key) ? resolvePrompt(agentDir(ctx), key) : undefined;
      const result = patchPayload(event.payload, binding?.text);
      if (result.supported) return result.payload;
      if (binding || (preparedKey && key !== preparedKey)) {
        report(ctx, `模型 ${key} 的请求格式不在已验证适配范围内：普通新回合可使用 before_agent_start 注入；回合内换模/回退的提示词无法保证更新。`);
      }
    } catch (error) {
      ctx.abort();
      report(ctx, `更新模型提示词失败，已请求中止当前操作：${error instanceof Error ? error.message : String(error)}`);
      const clean = patchPayload(event.payload);
      if (clean.supported) return clean.payload;
    }
  });

  async function chooseModel(ctx: ExtensionCommandContext) {
    const config = readBindings(agentDir(ctx));
    const keys = enabledModels(ctx).map(modelKey).sort();
    const current = ctx.model ? modelKey(ctx.model) : undefined;
    if (!keys.length) throw new Error("没有已启用的可用模型。请先检查 /allowed-models 和 provider 认证。");
    const rows = keys.map(key => `${key === current ? "★ " : ""}${key}${config.bindings[key] ? "  [已绑定]" : ""}`);
    const row = await ctx.ui.select("选择已启用模型（与 /allowed-models 同步）", rows);
    const index = row === undefined ? -1 : rows.indexOf(row);
    return index < 0 ? undefined : keys[index];
  }

  async function edit(key: string, ctx: ExtensionCommandContext) {
    requireEnabledModel(ctx, key);
    const existing = resolvePrompt(agentDir(ctx), key);
    const path = existing?.path ?? defaultPromptPath(agentDir(ctx), key);
    const initial = existing?.text ?? (existsSync(path) ? readPrompt(path) : "");
    const text = await ctx.ui.editor(`${key} · APPEND_SYSTEM.md（保存后下次请求生效）`, initial);
    if (text === undefined) return;
    requireEnabledModel(ctx, key);
    if (new TextEncoder().encode(text).length > 512 * 1024 || text.includes("<!-- omp:model-append-system:")) throw new Error("提示词超过 512 KiB，或包含插件保留标记。");
    atomicWrite(path, text);
    bind(agentDir(ctx), key, path);
    ctx.ui.notify(`已保存并绑定：${key}\n${path}`, "info");
  }

  async function bindFile(key: string, input: string, ctx: ExtensionCommandContext) {
    requireEnabledModel(ctx, key);
    const path = absolutePath(input, ctx.cwd);
    readPrompt(path);
    bind(agentDir(ctx), key, path);
    ctx.ui.notify(`已绑定 ${key}\n${path}`, "info");
  }

  pi.registerCommand("model-prompts", {
    description: "仅为已启用模型绑定/编辑 APPEND_SYSTEM.md；bind / edit / show / unbind / list",
    handler: async (args, ctx) => {
      try {
        await gateways.sync(ctx);
        const [action = "", specified, ...rest] = parseArgs(args);
        if (action === "list") {
          const bindings = readBindings(agentDir(ctx)).bindings;
          const rows = enabledModels(ctx).map(modelKey).sort().map(key => `${key}\n  ${bindings[key] ?? "尚未绑定"}`);
          ctx.ui.notify(`已启用模型的提示词（与 /allowed-models 同步）\n${configPath(agentDir(ctx))}\n${rows.join("\n") || "没有已启用的可用模型"}`, "info");
          return;
        }
        if (action === "help") {
          ctx.ui.notify('/model-prompts：交互管理\n/model-prompts edit [provider/model]：编辑\n/model-prompts bind provider/model "文件路径"：绑定\n/model-prompts show [provider/model]：显示路径\n/model-prompts unbind provider/model：解除\n/model-prompts list：列出绑定', "info");
          return;
        }
        if (action && !["bind", "edit", "show", "unbind"].includes(action)) throw new Error("未知操作，使用 /model-prompts help。");
        if (!action || action === "edit") {
          if (!ctx.hasUI) throw new Error("编辑需要交互界面；可用 bind 绑定现有文件。");
          if (!ctx.isIdle()) throw new Error("请等当前回答结束后再编辑提示词。");
        }
        const key = specified ?? (action ? (ctx.model ? modelKey(ctx.model) : undefined) : await chooseModel(ctx));
        if (!key) return;
        // Explicit unbind may clean up an old, disabled model without re-enabling it.
        if (action !== "unbind" || !Object.hasOwn(readBindings(agentDir(ctx)).bindings, key)) requireEnabledModel(ctx, key);
        if (action === "bind") {
          if (rest.length !== 1) throw new Error('用法：/model-prompts bind provider/model "文件路径"');
          return await bindFile(key, rest[0]!, ctx);
        }
        if (action === "unbind") { bind(agentDir(ctx), key, undefined); ctx.ui.notify(`已解除 ${key} 的绑定，原文件保留。`, "info"); return; }
        if (action === "show") { ctx.ui.notify(resolvePrompt(agentDir(ctx), key)?.path ?? `${key} 尚未绑定文件。`, "info"); return; }
        if (action === "edit") return await edit(key, ctx);
        const selected = await ctx.ui.select(key, ["编辑专属 APPEND_SYSTEM.md", "绑定已有文件", "查看绑定路径", "解除绑定"]);
        if (selected === "编辑专属 APPEND_SYSTEM.md") return await edit(key, ctx);
        if (selected === "绑定已有文件") {
          const input = await ctx.ui.input("输入 APPEND_SYSTEM.md 路径（可含空格，无需加引号）");
          if (input?.trim()) await bindFile(key, input.trim(), ctx);
        } else if (selected === "查看绑定路径") ctx.ui.notify(resolvePrompt(agentDir(ctx), key)?.path ?? "尚未绑定", "info");
        else if (selected === "解除绑定") { bind(agentDir(ctx), key, undefined); ctx.ui.notify("已解除绑定，原文件保留。", "info"); }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
