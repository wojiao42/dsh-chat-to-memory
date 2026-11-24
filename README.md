# dsh-chat-to-memory

[English](README.en.md)

面向 DeepSeek Harness 的统一记忆导入插件：导入 ChatGPT 与 DeepSeek 两个网页端的官方导出，去重后经宿主 LLM 蒸馏，再由 `dsh-long-term-memory` 合并进本地记忆。插件不直接修改记忆文件。

当前版本：v1.0.0（ChatGPT + DeepSeek 双来源）。

---

## 工作方式

两个来源共用同一条后处理链：

1. **获取导出**
   - ChatGPT：调用官方导出流程；遇到近期登录校验时，自动读取注册邮箱验证码并重新认证；等待就绪邮件后下载、解压、校验。
   - DeepSeek：在专用 Chrome 登录态内调用官方导出接口（`export_all` / `download_export_history`），等待生成后下载 ZIP、解压。
2. **去重**：按会话 ID 与消息文本比对；已处理记录分来源保存（`profile/import-runs/processed-conversations.json`、`processed-deepseek.json`）。
3. **蒸馏**：通过宿主 LLM 服务分批提取事实、兴趣与观点；低置信与敏感内容按敏感度分级。
4. **合并**：调用 `dsh-long-term-memory` 的 `memory_import_candidates`，按类型与敏感度写入 `MEMORY.md`、`INTERESTS.md`、`USER-PROFILE.md` 或待审队列。

无新导出或无新增会话时自动跳过，不产生副作用。

## 工具

| 工具 | 说明 |
|---|---|
| `import_run` | ChatGPT 完整链路；无新数据时自动跳过 |
| `import_deepseek` | DeepSeek 完整链路；登录态失效时提示先登录 |
| `import_distill` | 对已有数据集执行 LLM 蒸馏，可选择同时合并 |
| `import_scan` | 仅扫描与去重，产出待蒸馏数据集（ChatGPT 源） |
| `import_status` | 只读查看导出目录、最新导出包、候选文件与上次扫描报告 |
| `import_configure` | 读写插件配置，写入前自动备份 |

## 配置

```yaml
- id: chat-to-memory
  config:
    exportRoot: D:\ChatGPT-Backups
    workdir: D:\deepseek workspace
    autoMerge: true
    distill:
      provider: deepseek-official
      model: ''
      batchConvs: 20
    deepseek:
      profile: D:\ChatGPT-Backups\profile-deepseek
```

- `exportRoot`：ChatGPT 导出包根目录。
- `workdir`：工作区路径；候选与数据集写入其 `profile/` 下。
- `autoMerge`：蒸馏后是否自动合并。
- `distill.provider` / `distill.model`：蒸馏所用模型；`model` 为空时取该提供方首个可用模型。
- `distill.batchConvs`：每批会话数。
- `deepseek.profile`：DeepSeek 专用 Chrome 登录态目录。

## 安全与边界

- 仅访问自有数据：导出目录、工作区 `profile/` 与专用浏览器登录态目录。
- 不直接写入记忆文件，写入统一由 `dsh-long-term-memory` 完成。
- 网络通信仅发生在用户自己的 Chrome 登录态中；代理设置跟随用户环境。
- 蒸馏约束：仅将用户（`role=user`）发言作为事实来源；不推断职业；不从假设性问句推断持有状态；助手回复不作为事实。
- 可审计：每次导入写入 `profile/import-runs/<时间戳>/`，并保留已处理会话记录。

## 安装

1. 桌面端：插件页 → 添加插件 → 选择本地目录。
2. 命令行：`dsh plugin --profile desktop add github:wojiao42/dsh-chat-to-memory`。
3. 本地开发：`dsh plugin --profile desktop add link:D:/dsh-plugins/dsh-chat-to-memory`。

修改 Host 侧代码后需重载插件；本地 link 安装不会自动热更新。

## 自测

```powershell
node --check index.js
node smoke.mjs
```

## 兼容性

- 已在 DSH 0.2.2-rc.5 上验证。
- 依赖宿主提供 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-llm`。
- 需要 Playwright 与两个专用 Chrome 登录态（ChatGPT 导出、DeepSeek 导出各一个）。

## 已知限制

- DeepSeek 导出采用非公开网页接口，接口变更会导致失败；登录态失效需重新登录一次。
- 蒸馏质量取决于所选模型；低置信条目进入待审队列。
- 附件（`.dat`）不解析内容。

## 版本

- **v1.0.0**（2026-11-24）：统一 ChatGPT 与 DeepSeek 两个来源；插件更名为 `dsh-chat-to-memory`；新增 `import_deepseek` 与 DeepSeek 解析器。
- **v0.2.1**：修复 LLM 注入声明；文档正式化。
- **v0.2.0**：完整链路进入插件。
- **v0.1.0**：扫描去重、数据集与配置。

## 收录状态

- 条目更新：awesome-dsh-plugin PR（由 `dsh-chatgpt-to-memory` 更名为 `dsh-chat-to-memory`）。
- `dsh-plugin.org` 条目从该清单同步。

## 许可

MIT
