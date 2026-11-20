# dsh-chatgpt-to-memory

> ChatGPT 官方导出 → 记忆，一条链全在插件里：**触发导出 → 等邮件 → 下载解压 → 扫描去重 → LLM 蒸馏 → 合并进记忆**。
>
> 不写记忆文件：落库只经过 [`dsh-long-term-memory`](https://github.com/wojiao42/dsh-long-term-memory) 的 `memory_import_candidates`。

**状态：v0.2.0 完整链路**（面板/定时任务只需调用 `import_run`）。

---

## 快速上手

```powershell
# 1) 安装（桌面端：插件页 → 添加插件 → 选本地目录；或命令行）
dsh plugin --profile desktop add github:wojiao42/dsh-chatgpt-to-memory

# 2) 重启 DSH 后，在会话里直接说：
#    「跑一次 ChatGPT 记忆导入」
#    agent 会调用 import_run：导出→下载→扫描→蒸馏→合并，并汇报结果。
```

## 功能（工具）

| 工具 | 作用 |
|---|---|
| `import_run` | **完整链路**：触发/检查导出 → 下载解压 → 扫描去重 → LLM 蒸馏 → 合并记忆；无新导出或新会话时自动跳过 |
| `import_status` | 只读：导出目录、最新包、候选、上次扫描报告、配置 |
| `import_scan` | 只扫描去重，产出待蒸馏数据集（不调模型） |
| `import_distill` | 只对已有数据集做 LLM 蒸馏（可顺带合并） |
| `import_configure` | 读写配置（provider/model、批次大小、是否自动合并等） |

## 口径与安全设计

- **只碰自有数据**：导出目录（默认 `D:\ChatGPT-Backups`）与工作区 `profile/`。
- **不写记忆文件**：候选交给 `dsh-long-term-memory` 落库（唯一写入通道）。
- **网络只在你的 Chrome 登录态里**：导出/下载沿用已跑通的 `weekly.mjs`（邮箱验证码自动重新认证、代理跟随你的环境）。
- **蒸馏规则**：只把 `role=user` 当事实来源、禁止职业推断、禁止从问句反推持有、AI 回复不作事实；敏感内容（孩子健康/家庭/财务）标 `private` 只进详细版。
- **可审计**：每次导入写 `profile/import-runs/<时间戳>/`（数据集、报告），已处理会话记在 `processed-conversations.json`，不重复导入。

## 配置

插件 `config`（profile patch 里给 `- id: chatgpt-to-memory` 加 `config`）：

```yaml
- id: chatgpt-to-memory
  config:
    exportRoot: D:\ChatGPT-Backups
    workdir: D:\deepseek workspace
    autoMerge: true
    distill:
      provider: deepseek-official
      model: ''        # 空 = 用该 provider 的第一个模型
      batchConvs: 20
```

## 自测

```powershell
node --check index.js
node smoke.mjs      # 19 项：静态边界 / 工具注册 / 扫描去重 / 蒸馏 / 合并降级 / 输出解析
```

## 已知边界

- 导出/下载依赖 `weekly.mjs`（随插件一起发布）与 Playwright + 你的 Chrome 登录态；本机首次需 `pnpm install` 拉 `playwright-core`。
- 蒸馏质量取决于模型；低置信/敏感条目按记忆插件的规则进待审或详细版。
- 附件（`.dat`）不解析内容。

## 版本

- **v0.2.0**（2026-11-20）：完整链路进插件——`import_run` 内部完成导出/下载/扫描/蒸馏/合并；新增 `import_distill`；新增已处理会话游标防重复导入。
- **v0.1.0**：M1 扫描去重 + 数据集 + 配置。

## 收录状态

- 待维护者合并：[awesome-dsh-plugin #17270](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17270)
- `dsh-plugin.org` 条目从该清单同步。

## 许可

MIT
