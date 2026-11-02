import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { cfgEnabledModels } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { filterAvailableModelsByEnabledPatterns } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { availableModels as available, enabledPatterns as patterns, enabledModels as allowed, modelKey, scope } from "./model-scope";
import { AllowedModelPicker, SAVE, ALL, NONE, EMPTY_WARNING } from "./picker";

export default function modelAllowlist(pi: ExtensionAPI) {
  function status(ctx: ExtensionContext) {
    const count = patterns(ctx).length;
    ctx.ui.setStatus("model-allowlist", count ? `模型范围: ${count} 项` : undefined);
  }

  async function save(keys: string[], ctx: ExtensionCommandContext) {
    if (!ctx.isIdle()) throw new Error("请等当前回答结束后再修改模型范围。");
    const settings = scope(ctx);
    const unique = [...new Set(keys)];
    cfgEnabledModels.set(settings, unique);
    await settings.flush();
    status(ctx);
    const origin = settings.getProvenance(cfgEnabledModels);
    if (origin !== "global" && origin !== "default") {
      ctx.ui.notify(`全局配置已保存，但当前 ${origin} 层的 enabledModels 优先级更高；请修改该层或移除其覆盖。`, "warning");
      return;
    }
    const choices = allowed(ctx);
    if (ctx.model && unique.length && !choices.some(m => modelKey(m) === modelKey(ctx.model!))) {
      const first = choices[0];
      if (first && !(await pi.setModel(first))) {
        ctx.ui.notify("白名单已保存，但当前模型切换失败。请用 /allowed-models use 选择。", "warning");
      }
    }
    ctx.ui.notify(unique.length ? `已保存 ${unique.length} 个模型，/model-prompts 已同步。重启 omp 后启动模型和 Ctrl+P 轮换范围完整生效。` : "已恢复全部可用对话模型，/model-prompts 已同步；重启 omp 后轮换范围完整生效。", "info");
  }

  async function picker(ctx: ExtensionCommandContext) {
    if (!ctx.hasUI) throw new Error("此命令需要交互界面；也可用 /allowed-models set provider/model …。");
    if (!ctx.isIdle()) throw new Error("请等当前回答结束后再修改模型范围。");
    const models = available(ctx);
    if (!models.length) throw new Error("没有已配置认证的可用对话模型，请先配置 provider。");
    const previous = patterns(ctx);
    const keys = new Set(allowed(ctx).map(modelKey));
    // Keep unresolved selectors visible instead of silently deleting offline models.
    const unresolved = previous.filter(p => !filterAvailableModelsByEnabledPatterns(models, [p], scope(ctx)).length);
    unresolved.forEach(p => keys.add(p));
    const entries = [...new Set([...models.map(modelKey), ...unresolved])].sort();
    if (ctx.mode === "tui") {
      const result = await ctx.ui.custom<string[] | undefined>((tui, theme, _kb, done) =>
        new AllowedModelPicker(entries.map(key => ({ key, unavailable: unresolved.includes(key) })), keys, {
          label: (text, selected) => theme.fg(selected ? "accent" : "text", text),
          value: (text, selected) => theme.fg(selected ? "accent" : "muted", text),
          description: text => theme.fg("muted", text),
          cursor: theme.fg("accent", "› "),
          hint: text => theme.fg("dim", text),
        }, done, () => tui.requestRender(), ctx.model ? modelKey(ctx.model) : undefined));
      if (result !== undefined) await save(result, ctx);
      return;
    }
    // Non-terminal UI cannot render custom TUI components. Retain its row via initialIndex.
    let initialIndex = 0;
    while (true) {
      const rows = entries.map(key => `${keys.has(key) ? "[x]" : "[ ]"} ${key}${unresolved.includes(key) ? "（当前不可用/未匹配）" : ""}`);
      const options = [SAVE, ALL, NONE, ...rows];
      const chosen = await ctx.ui.select(`允许使用的对话模型 · 已选 ${keys.size} · Esc 取消`, options, { initialIndex });
      if (chosen === undefined) return;
      initialIndex = Math.max(0, options.indexOf(chosen));
      if (chosen === ALL) { entries.forEach(key => keys.add(key)); continue; }
      if (chosen === NONE) { keys.clear(); continue; }
      if (chosen === SAVE) {
        if (!models.some(m => keys.has(modelKey(m)))) {
          ctx.ui.notify(EMPTY_WARNING, "warning");
          continue;
        }
        await save([...keys], ctx);
        return;
      }
      const index = rows.indexOf(chosen);
      if (index >= 0) {
        const key = entries[index]!;
        if (keys.has(key)) keys.delete(key); else keys.add(key);
      }
    }
  }

  pi.on("session_start", (_event, ctx) => status(ctx));
  pi.registerCommand("allowed-models", {
    description: "勾选允许使用的对话模型；list / use / set / reset",
    handler: async (args, ctx) => {
      try {
        const [action = "", ...rest] = args.trim().split(/\s+/);
        if (!action) return await picker(ctx);
        if (action === "list") {
          ctx.ui.notify(`enabledModels (${scope(ctx).getProvenance(cfgEnabledModels)}):\n${patterns(ctx).join("\n") || "全部可用对话模型"}`, "info");
          return;
        }
        if (action === "reset") return await save([], ctx);
        if (action === "use") {
          if (!ctx.hasUI) throw new Error("use 需要交互界面。");
          if (!ctx.isIdle()) throw new Error("请等当前回答结束后切换模型。");
          const models = allowed(ctx);
          if (!models.length) throw new Error("白名单没有匹配的可用模型，请修改白名单或恢复认证。");
          const key = await ctx.ui.select("切换到白名单中的模型", models.map(modelKey));
          const model = models.find(m => modelKey(m) === key);
          if (model && !(await pi.setModel(model))) throw new Error("模型切换失败，请检查认证配置。");
          return;
        }
        if (action === "set") {
          const keys = rest.flatMap(s => s.split(",")).filter(Boolean);
          const known = new Set(available(ctx).map(modelKey));
          if (!keys.length || keys.some(key => !known.has(key))) throw new Error("请提供当前可用的完整 provider/model ID；可先运行 /allowed-models 查看列表。");
          return await save(keys, ctx);
        }
        ctx.ui.notify("/allowed-models：勾选模型\n/allowed-models list：查看\n/allowed-models use：在白名单内切换\n/allowed-models set provider/model …：设置\n/allowed-models reset：恢复全部", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
