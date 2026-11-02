import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { cfgEnabledModels } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { filterAvailableModelsByEnabledPatterns } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";

export const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

export function scope(ctx: ExtensionContext) {
  const settings = findScopedSettings(ctx.cwd);
  if (!settings) throw new Error("当前会话的设置尚未初始化。");
  return settings;
}

export const availableModels = (ctx: ExtensionContext) => ctx.modelRegistry.getAvailable();
export const enabledPatterns = (ctx: ExtensionContext) => [...cfgEnabledModels.get(scope(ctx))];

// Resolve on every call, using the same settings precedence, aliases and matcher as OMP.
// An empty setting means all models; a nonempty setting with no matches means none.
export function enabledModels(ctx: ExtensionContext) {
  const models = filterAvailableModelsByEnabledPatterns(availableModels(ctx), enabledPatterns(ctx), scope(ctx));
  return [...new Map(models.map(model => [modelKey(model), model])).values()];
}

export const isEnabledModel = (ctx: ExtensionContext, key: string) =>
  enabledModels(ctx).some(model => modelKey(model) === key);

export function requireEnabledModel(ctx: ExtensionContext, key: string) {
  if (!isEnabledModel(ctx, key)) {
    throw new Error(`模型 ${key} 未启用或当前不可用。请先在 /allowed-models 启用，再绑定提示词。`);
  }
}
