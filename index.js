/**
 * dsh-chatgpt-to-memory — 把 ChatGPT 官方导出包蒸馏成「记忆候选」，交给 dsh-long-term-memory 落库。
 *
 * 设计约束（对外宣称，逐条可核对）：
 *   1. 不写记忆文件。本插件只写 <cwd>/profile/import-runs/（数据集、审计）与
 *      <cwd>/profile/distill-config.json（配置）；候选由 agent 蒸馏后写到
 *      <cwd>/profile/inbox/candidates-*.json，由 dsh-long-term-memory 的
 *      memory_import_candidates 消费。写入记忆的唯一通道在那个插件里。
 *   2. 只读写用户自己的数据：导出目录（默认 D:\ChatGPT-Backups）与工作区 profile/。
 *   3. 不联网（M1）：本插件自身不发任何网络请求；M2 的网络只发生在用户自己的 Chrome profile。
 *   4. 不执行命令（M1）：不 spawn 子进程。
 *   5. 去重三层中的前两层在这里实现：会话级（conversation id）+ 消息级（文本归一化精确匹配），
 *      事实级去重留给消费端。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'chatgpt-to-memory';
export const inject = ['tools'];

const DEFAULT_EXPORT_ROOT = 'D:\\ChatGPT-Backups';
const DEFAULT_CONFIG_FILE = 'distill-config.json';
const MAX_CONVERSATIONS_PER_SCAN = 500;
const ASSISTANT_CONTEXT_CHARS = 100;

/** 默认配置：用户可改，首次运行时由 agent 用向导征询后写入。 */
export function defaultConfig() {
  return {
    version: 1,
    scope: 'facts+interests+viewpoints', // facts-only | facts+interests+viewpoints | everything
    sensitivity: { private: 'detailed-only', restricted: 'pending' },
    writeMode: 'auto-high', // auto-high | all-pending | report-only
    autoWriteLimitPerRun: 'first-import-unlimited',
    distill: { provider: 'default', model: 'default', batchConvs: 35, timeoutMs: 600000 },
    schedule: { afterExport: true, windows: 'auto' },
    git: { enabled: true, commitPerImport: true },
    sources: { chatgptExport: true, deepseekExport: false, dshSessions: false },
  };
}

/** 所有路径都由工作区 cwd 推导，不接受外部绝对路径（防越界）。 */
export function resolvePaths(cwd, exportRoot) {
  const profile = join(resolve(cwd), 'profile');
  return {
    profile,
    inbox: join(profile, 'inbox'),
    runs: join(profile, 'import-runs'),
    configFile: join(profile, DEFAULT_CONFIG_FILE),
    rawCorpus: join(profile, 'raw', 'user-turns.jsonl'),
    exportRoot: exportRoot || DEFAULT_EXPORT_ROOT,
  };
}

export function loadConfig(paths) {
  const base = defaultConfig();
  try {
    const parsed = JSON.parse(readFileSync(paths.configFile, 'utf8'));
    return {
      ...base,
      ...parsed,
      sensitivity: { ...base.sensitivity, ...(parsed.sensitivity || {}) },
      distill: { ...base.distill, ...(parsed.distill || {}) },
      schedule: { ...base.schedule, ...(parsed.schedule || {}) },
      git: { ...base.git, ...(parsed.git || {}) },
      sources: { ...base.sources, ...(parsed.sources || {}) },
    };
  } catch {
    return base;
  }
}

export function saveConfig(paths, config) {
  mkdirSync(paths.profile, { recursive: true });
  let backup = '';
  if (existsSync(paths.configFile)) {
    backup = `${paths.configFile}.bak-${Date.now()}`;
    copyFileSync(paths.configFile, backup);
  }
  writeFileSync(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { file: paths.configFile, backup };
}

/** 最新导出解压目录：<exportRoot>/extracted/<YYYY-MM-DD>/ */
export function latestExportDir(exportRoot) {
  const base = join(exportRoot, 'extracted');
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => ({ name: e.name, dir: join(base, e.name), mtime: statSync(join(base, e.name)).mtimeMs }))
    .sort((a, b) => (a.name === b.name ? b.mtime - a.mtime : a.name < b.name ? 1 : -1));
  return dirs[0] || null;
}

/** 读导出目录里的 conversations 分片（兼容单文件 conversations.json）。 */
export function readConversations(extractDir) {
  const files = readdirSync(extractDir).filter((f) => /^conversations(-\d+)?\.json$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(extractDir, f), 'utf8'));
      out.push(...(Array.isArray(data) ? data : Object.values(data)));
    } catch {
      // 单个分片坏了不影响其它分片
    }
  }
  return out;
}

/** 会话里的用户原话（role=user）；assistant 只留很短的上下文，防止喧宾夺主。 */
export function userMessages(conv) {
  const mapping = conv.mapping || {};
  const msgs = [];
  for (const k of Object.keys(mapping)) {
    const m = mapping[k] && mapping[k].message;
    if (!m || !m.author) continue;
    const role = m.author.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const parts = (m.content && m.content.parts) || [];
    let text = parts
      .map((p) => (typeof p === 'string' ? p : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    if (role === 'assistant') text = text.slice(0, ASSISTANT_CONTEXT_CHARS);
    const time = Number(m.create_time);
    msgs.push({ role, at: Number.isFinite(time) ? new Date(time * 1000).toISOString() : null, text });
  }
  return msgs;
}

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

/** 读历史已处理语料（profile/raw/user-turns.jsonl）：返回已处理的会话 id 与文本。 */
export function loadProcessed(paths) {
  const convIds = new Set();
  const texts = new Set();
  try {
    const lines = readFileSync(paths.rawCorpus, 'utf8').trim().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o && o.src === 'chatgpt') {
        if (o.conv) convIds.add(o.conv);
        const n = normalize(o.text);
        if (n) texts.add(n);
      }
    }
  } catch {
    // 没有旧语料就当作全量都是新的
  }
  return { convIds, texts };
}

/**
 * 扫描最新导出：只保留新会话 / 新增消息，产出可蒸馏的数据集。
 * 不写记忆文件；数据集写到 profile/import-runs/<时间戳>/dataset.json。
 */
export function scan(cwd, opts = {}) {
  const paths = resolvePaths(cwd, opts.exportRoot);
  const latest = latestExportDir(paths.exportRoot);
  if (!latest) {
    return {
      ok: false,
      reason: 'no-export',
      paths,
      message: `没有找到导出目录：${join(paths.exportRoot, 'extracted')}`,
    };
  }
  const conversations = readConversations(latest.dir);
  const processed = loadProcessed(paths);

  const picked = [];
  let userTurns = 0;
  let alreadyProcessed = 0;
  const seenTexts = new Set();
  for (const conv of conversations.slice(0, MAX_CONVERSATIONS_PER_SCAN)) {
    const convId = conv.conversation_id || conv.id || '';
    const msgs = userMessages(conv);
    const userMsgs = msgs.filter((m) => m.role === 'user');
    userTurns += userMsgs.length;
    if (processed.convIds.has(convId)) {
      alreadyProcessed += userMsgs.length;
      continue; // M1 保守策略：旧会话整段跳过
    }
    const fresh = userMsgs.filter((m) => {
      const n = normalize(m.text);
      if (!n || seenTexts.has(n) || processed.texts.has(n)) return false;
      seenTexts.add(n);
      return true;
    });
    if (!fresh.length) {
      alreadyProcessed += userMsgs.length;
      continue;
    }
    picked.push({
      convId,
      title: conv.title || '(无标题)',
      updatedAt: conv.update_time || conv.create_time || null,
      messages: msgs,
    });
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const runDir = join(paths.runs, stamp);
  const datasetPath = join(runDir, 'dataset.json');
  const reportPath = join(runDir, 'report.json');
  const stats = {
    ok: true,
    exportDir: latest.dir,
    exportDate: latest.name,
    conversations: conversations.length,
    userTurns,
    alreadyProcessed,
    newConversations: picked.length,
    newTurns: picked.reduce((a, c) => a + c.messages.filter((m) => m.role === 'user').length, 0),
    datasetPath,
    reportPath,
    config: loadConfig(paths),
  };
  if (opts.write !== false) {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(datasetPath, `${JSON.stringify({ conversations: picked }, null, 1)}\n`, 'utf8');
    writeFileSync(
      reportPath,
      `${JSON.stringify(
        { ...stats, generatedAt: new Date().toISOString(), exportedBy: 'dsh-chatgpt-to-memory' },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
  return stats;
}

/** 列出 inbox 候选文件与最近一次扫描报告。 */
export function listArtifacts(paths) {
  const candidates = [];
  try {
    for (const f of readdirSync(paths.inbox)) {
      if (/^candidates-.*\.json$/.test(f)) candidates.push(join(paths.inbox, f));
    }
  } catch {
    // inbox 不存在就当没有
  }
  let lastRun = null;
  try {
    const runs = readdirSync(paths.runs).filter((d) => /^\d{14}$/.test(d)).sort();
    if (runs.length) {
      const dir = join(paths.runs, runs[runs.length - 1]);
      const report = join(dir, 'report.json');
      if (existsSync(report)) lastRun = { dir, report, data: JSON.parse(readFileSync(report, 'utf8')) };
    }
  } catch {
    // 没有 runs 目录就当没有
  }
  return { candidates, lastRun };
}

const textOut = (t) => [{ type: 'text', text: t }];

export function apply(ctx, config = {}) {
  if (!ctx.tools) throw new Error('chatgpt-to-memory: ctx.tools 不可用，工具未注册。');
  const exportRoot = config.exportRoot || DEFAULT_EXPORT_ROOT;
  const pathsFor = (agent) => resolvePaths(agent?.session?.header?.cwd || config.cwd, exportRoot);

  ctx.tools.register(
    defineTool({
      name: 'import_status',
      description:
        '查看 ChatGPT→记忆 导入链路状态：导出目录、最新导出包、候选文件、上次扫描报告、配置。只读。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: (_a, v) =>
          textOut(
            `导出根目录：${v.exportRoot}\n` +
              `最新导出：${v.latestExport ? `${v.latestExport.date}（${v.latestExport.dir}）` : '(没有)'}\n` +
              `配置：${v.configFile}${v.configExists ? '' : '（未生成，默认值生效）'}\n` +
              `候选文件：${v.artifacts.candidates.length} 个` +
              (v.artifacts.lastRun
                ? `\n上次扫描：${v.artifacts.lastRun.data.exportDate} · 新会话 ${v.artifacts.lastRun.data.newConversations} / 新原话 ${v.artifacts.lastRun.data.newTurns}`
                : '') +
              '\n写入记忆：由 dsh-long-term-memory 的 memory_import_candidates 负责（本插件不写记忆）',
          ),
      },
      async execute(_args, exec) {
        const paths = pathsFor(exec?.agent);
        const latest = latestExportDir(paths.exportRoot);
        return {
          exportRoot: paths.exportRoot,
          latestExport: latest ? { date: latest.name, dir: latest.dir } : null,
          configFile: paths.configFile,
          configExists: existsSync(paths.configFile),
          config: loadConfig(paths),
          artifacts: listArtifacts(paths),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'import_configure',
      description:
        '读取/修改蒸馏取向配置（distill-config.json）。action=get 读取；action=set 用 patch 合并写入（写前自动备份）。首次运行向导也用它落盘。',
      parameters: {
        action: { type: 'string', required: true, description: "'get' | 'set'" },
        patch: {
          type: 'object',
          additionalProperties: true,
          description: '仅 set：要合并进配置的字段（sensitivity/distill/schedule/git/sources 深合并）',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: (_a, v) =>
          textOut(
            `${v.action === 'get' ? '当前配置' : '已写入'}：${v.file}\n${JSON.stringify(v.config, null, 2)}` +
              (v.backup ? `\n备份：${v.backup}` : ''),
          ),
      },
      async execute(args, exec) {
        const paths = pathsFor(exec?.agent);
        const action = String(args.action || 'get').toLowerCase();
        if (action === 'get') return { action, file: paths.configFile, config: loadConfig(paths) };
        if (action !== 'set') throw new Error(`未知 action：${args.action}（get | set）`);
        const merged = { ...loadConfig(paths), ...(args.patch || {}) };
        const saved = saveConfig(paths, merged);
        return { action, file: saved.file, backup: saved.backup, config: merged };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'import_scan',
      description:
        '扫描最新 ChatGPT 导出包：按会话 id + 消息文本去重，统计新增会话/原话，并把待蒸馏数据集写到 profile/import-runs/<时间戳>/dataset.json（不写记忆文件）。',
      parameters: {
        exportRoot: { type: 'string', description: '可选：覆盖导出根目录（默认 D:\\ChatGPT-Backups）' },
        write: { type: 'boolean', description: '是否写数据集文件，默认 true' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: (_a, v) =>
          textOut(
            v.ok
              ? `导出包：${v.exportDate}（${v.exportDir}）\n会话 ${v.conversations} 个 · 用户原话 ${v.userTurns} 条\n` +
                  `已处理（跳过）：${v.alreadyProcessed} 条\n**新增会话 ${v.newConversations} 个 · 新增原话 ${v.newTurns} 条**\n` +
                  `数据集：${v.datasetPath}\n报告：${v.reportPath}\n` +
                  '下一步：按蒸馏规则产出候选 JSON（profile/inbox/candidates-<日期>.json），再交给 dsh-long-term-memory 的 memory_import_candidates。'
              : `扫描失败：${v.message}`,
          ),
      },
      async execute(args, exec) {
        const cwd = exec?.agent?.session?.header?.cwd;
        return scan(cwd, { exportRoot: args.exportRoot || exportRoot, write: args.write !== false });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'import_preview',
      description:
        'dry-run 预览：扫描最新导出并返回待蒸馏数据集与蒸馏要求，不产生候选、不写记忆。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: (_a, v) =>
          textOut(
            v.ok
              ? `预览（不写记忆）：\n导出 ${v.exportDate} · 新增会话 ${v.newConversations} / 新增原话 ${v.newTurns}\n数据集：${v.datasetPath}\n\n` +
                  '蒸馏要求：\n· 只把 role=user 当事实来源，assistant 仅作上下文；\n· 禁止职业推断、禁止从问句反推持有、AI 内容不作为事实；\n· 输出 fact / interest / viewpoint 三类，带 confidence 与引句；\n· 高置信（用户明确陈述）方可自动写入，其余转待审。'
              : `预览失败：${v.message}`,
          ),
      },
      async execute(_args, exec) {
        const cwd = exec?.agent?.session?.header?.cwd;
        return scan(cwd, { exportRoot, write: true });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'import_run',
      description:
        'M1 占位：完整链路（触发导出→等邮件→下载→解压→扫描→蒸馏→候选）尚未接入本插件；现在请用 automation\\chatgpt-export 脚本 + import_scan。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: (_a, v) => textOut(v.message),
      },
      async execute() {
        return {
          ok: false,
          stage: 'not-implemented',
          message:
            'M1：本插件目前只做「扫描 + 去重 + 数据集」。导出/下载/重新认证仍是 automation\\chatgpt-export\\weekly.mjs（已跑通），M2 迁入。\n' +
            '现在可执行：node "D:\\deepseek workspace\\automation\\chatgpt-export\\weekly.mjs"，然后回来 import_scan。',
        };
      },
    }),
  );
}
