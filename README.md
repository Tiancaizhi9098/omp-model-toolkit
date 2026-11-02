# OMP Model Toolkit

把 oh-my-pi 的模型选择与模型专属 `APPEND_SYSTEM.md` 放在同一个插件里。中文交互界面，针对 **OMP 18.15.0** 验证。

- `/allowed-models`：勾选允许使用的对话模型。连续勾选时保留光标、搜索和滚动位置。
- `/model-prompts`：只为当前已启用、可用的模型绑定或编辑提示词，与 `/allowed-models` 共用原生 `enabledModels` 规则。
- 禁用模型会隐藏其提示词入口并停止专属内容的注入；文件和绑定保留，重新启用后恢复。

## 安装

将仓库克隆到准备长期保留的目录：

```sh
git clone https://github.com/Tiancaizhi9098/omp-model-toolkit.git
cd omp-model-toolkit
```

Windows PowerShell：

```powershell
.\Install.ps1
# omp 未加入 PATH 时，也可指定程序位置：
.\Install.ps1 -OmpPath 'C:\path\to\omp.exe'
```

脚本链接合并插件，并停用已安装的旧 `omp-model-allowlist` / `omp-model-append-system`，避免重复注册命令。原有模型范围、绑定 JSON 和提示词文件原样保留。

跨平台手动安装：

```sh
omp plugin link .
```

若此前装过两个独立插件，分别运行：

```sh
omp plugin disable omp-model-allowlist
omp plugin disable omp-model-append-system
```

**重启 OMP** 后使用。`link` 指向本目录，安装后请保留此目录；移动后重新执行安装。日常使用无需在插件目录执行 `bun install`。

## 选择模型

输入 `/allowed-models`，用 ↑/↓ 移动，Enter 或空格切换勾选，直接输入模型名搜索。**Ctrl+S 保存**，也可选择“保存选择”。Esc 先清空搜索，再取消未保存的修改。全选、清空作用于整个列表。

至少保留一个当前可用模型；清空勾选不会立即保存。当前模型被排除时，插件尝试切换到允许范围中的第一个可用模型。

| 命令 | 作用 |
| --- | --- |
| `/allowed-models` | 打开多选界面 |
| `/allowed-models list` | 查看有效配置及来源层 |
| `/allowed-models use` | 立即在启用范围内切换模型 |
| `/allowed-models set provider/model-a provider/model-b` | 按完整 ID 设置启用范围 |
| `/allowed-models reset` | 清除全局限制，恢复全部可用对话模型 |

选择通过 OMP 原生设置接口保存到当前 profile 的全局 `config.yml` 的 `enabledModels`。项目、命令行和运行时覆盖保持原优先级；高优先级配置覆盖全局设置时会提示。两条命令每次都读取**当前有效配置**，因此 `/model-prompts` 立即同步，无需重启。OMP 启动模型和已有 Ctrl+P 轮换列表在重启后完整生效。

空 `enabledModels` 表示全部可用模型；非空但没有匹配项时，提示词列表为空，不会回退到全部模型。原有通配符、角色别名沿用宿主匹配逻辑；保存勾选结果会把已匹配项具体化为完整 ID。当前不可用的旧选择会留在列表中，供你决定保留或移除。保存会替换全局该字段，包括该字段原有的路径条件。

**范围说明：**这是原生对话模型范围管理。图像、语音、搜索、judge 等专用角色，显式 `--model` 及部分回退路径仍遵循宿主规则；本插件不保证拦截所有超出范围的 API 请求。禁用模型的专属提示词不会被本插件主动注入。

## 为启用的模型绑定提示词

运行 `/model-prompts`，选择启用模型，然后选择编辑、绑定已有文件、查看路径或解除绑定。

```text
/model-prompts edit
/model-prompts edit provider/model
/model-prompts bind provider/model "C:\我的提示词\APPEND_SYSTEM.md"
/model-prompts show provider/model
/model-prompts unbind provider/model
/model-prompts list
```

`provider/model` 替换为列表中的完整 ID，区分不同 provider 的同名模型。`edit` / `show` 省略 ID 时使用当前模型。禁用、不可用的模型不能新增绑定或编辑；`list` 同样只列出启用模型。显式 `unbind provider/model` 可清理旧的禁用模型绑定，原文件保留。

编辑会打开 OMP 内置编辑器，保存时创建或更新对应文件。取消编辑不会写入。绑定已有文件支持中文、空格、`~`；相对路径以当前工作目录为准，保存为绝对路径。

默认存储位置与旧插件相同，无需迁移：

```text
~/.omp/agent/model-append-system.json
~/.omp/agent/model-prompts/<模型名与唯一后缀>/APPEND_SYSTEM.md
```

命名 profile、自定义 agent 目录使用各自目录。手工维护 JSON 时，相对路径以该 agent 目录为基准：

```json
{
  "version": 1,
  "bindings": {
    "provider/model": "model-prompts/example/APPEND_SYSTEM.md"
  }
}
```

### 注入行为

保留宿主系统提示词、全局/项目 `APPEND_SYSTEM.md` 和其他扩展内容，追加本模型专属内容。每次请求读取文件，外部修改在下次请求生效。本插件只替换自己的标记片段，重试不会重复追加，换模或解绑会移除旧片段。

普通新回合通过 `before_agent_start` 注入；`before_provider_request` 还会按实际请求模型更新内容，处理回合内换模和回退。已测试 OpenAI Chat Completions、Responses / Codex WebSocket、Anthropic、Bedrock、Google SDK、Gemini CLI 的 system 字段。未知请求结构会提示适配限制；不调用请求 hook 的 transport 和独立辅助请求不在保证范围内。宿主可能吞掉扩展错误，因此文件出错时请求中止也不能作为强制阻断保证。

提示词须为 UTF-8，最大 512 KiB；空文件表示不追加。缺失文件、无效编码及插件保留标记会报告错误。用户消息、工具消息、历史回答不被改写。

## 更新与卸载

在克隆目录 `git pull` 后重启 OMP 即可更新。暂时停用：

```sh
omp plugin disable omp-model-toolkit
```

卸载：`omp plugin uninstall omp-model-toolkit`。如需恢复全部模型，卸载前先执行 `/allowed-models reset`，或手工删除原生 `enabledModels`。绑定与文件保留。

## 开发与验证

```sh
bun install
bun run check
bun test tests
```

需要 OMP 18.15.0 开发依赖及该版本可用的 native addon。测试使用隔离设置和模拟模型，不调用付费推理接口；临时文件写入 `work/plugin-tests`。测试涵盖 164 项列表连续勾选、搜索状态、保存/取消、真实 OMP 扩展加载、原生配置优先级、启用模型联动、绑定保留与请求提示词替换。

另用 Windows 上的真实 `omp.exe` 和本机 loopback 模拟接口验证插件加载及请求内容。兼容范围声明为 OMP `>=18.15.0 <19`，已验证版本为 18.15.0；升级宿主后应重新检查设置接口和请求结构。

## 接口依据

- [OMP 扩展接口](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md)
- [模型配置](https://github.com/can1357/oh-my-pi/blob/main/docs/models.md)
- [插件管理](https://github.com/can1357/oh-my-pi/blob/main/docs/plugin-manager-installer-plumbing.md)
- [系统提示词定制](https://github.com/can1357/oh-my-pi/blob/main/docs/system-prompt-customization.md)

MIT License.
