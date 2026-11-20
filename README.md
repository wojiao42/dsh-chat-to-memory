# dsh-chatgpt-to-memory

[English](README.en.md)

面向 DeepSeek Harness 的完整记忆导入插件：依次完成传输、去重、蒸馏与合并，将 ChatGPT 官方导出数据中的持久事实写入本地记忆。记忆写入统一由 `dsh-long-term-memory` 的 `memory_import_candidates` 执行，本插件不直接修改记忆文件。

当前版本：v0.2.0（完整链路）。

---

## 工作方式

1. **导出**：调用官方数据导出流程；若触发近期登录校验，自动读取注册邮箱中的验证码并重新认证。
2. **传输**：等待就绪邮件，下载并解压导出包，校验压缩包摘要与会话数量。
3. **去重**：按会话 ID 与消息文本比对，跳过已处理会话；已处理记录保存在 `profile/import-runs/processed-conversations.json`。
4. **蒸馏**：通过宿主 LLM 服务分批提取事实、兴趣与观点，输出候选 JSON；低置信与敏感内容按敏感度分级。
5. **合并**：调用 `dsh-long-term-memory` 的 `memory_import_candidates`，按类型与敏感度写入 `MEMORY.md`、`INTERESTS.md`、`USER-PROFILE.md` 或待审队列。

无新导出或无新增会话时，链路自动跳过，不产生副作用。

## 工具

| 工具 | 说明 |
|---|---|
| `import_run` | 执行完整链路；无新数据时自动跳过 |
| `import_distill` | 对已有数据集执行 LLM 蒸馏，可选择同时合并 |
| `import_scan` | 仅扫描与去重，产出待蒸馏数据集 |
| `import_status` | 只读查看导出目录、最新导出包、候选文件与上次扫描报告 |
| `import_configure` | 读写插件配置，写入前自动备份 |

## 配置

```yaml
- id: chatgpt-to-memory
  config:
    exportRoot: D:\ChatGPT-Backups
    workdir: D:\deepseek workspace
    autoMerge: true
    distill:
      provider: deepseek-official
      model: ''
      batchConvs: 20
```

- `exportRoot`：导出包根目录。
- `workdir`：工作区路径，候选文件与数据集写入其 `profile/` 下。
- `autoMerge`：蒸馏后是否自动合并。
- `distill.provider` / `distill.model`：蒸馏所用模型；`model` 为空时取该提供方的首个可用模型。
- `distill.batchConvs`：每批会话数。

## 安全与边界

- 仅访问自有数据：导出目录与工作区 `profile/`。
- 不直接写入记忆文件，写入统一由 `dsh-long-term-memory` 完成。
- 网络通信仅发生在用户自己的 Chrome 登录态中；代理设置跟随用户环境。
- 蒸馏约束：仅将用户（`role=user`）发言作为事实来源；不推断职业；不从假设性问句推断持有状态；助手回复不作为事实。
- 可审计：每次导入写入 `profile/import-runs/<时间戳>/`，并保留已处理会话记录。

## 安装

1. 桌面端：插件页 → 添加插件 → 选择本地目录。
2. 命令行：`dsh plugin --profile desktop add github:wojiao42/dsh-chatgpt-to-memory`。
3. 本地开发：`dsh plugin --profile desktop add link:D:/dsh-plugins/dsh-chatgpt-to-memory`。

修改 Host 侧代码后需重载插件；本地 link 安装不会自动热更新。

## 自测

```powershell
node --check index.js
node smoke.mjs
```

## 兼容性

- 已在 DSH 0.2.2-rc.5 上验证。
- 依赖宿主提供 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-llm`。
- 导出与下载沿用随插件发布的 `weekly.mjs`，需要 Playwright 与用户自己的 Chrome 登录态。

## 已知限制

- 蒸馏质量取决于所选模型；低置信条目进入待审队列。
- 附件（`.dat`）不解析内容。
- 导入与下载依赖本机 Chrome 登录态，登录失效时需要重新登录一次。

## 版本

- **v0.2.1**（2026-11-20）：修复 LLM 注入声明（inject 增加 llm），蒸馏在宿主中可用；说明文档改为中英对照的正式表述。
- **v0.2.0**（2026-11-20）：完整链路进入插件；新增 `import_distill` 与已处理会话游标。
- **v0.1.0**：扫描去重、数据集与配置。

## 收录状态

- 条目提交：awesome-dsh-plugin [#17270](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17270)，等待维护者合并。

## 许可

MIT
