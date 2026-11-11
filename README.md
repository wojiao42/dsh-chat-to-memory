# dsh-chatgpt-to-memory

> 把 ChatGPT 官方导出**蒸馏成记忆候选**的 DeepSeek Harness 插件：触发导出 → 下载 → 去重 → 出数据集与候选，交给 [`dsh-long-term-memory`](https://github.com/wojiao42/dsh-long-term-memory) 落库。
>
> **本插件不写记忆文件**；写入记忆的唯一通道是 `dsh-long-term-memory` 的 `memory_import_candidates`。

**状态：M1 开发中**（扫描/去重/数据集/配置已可用；导出下载部分仍是工作区脚本，M2 迁入）。

---

## 快速上手

```powershell
# 1) 安装（M1 阶段先用本地目录）
dsh plugin --profile desktop add link:D:/dsh-plugins/dsh-chatgpt-to-memory

# 2) 重启 DSH 后，在会话里：
#    import_status      看导出目录/配置/上次扫描
#    import_configure   读写蒸馏取向配置
#    import_scan        扫描最新导出，统计新增会话并产出数据集
```

## 功能

| 工具 | 作用 |
|---|---|
| `import_status` | 只读：导出根目录、最新导出包、候选文件、上次扫描报告、配置 |
| `import_configure` | `get` / `set` 蒸馏取向（`profile/distill-config.json`，写前备份） |
| `import_scan` | **核心**：扫描最新导出 → 按会话 id + 消息文本去重 → 统计新增 → 写数据集与报告 |
| `import_preview` | 同 scan，但面向"看质量/数量"，并在结果里给出蒸馏要求 |
| `import_run` | M1 占位：完整链路（导出→下载→重新认证）待 M2 迁入 |

数据集落点：`<cwd>/profile/import-runs/<时间戳>/dataset.json` + `report.json`。

## 口径与安全设计

- **只读用户自己的数据**：导出目录（默认 `D:\ChatGPT-Backups`）与工作区 `profile/`。
- **不写记忆文件**：候选由 agent 蒸馏后写到 `profile/inbox/candidates-*.json`，由 `dsh-long-term-memory` 消费。
- **不联网**（M1）：本插件自身不发网络请求；M2 的网络只发生在用户自己的 Chrome profile 里，代理跟随用户环境。
- **不执行命令**（M1）：不 spawn 子进程。
- **去重三层**（本插件做前两层）：会话级（conversation id）→ 消息级（文本归一化精确匹配）→ 事实级（消费端再做）。
- **蒸馏硬规则**：只把 `role=user` 当事实来源；禁止职业推断；禁止从问句反推持有；AI 回复仅作上下文。

## 安装

1. 图形界面（桌面端推荐）：设置 → 插件市场 → 自定义安装 → 填 `github:wojiao42/dsh-chatgpt-to-memory`
2. 命令行：`dsh plugin --profile web add github:wojiao42/dsh-chatgpt-to-memory`
3. 本地源码开发：`dsh plugin --profile desktop add link:D:/dsh-plugins/dsh-chatgpt-to-memory`

## 自测

```powershell
node --check index.js
node smoke.mjs
```

## 兼容

- DSH `0.2.2-rc.1` 验证中。
- 依赖宿主提供 `@deepseek-ai/dsh-tools`；M2 接入浏览器时再加 `playwright-core`（可选安装）。

## 已知边界

- M1 不含导出触发/下载/邮件轮询：这部分仍在 `D:\deepseek workspace\automation\chatgpt-export`（已实测跑通）。
- 旧会话里的"新增消息"本阶段整段跳过（保守策略），后续按需要放开。
- 附件（`.dat`）不解析。

## 版本

- **v0.1.0**（2026-11-11）：M1 骨架 —— `import_status` / `import_configure` / `import_scan` / `import_preview`；扫描+两层去重+数据集+报告；`import_run` 占位。

## 收录状态

待发布后提交 awesome-dsh-plugin / dsh-plugin.org。

## 许可

MIT
