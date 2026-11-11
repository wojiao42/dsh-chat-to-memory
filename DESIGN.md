# dsh-chatgpt-to-memory 插件设计草案（v0.1）

- 日期：2026-11-11
- 状态：设计草案（待用户过目后开工）
- 关联：`dsh-long-term-memory`（消费端）、工作区 `automation\chatgpt-export`（现有脚本，将迁移进来）
- 目标读者：作者本人 / 用户
- **实现进度**：
  - ✅ 2026-11-11：`dsh-long-term-memory` **v1.4.0** 已完成「读取引导」+ `memory_recall` 纳入 profile 详细记忆文件（54/54 smoke 通过，commit `280d035`，已同步安装副本，**待 DSH 重启生效**）
  - ⬜ `dsh-chatgpt-to-memory`：设计完成，代码待写

---

## 1. 目标

把「**外部数据导出 → 下载 → 蒸馏 → 合并进本地记忆**」做成两个可独立安装的 DSH 插件：

1. **`dsh-long-term-memory`（已有，扩展一点）**——继续负责"记忆的落库与注入"，新增一个消费候选文件的工具；保持**零依赖、纯文件、可审计**。
2. **`dsh-chatgpt-to-memory`（新建）**——负责"从外部数据源生产候选事实"：读导出包、去重、调 LLM 蒸馏，产出候选 JSON 交给上面消费。允许重依赖（Playwright / 浏览器登录态 / 代理）。

最终用户体验：装好后，每周自动把 ChatGPT 新导出蒸馏成事实/兴趣，落进分层记忆文件，全程有审计和回滚。

## 2. 非目标（v0.x 明确不做）

- ❌ 不做云端同步、不上传任何用户数据
- ❌ 不自动登录第三方账号（登录态复用本机 Chrome profile，失效时提示用户手动登录一次）
- ❌ 不解析导出包里的附件（`.dat` 图片/文件）
- ❌ 不做语义向量检索 / 知识图谱
- ❌ 不猜职业、不从问句反推持有、不把 AI 回复当用户事实

## 3. 为什么拆两个插件（决策）

| 方案 | 结论 | 理由 |
|---|---|---|
| 全合并进 `dsh-long-term-memory` | ❌ | 会破坏其核心卖点「零依赖、纯 Markdown、不联网」，安装门槛和审核风险都升高 |
| 单开一个"全功能"新插件 | ❌ | 记忆写入逻辑与导出自动化耦合，升级/审计互相牵连 |
| **生产者/消费者拆分** | ✅ | 记忆层保持轻；导入层可选安装；两者只通过**文件协议**交互，互不 import |

## 4. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│ DSH 原生「自动化任务」（定时，绑会话）                          │
│   每周日 10:00 / 周一·周二窗口 → 唤醒会话执行 import 流程        │
└───────────────┬─────────────────────────────────────────────┘
                ▼
┌─────────────────────────────────────────────────────────────┐
│ dsh-chatgpt-to-memory（新插件，Host 侧）                          │
│  export-trigger ─ 等邮件 ─ download ─ extract                │
│  dedupe ─ batch ─ distill(LLM) ─ 产出 candidates-*.json      │
│  写审计：import-runs/<时间戳>/report.json + 日志              │
└───────────────┬─────────────────────────────────────────────┘
                ▼ 文件协议：profile/inbox/candidates-<YYYY-MM-DD>.json
┌─────────────────────────────────────────────────────────────┐
│ dsh-long-term-memory（已有，仅新增一个工具）                        │
│  memory_import_candidates：分层写入 + 去重 + 备份 + git + 报告  │
│  → MEMORY.md（注入） / INTERESTS.md / USER-PROFILE.md（不注入）│
└─────────────────────────────────────────────────────────────┘
```

## 5. 文件协议（v1）

### 5.1 目录布局

```
<workdir>\.dsh\memory\MEMORY.md        # 每轮注入：只放关于用户的事实/偏好/边界/指令
<workdir>\profile\
├── INTERESTS.md                        # 不注入：文化/思想兴趣（详细）
├── USER-PROFILE.md                     # 不注入：详细画像（含偏隐私细节）
├── NOTES-PROJECTS.md                   # 不注入：项目/技术过程
├── distill-config.json                 # 蒸馏取向（首次运行向导写入）
├── inbox\candidates-<date>.json        # 生产者→消费者的候选文件
├── inbox\incremental-<date>.md         # 待审清单（低置信/冲突/超限）
├── backup\                             # 每次写入前的整份备份
└── import-runs\<时间戳>\               # 每次导入的审计：report.json / distill-raw.json / 日志
```

### 5.2 候选文件 schema（v1）

```json
{
  "version": 1,
  "source": "chatgpt-export",
  "exportDate": "2026-11-09",
  "generatedAt": "2026-11-11T21:48:00+08:00",
  "dedupe": { "conversations": 394, "newConversations": 65, "userTurns": 1824, "alreadyProcessed": 1503 },
  "items": [
    {
      "type": "fact | interest | viewpoint",
      "category": "身份|家庭|硬件|消费|项目|习惯|边界 | 文化作品|思想观点|影视动漫|游戏|网络文化|历史军事|其他 | 观点",
      "text": "一句话中文事实，具体可核实",
      "confidence": "high | medium | low",
      "sensitivity": "normal | private | restricted",
      "date": "YYYY-MM-DD",
      "convId": "会话 id",
      "title": "会话标题",
      "quotes": ["用户原话摘录 ≤60 字"]
    }
  ]
}
```

- `sensitivity`：`private` = 孩子健康/家庭细节/财务 → 默认只写 `USER-PROFILE.md`，不进注入文件；`restricted` = 默认只进待审，除非配置允许。
- 消费者必须校验 `version`，不认识的字段忽略（向前兼容）。

### 5.3 配置 schema（`distill-config.json`）

```json
{
  "version": 1,
  "scope": "facts+interests+viewpoints",     // facts-only | facts+interests+viewpoints | everything
  "sensitivity": {
    "private": "detailed-only",              // detailed-only | pending | skip
    "restricted": "pending"                  // pending | skip | allowed
  },
  "writeMode": "auto-high",                  // auto-high | all-pending | report-only
  "autoWriteLimitPerRun": "first-import-unlimited", // 首次导入不限条数；日常增量建议 3
  "distill": {
    "provider": "default",                   // default = 跟随当前会话模型
    "model": "default",
    "batchConvs": 35,
    "timeoutMs": 600000
  },
  "schedule": { "afterExport": true, "windows": "auto" },
  "git": { "enabled": true, "commitPerImport": true },
  "sources": { "chatgptExport": true, "deepseekExport": false, "dshSessions": false }
}
```

## 6. 工具与 API

### 6.1 `dsh-long-term-memory` 新增工具：`memory_import_candidates`

| 项 | 内容 |
|---|---|
| 入参 | `file`（候选文件路径，可选，默认取 inbox 最新）；`dryRun`（默认 false）；`limit`（单次最多写入条数）；`scope` |
| 行为 | 校验 schema → 按 `type/sensitivity` 分派目标文件 → 与现有记忆去重（完全相同跳过）→ 写前整份备份 → 写入或转待审 → 可选 git commit → 写审计报告 |
| 返回 | `{ ok, written: {memory, interests, profile}, pending, skipped, duplicates, backup, report }` |
| 安全 | 不认不认识的文件路径（限制在 `profile\inbox\` 与 `profile\` 内）；不联网；不读对话 |

> 设计要点：`long-term-memory` 仍然不依赖任何第三方包，只做文件与 JSON 操作。

### 6.2 `dsh-chatgpt-to-memory` 工具（Host 侧注册）

| 工具 | 作用 |
|---|---|
| `import_status` | 显示：上次导入时间、导出包位置、待蒸馏会话数、上次报告路径 |
| `import_scan` | 只读扫描最新导出包，报告"新增会话/原话/去重命中"数量（不蒸馏） |
| `import_preview` | 对一批会话做 dry-run 蒸馏（只输出候选，不写记忆），用于看质量 |
| `import_run` | 跑完整流程：导出（可选）→ 下载 → 解压 → 扫描 → 蒸馏 → 写候选文件；`--no-export` 只用已有包 |
| `import_configure` | 写/改 `distill-config.json`（首次向导也走它） |

每个工具都要求 `dryRun` 可用；`import_run` 默认**不自动合并进记忆**，只产候选并打印"接下来可调 `memory_import_candidates`"。

## 7. 蒸馏管线

1. **导出/下载**（复用现有 `chatgpt-export` 逻辑迁移为插件模块）
   - 触发导出需要"最近登录"，已实现自动邮箱验证码重新认证
   - 下载走 `browserContext.request`（显式传用户环境代理）
   - 解压后统计分片 `conversations-*.json`
2. **去重（三级）**
   - 会话级：按 conversation id 对比 `profile\raw\user-turns.jsonl`（历史已处理语料），只处理新会话/新增消息
   - 消息级：文本归一化后精确匹配，命中即跳过
   - 事实级（消费端再做一次）：与 MEMORY/INTERESTS/USER-PROFILE 高度相似则丢弃或转待审
3. **分批蒸馏**
   - 每批 ≤35 个会话，保留会话标题 + 用户原话 + AI 回复前 100 字作上下文
   - 用当前会话模型（或配置的 provider/model）按统一提示词抽三类条目
   - 提示词硬约束：不推断职业、不从问句反推持有、AI 内容不作为事实、短句低置信、宁缺勿滥
4. **落候选**：写 `profile\inbox\candidates-<date>.json` + 审计
5. **消费**：`memory_import_candidates` 按配置落库/转待审

## 7.5 为什么分层注入、为什么高置信才自动写（设计依据）

**记忆有两个去处，不是「记不记」的问题，而是「每轮刷不刷屏」：**

| 去处 | 谁看得到 | 成本 | 放什么 |
|---|---|---|---|
| `MEMORY.md`（注入） | 每轮对话一上来就在我上下文里 | 每轮 token | 稳定事实、偏好、边界、回答口径——**不了解就会答错**的东西 |
| `INTERESTS.md` / `USER-PROFILE.md` / `NOTES-PROJECTS.md`（不注入） | 需要时我主动 `read` 才看到 | 只在读时花 | 详细内容：兴趣作品、孩子成长数字、挖矿经济账、项目过程——**问到才需要** |

所以「只进详细版」= **仍然记录**，只是不放进每轮注入；AGENTS.md 里已有规则（涉及文化/教育/项目话题先读对应文件），不是丢掉。

**为什么不全部塞进注入文件：**

1. **成本**：现在注入约 40 KB，已经不算小；75 条蒸馏结果全塞进去会到 60–80 KB，每轮都付。
2. **信噪比**：注入内容越杂，「你是不是懂我」反而越差——重要偏好的权重被孩子身高、挖矿收益这类细节冲淡。
3. **敏感度**：孩子健康、家庭、财务细节进注入后，会随每次请求/截图/导出扩散；放在不注入的详细版里风险小得多。

**为什么自动写只收高置信：**

自动写入会直接改变我以后每轮看到的「关于你」的判断；一次误读（例如把「如果我升到 256G」当事实、把 AI 说的当你说的）会持续污染很多轮对话。所以自动通道只放**你明确陈述**的；需要上下文推断的进待审，人工确认后再写。这不是数量上限，是质量闸门——**首次批量导入可放开条数限制**（`autoWriteLimitPerRun: "first-import-unlimited"`），日常增量才限 ≤3 条/次。

## 8. 首次运行向导（征求意见的关键）

安装后第一次 `import_run`（或用户主动）时，通过 `ask_user_question` 推送 4 个问题，答案写 `distill-config.json`：

| # | 问题 | 选项（默认） |
|---|---|---|
| 1 | 蒸馏范围？ | 只事实 / **事实+兴趣+观点（默认）** / 全部含一次性讨论 |
| 2 | 孩子健康、家庭细节、财务这类敏感内容怎么处理？ | **只进详细版不注入（默认）** / 只进待审 / 不入库 |
| 3 | 落库方式？ | **高置信自动写（每次≤3条，默认）** / 全部先待审 / 只出报告 |
| 4 | 什么时候跑？ | **每次导出后自动（默认）** / 手动触发 |

以后随时可改：`import_configure` 或直接编辑 `distill-config.json`（改前备份）。

## 9. 审计与回滚

- **每次导入**生成 `profile\import-runs\<时间戳>\`：`report.json`（条数、分类、跳过原因）、`candidates.json` 快照、`memories-before/`（涉及文件的备份）
- **git**：`profile\.git` 与 `.dsh\memory\.git` 各提交一次，commit message 带 run id；回滚 = `git revert <commit>`
- **报告给用户**：一句话摘要 + 写入条数 + 待审条数 + 报告路径；不贴大段内容
- **失败不污染**：析构失败/超时 → 不写记忆文件，只留审计与日志

## 10. 安全与隐私边界

- 只读**用户自己的**导出包；只写本机路径；**任何情况不联网上传**
- 浏览器 profile 独立（`%LOCALAPPDATA%` 下插件自己的目录），不复用日常浏览器
- 代理：**跟随用户环境**（环境变量 → 系统代理 → 直连），插件不写死端口
- 凭据：不存 API key；蒸馏用 DSH 当前会话模型，或用户配置的 provider（复用 DSH 凭据体系）
- 日志脱敏：邮箱打码、验证码不落盘、原话摘录上限 60 字
- 插件市场提交前跑隐私扫描（本机路径、邮箱、token 一律不许出现在仓库）

## 11. 测试计划

| 层 | 内容 |
|---|---|
| 单测（node:test） | 候选 schema 校验、分层路由（type+sensitivity→目标文件）、去重、待审、配置解析、路径守卫、审计报告生成 |
| 冒烟 | `smoke.mjs`：假导出包 → 扫描 → 假蒸馏 → 落库 → 断言文件变化与备份、undo 可用 |
| 真实 dry-run | 用 2026-11-09 导出包跑 `import_preview`，人工抽查 10 条质量 |
| 定时链路 | 11-15 周日窗口自动触发验证（无人干预） |
| 回归 | `memory-health.mjs`、`check-assertions.mjs`、两个插件各自 smoke |

## 12. 发布计划

1. 仓库 `dsh-chatgpt-to-memory`（GitHub，MIT），结构对齐现有插件：`index.js`、`cordis.patch.yml`、`package.json`、`README.md`（11 个固定 H2）、`README.en.md`（精简版并标注"精简版"）、`smoke.mjs`、`tools\publish.mjs`
2. `dsh-long-term-memory` 升版本（新增工具），同步 `smoke.mjs` 断言
3. 两仓各打 tag + release
4. 提交 awesome-dsh-plugin 收录（需要仓库满 24h）
5. `dsh-plugin.org` 有入口再提交

## 13. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 本地可用 | 拆包：导出/下载迁入 import 插件；候选文件产出；long-term-memory 新增消费工具；首次向导 | 用 11-09 导出包完整跑一遍，写入正确、有备份、有报告 |
| M2 自动化 | 定时任务串成一条链：导出→下载→蒸馏→合并；失败告警 | 11-15 窗口无人干预跑通 |
| M3 发布 | README/发布/收录 | 两插件可一键安装；市场可搜到 |
| M4 扩展 | DeepSeek 导出、DSH 会话、增量频率可配 | 按需 |

## 14. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| ChatGPT 导出需"最近登录"、Cloudflare 人机验证 | 自动化偶发失败 | 已实现邮箱验证码重新认证；失败保留 pending + 告警 |
| 浏览器自动化选择器变动 | 下载/导出失败 | 关键操作加多选择器兜底 + 失败截图 + 日志 |
| 蒸馏质量不稳（幻觉/漏） | 记忆被污染 | 分级置信度 + 高置信≤3条/次 + 待审 + 可 undo + git 回滚 |
| 敏感信息误入注入文件 | 隐私泄露风险 | `sensitivity` 字段 + 默认 `private` 只进详细版 |
| 插件依赖重（playwright-core） | 安装体积 | 声明为可选依赖，未装时 `import_*` 工具明确报错 |

## 15. 与现有脚本的映射（迁移表）

| 现有 | 迁移后 |
|---|---|
| `automation\chatgpt-export\export.mjs` | `dsh-chatgpt-to-memory\lib\export.mjs` |
| `relogin.mjs` / `lib\gmailweb.mjs` / `lib\browser.mjs` | `lib\auth.mjs` / `lib\gmail.mjs` / `lib\browser.mjs` |
| `weekly.mjs` + `lib\trigger.mjs` | `lib\pipeline.mjs`（+ 定时任务只调用插件工具） |
| `profile\inbox\candidates-*.json` | 协议不变 |
| `automation\lib\memory-merge.mjs` | 逻辑并入 `dsh-long-term-memory` 的 `memory_import_candidates`（保留脚本作为兼容入口） |

---

## 16. 已定 / 待定的点

**已定：**

1. 插件名：**`dsh-chatgpt-to-memory`**（backup + import 都体现；目录 `D:\dsh-plugins\dsh-chatgpt-to-memory`）
2. 节奏：先本地跑通（M1）再发布（M2→M3）

**待用户确认：**

1. 敏感内容（孩子健康/家庭/财务）默认只进详细版、不进注入文件 —— 同意吗？
2. 自动写只限高置信（首次导入不限条数、日常 ≤3/次）—— 同意吗？
3. 首次向导的 4 个默认值是否按第 8 节执行？
