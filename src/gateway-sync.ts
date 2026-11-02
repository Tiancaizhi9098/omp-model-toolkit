import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgEnabledModels } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { availableModels, modelKey, scope } from "./model-scope";
import { atomicWrite } from "./storage";

interface GatewayState { version: 1; knownProviders: string[]; }
const statePath = (settings: Settings) => join(settings.getAgentDir(), "model-toolkit-state.json");

function readState(path: string): GatewayState | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1
      || !("knownProviders" in value) || !Array.isArray(value.knownProviders)
      || value.knownProviders.some(p => typeof p !== "string" || !p.trim())) {
      throw new Error("需要 version: 1 和 knownProviders 字符串数组");
    }
    return { version: 1, knownProviders: value.knownProviders };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`读取网关记录失败：${path}\n${error instanceof Error ? error.message : String(error)}`);
  }
}

// Also includes the effective layer: a project/runtime change can stale an open picker.
export function selectionSnapshot(ctx: ExtensionContext, settings = scope(ctx)) {
  return JSON.stringify([settings.getGlobalSettings().enabledModels ?? null,
    cfgEnabledModels.get(settings), settings.getProvenance(cfgEnabledModels),
    [...new Set(availableModels(ctx).map(modelKey))].sort()]);
}

export type GatewaySync = ReturnType<typeof createGatewaySync>;

export function createGatewaySync() {
  let stopWatching: (() => void) | undefined;
  const ready = (ctx: ExtensionContext) => ctx.agent.kind === "main" && ctx.isIdle()
    && !ctx.modelRegistry.isBackgroundRefreshPending();
  async function transaction<T>(settings: Settings, fn: () => Promise<T>): Promise<T> {
    mkdirSync(settings.getAgentDir(), { recursive: true });
    // The host lock is process-safe and released by the OS if a session crashes.
    return withFileLock(statePath(settings), async () => {
      await settings.reloadFromDisk();
      return fn();
    });
  }

  async function discover(ctx: ExtensionContext, settings: Settings) {
    const path = statePath(settings), previous = readState(path);
    const models = availableModels(ctx);
    const raw = settings.getGlobalSettings().enabledModels;
    const known = new Set((previous?.knownProviders ?? models.map(m => m.provider)).map(p => p.toLowerCase()));
    // A saved provider/model selection also proves a provider is old, even if offline
    // during upgrade. Leave bare aliases and wildcard provider prefixes to the host.
    if (Array.isArray(raw)) for (const selector of raw) {
      if (typeof selector !== "string") continue;
      const trimmed = selector.trim(), slash = trimmed.indexOf("/");
      if (slash <= 0 || !trimmed.slice(slash + 1)) continue;
      const provider = trimmed.slice(0, slash);
      if (![...provider].some(c => "*?[]\\:".includes(c) || /\s/.test(c))) known.add(provider.toLowerCase());
    }
    const added = models.filter(m => !known.has(m.provider.toLowerCase())).map(modelKey);
    models.forEach(m => known.add(m.provider.toLowerCase()));
    if (!previous || known.size !== new Set(previous.knownProviders.map(p => p.toLowerCase())).size) {
      // Persist identity FIRST. A failed state write must never expand the selection.
      // If the later settings write fails, keep the identity so retries cannot undo
      // a subsequent manual deselection; the user can enable it explicitly.
      atomicWrite(path, `${JSON.stringify({ version: 1, knownProviders: [...known].sort() }, null, 2)}\n`);
    }
    // Empty means all; conditional arrays are intentionally left under native control.
    // Read the GLOBAL layer, never copy a project/runtime restriction into global config.
    if (added.length && Array.isArray(raw) && raw.length && raw.every(p => typeof p === "string")) {
      const next = [...new Set([...raw, ...added])];
      if (next.length !== raw.length) {
        cfgEnabledModels.set(settings, next);
        try { await settings.flush(); }
        catch (error) {
          throw new Error(`新网关记录已保存，但模型配置写入失败。修复后请在 /allowed-models 检查并手动保存选择：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  async function sync(ctx: ExtensionContext, settings = scope(ctx), active = () => true) {
    if (!active() || !ready(ctx)) return;
    await transaction(settings, async () => {
      if (active() && ready(ctx)) await discover(ctx, settings);
    });
  }

  async function save(keys: string[], ctx: ExtensionContext, snapshot?: string) {
    if (ctx.agent.kind !== "main") throw new Error("请在主会话中修改模型范围。");
    const settings = scope(ctx);
    await transaction(settings, async () => {
      if (!ctx.isIdle()) throw new Error("请等当前回答结束后再修改模型范围。");
      if (ctx.modelRegistry.isBackgroundRefreshPending()) throw new Error("模型目录正在刷新，请稍后再保存模型范围。");
      await discover(ctx, settings);
      if (snapshot !== undefined && snapshot !== selectionSnapshot(ctx, settings)) {
        throw new Error("模型范围已更新，请重新打开 /allowed-models 后保存，避免覆盖新选择。");
      }
      cfgEnabledModels.set(settings, [...new Set(keys)]);
      await settings.flush();
    });
  }

  const stop = () => { stopWatching?.(); stopWatching = undefined; };

  async function start(ctx: ExtensionContext) {
    stop();
    if (ctx.agent.kind !== "main") return;
    // A timer must keep its owning scope; another session can change ambient settings.
    const settings = scope(ctx);
    let active = true, running = false, previousCatalog: string | undefined;
    const warned = new Set<string>();
    const poll = async () => {
      if (!active || running || !ready(ctx)) return;
      const catalog = JSON.stringify([...new Set(availableModels(ctx).map(m => m.provider))].sort());
      if (catalog === previousCatalog) return;
      running = true;
      try {
        await sync(ctx, settings, () => active);
        if (active && ready(ctx)) previousCatalog = catalog;
      } catch (error) {
        const message = `自动启用新网关失败：${error instanceof Error ? error.message : String(error)}`;
        if (active && !warned.has(message)) { warned.add(message); ctx.ui.notify(message, "warning"); }
      } finally { running = false; }
    };
    const timer = ctx.setInterval(poll, 2000);
    stopWatching = () => { active = false; ctx.clearTimer(timer); };
    await poll();
  }

  return { sync, save, start, stop };
}
