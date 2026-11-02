import { SettingsList, Text, matchesKey, type Component, type SettingItem, type SettingsListTheme } from "@oh-my-pi/pi-tui";

const ON = "[x] 允许";
const OFF = "[ ] 禁用";
export const SAVE = "保存选择";
export const ALL = "全选当前列表";
export const NONE = "清空勾选（尚未保存）";
export const EMPTY_WARNING = "至少选择一个当前可用模型。恢复全部请用 /allowed-models reset。";

export interface ModelEntry { key: string; unavailable?: boolean; }

/** One list for the whole dialog: toggling does not destroy selection, search or viewport. */
export class AllowedModelPicker implements Component {
  readonly list: SettingsList;
  private readonly selected: Set<string>;
  private warning = "";

  constructor(
    private readonly entries: ModelEntry[],
    initial: Iterable<string>,
    theme: SettingsListTheme,
    private readonly done: (keys: string[] | undefined) => void,
    private readonly requestRender: () => void,
    current?: string,
  ) {
    this.selected = new Set(initial);
    const items: SettingItem[] = [
      { id: "save", label: SAVE, currentValue: "Ctrl+S", values: ["Ctrl+S"] },
      { id: "all", label: ALL, currentValue: "", values: [""] },
      { id: "none", label: NONE, currentValue: "", values: [""] },
      ...entries.map(({ key, unavailable }) => ({
        id: `model:${key}`, label: key,
        description: unavailable ? "当前不可用/未匹配；保留此项可在恢复认证后继续使用。" : undefined,
        currentValue: this.selected.has(key) ? ON : OFF, values: [OFF, ON],
      })),
    ];
    this.list = new SettingsList(items, 12, theme, (id, value) => {
      this.warning = "";
      if (id === "save") this.save();
      else if (id === "all" || id === "none") {
        for (const { key } of entries) {
          if (id === "all") this.selected.add(key); else this.selected.delete(key);
          this.list.updateValue(`model:${key}`, id === "all" ? ON : OFF);
        }
      } else {
        const key = id.slice("model:".length);
        if (value === ON) this.selected.add(key); else this.selected.delete(key);
        this.list.updateValue(id, value);
      }
    }, () => this.done(undefined), {
      hint: "↑/↓ 移动 · Enter/空格 勾选 · 输入搜索 · Ctrl+S 保存 · Esc 清除搜索/取消",
    });
    if (current) this.list.selectItem(`model:${current}`);
  }

  private save() {
    if (!this.entries.some(entry => !entry.unavailable && this.selected.has(entry.key))) {
      this.warning = EMPTY_WARNING;
      return;
    }
    this.done([...this.selected]);
  }

  handleInput(data: string) {
    if (matchesKey(data, "ctrl+s")) this.save();
    // In a filtered SettingsList, a literal space otherwise becomes part of the query.
    else this.list.handleInput(data === " " ? "\r" : data);
    this.requestRender();
  }

  render(width: number) {
    return [
      ...new Text(`允许使用的对话模型 · 已选 ${this.selected.size}`, 1, 1).render(width),
      ...this.list.render(width),
      ...(this.warning ? new Text(this.warning, 1, 1).render(width) : []),
    ];
  }

  invalidate() { this.list.invalidate(); }
}
