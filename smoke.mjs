/**
 * dsh-chatgpt-to-memory 冒烟测试。
 * 不联网、不读真实导出：全部用临时目录里的假导出包与假语料。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
let failed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, message: e.message });
    console.log(`✗ ${name}\n   ${e.message}`);
  }
}

// ── A) 静态检查：无网络调用；只允许在 lib/export-run.mjs 里 spawn 自带脚本 ──
const SRC = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const LIB_FILES = ['export-run', 'distill', 'merge'].map((n) => ({
  name: `lib/${n}.mjs`,
  text: readFileSync(new URL(`./lib/${n}.mjs`, import.meta.url), 'utf8'),
}));
await check('源码里没有 fetch / XMLHttpRequest（不联网）', () => {
  const all = [{ name: 'index.js', text: SRC }, ...LIB_FILES];
  for (const f of all) {
    assert.ok(!/\bfetch\s*\(/.test(f.text), `${f.name} 出现 fetch(`);
    assert.ok(!/XMLHttpRequest/.test(f.text), `${f.name} 出现 XMLHttpRequest`);
  }
});
await check('child_process 只用于跑自带脚本（不跑 shell/外部命令）', () => {
  const allowed = ['index.js', 'lib/export-run.mjs'];
  const users = [{ name: 'index.js', text: SRC }, ...LIB_FILES].filter((f) => /child_process/.test(f.text)).map((f) => f.name);
  for (const u of users) assert.ok(allowed.includes(u), `${u} 不应使用 child_process`);
  assert.ok(!/spawnSync\([^)]*\b(?:cmd|powershell|pwsh)\b/i.test(SRC), 'index.js 出现 shell 调用');
});
await check('源码里没有删除/改名/改权限操作（只读数据）', () => {
  const all = [{ name: 'index.js', text: SRC }, ...LIB_FILES];
  for (const f of all) assert.ok(!/\b(rmSync|unlinkSync|renameSync|chmodSync)\s*\(/.test(f.text), `${f.name} 出现破坏性文件操作`);
});

const mod = await import('./index.js');

await check('导出 name / inject', () => {
  assert.equal(mod.name, 'chat-to-memory');
  assert.deepEqual(mod.inject, ['tools', 'llm']);
});

await check('默认配置包含 scope / sensitivity / writeMode / distill', () => {
  const c = mod.defaultConfig();
  assert.equal(c.version, 1);
  assert.equal(c.scope, 'facts+interests+viewpoints');
  assert.equal(c.sensitivity.private, 'detailed-only');
  assert.equal(c.writeMode, 'auto-high');
  assert.equal(c.distill.batchConvs, 35);
});

// ── B) 夹具 ──
const tmp = mkdtempSync(join(tmpdir(), 'c2m-smoke-'));
const cwd = join(tmp, 'workspace');
const exportRoot = join(tmp, 'backups');
const extract = join(exportRoot, 'extracted', '2026-11-09');
mkdirSync(join(cwd, 'profile', 'raw'), { recursive: true });
mkdirSync(extract, { recursive: true });

writeFileSync(
  join(cwd, 'profile', 'raw', 'user-turns.jsonl'),
  [
    JSON.stringify({ src: 'chatgpt', conv: 'conv-old', text: '老的已处理消息' }),
    JSON.stringify({ src: 'deepseek', conv: 'conv-ds', text: '别的来源不动' }),
  ].join('\n') + '\n',
  'utf8',
);

// 分来源账本：旧会话的那条原话已导入（扫描时应被原话级去重跳过）
mkdirSync(join(cwd, 'profile', 'imports', 'chatgpt'), { recursive: true });
writeFileSync(
  join(cwd, 'profile', 'imports', 'chatgpt', 'ledger.jsonl'),
  `${JSON.stringify({ src: 'chatgpt', convId: 'conv-old', title: '旧会话', at: '2026-01-01T00:00:00Z', h: (await import('./lib/ledger.mjs')).hashText('老的已处理消息'), text: '老的已处理消息', runId: 'seed', importedAt: '2026-01-02T00:00:00Z' })}\n`,
  'utf8',
);

const mapping = (texts) => {
  const m = {};
  for (const [i, t] of texts.entries()) {
    m[`n${i}`] = { message: { author: { role: 'user' }, content: { parts: [t] }, create_time: 1794000000 + i } };
  }
  return m;
};
writeFileSync(
  join(extract, 'conversations-000.json'),
  JSON.stringify([
    { conversation_id: 'conv-old', title: '旧会话', mapping: mapping(['老的已处理消息']) },
    { conversation_id: 'conv-new', title: '新会话', mapping: mapping(['我新买了一个东西', '这个怎么样']) },
  ]),
  'utf8',
);

// ── C) 行为测试：假 ctx ──
const registered = [];
const fakeCtx = { tools: { register: (t) => registered.push(t) } };
const exec = { agent: { session: { header: { cwd } } } };

await check('apply() 注册 7 个工具', () => {
  mod.apply(fakeCtx, { exportRoot });
  assert.deepEqual(registered.map((t) => t.name), [
    'import_status',
    'import_configure',
    'import_scan',
    'import_preview',
    'import_distill',
    'import_deepseek',
    'import_run',
  ]);
});

await check('ctx.tools 不可用时抛错', () => {
  assert.throws(() => mod.apply({}, { exportRoot }), /ctx\.tools 不可用/);
});

const tool = (n) => registered.find((t) => t.name === n);

await check('import_configure get 返回默认值', async () => {
  const r = await tool('import_configure').execute({ action: 'get' }, exec);
  assert.equal(r.config.scope, 'facts+interests+viewpoints');
  assert.ok(r.file.endsWith('distill-config.json'));
});

await check('import_configure set 写入并备份旧配置', async () => {
  await tool('import_configure').execute({ action: 'set', patch: { scope: 'facts-only' } }, exec);
  const r2 = await tool('import_configure').execute({ action: 'set', patch: { writeMode: 'report-only' } }, exec);
  assert.ok(r2.backup && existsSync(r2.backup), '第二次写入前应备份');
  const r3 = await tool('import_configure').execute({ action: 'get' }, exec);
  assert.equal(r3.config.scope, 'facts-only');
  assert.equal(r3.config.writeMode, 'report-only');
});

await check('import_status 列出导出包与配置', async () => {
  const r = await tool('import_status').execute({}, exec);
  assert.equal(r.exportRoot, exportRoot);
  assert.equal(r.latestExport.date, '2026-11-09');
  assert.equal(r.configExists, true);
});

await check('import_scan 去重：旧会话跳过，只留新会话', async () => {
  const r = await tool('import_scan').execute({}, exec);
  assert.equal(r.ok, true);
  assert.equal(r.conversations, 2);
  assert.equal(r.userTurns, 3);
  assert.equal(r.alreadyProcessed, 1);
  assert.equal(r.newConversations, 1);
  assert.equal(r.newTurns, 2);
  assert.ok(existsSync(r.datasetPath), '数据集未写');
  assert.ok(existsSync(r.reportPath), '报告未写');
  const ds = JSON.parse(readFileSync(r.datasetPath, 'utf8'));
  assert.deepEqual(ds.conversations.map((c) => c.convId), ['conv-new']);
});

await check('import_scan write:false 不写文件', async () => {
  const before = existsSync(join(cwd, 'profile', 'import-runs'));
  const r = await tool('import_scan').execute({ write: false }, exec);
  assert.equal(r.ok, true);
  assert.equal(before, true);
});

await check('import_preview 返回预览与蒸馏要求', async () => {
  const r = await tool('import_preview').execute({}, exec);
  assert.equal(r.ok, true);
  const render = tool('import_preview').output.render({}, r).map((b) => b.text).join('\n');
  assert.ok(render.includes('禁止职业推断'), '预览里缺蒸馏硬规则');
});

// ── v0.2.0：完整链路组件（蒸馏 / 合并 / 导出输出解析）──
await check('extractJson 能处理裸 JSON 与 ```json 包裹', async () => {
  const { extractJson } = await import('./lib/distill.mjs');
  assert.deepEqual(extractJson('{"items":[]}'), { items: [] });
  assert.deepEqual(extractJson('```json\n{"items":[1]}\n```'), { items: [1] });
  assert.equal(extractJson('no json here'), null);
});

await check('distillDataset 用 ctx.llm 产出候选文件', async () => {
  const { distillDataset } = await import('./lib/distill.mjs');
  const fakeCtx = {
    llm: {
      listModels: async () => [{ id: 'fake-model' }],
      stream: async function* () {
        const payload = {
          version: 1,
          source: 'chatgpt-export',
          exportDate: '2026-11-16',
          items: [
            { type: 'fact', category: '硬件', text: '测试蒸馏事实', confidence: 'high', sensitivity: 'normal', date: '2026-11-16', title: '新会话', convId: 'conv-new', quotes: ['我新买了一个东西'] },
          ],
        };
        yield { type: 'text-delta', text: JSON.stringify(payload) };
        yield { type: 'finish', kind: 'completed' };
      },
    },
  };
  const dsPath = join(cwd, 'profile', 'import-runs', 'test-distill', 'dataset.json');
  mkdirSync(join(cwd, 'profile', 'import-runs', 'test-distill'), { recursive: true });
  writeFileSync(
    dsPath,
    JSON.stringify({
      conversations: [
        { convId: 'conv-new', title: '新会话', updatedAt: 1794000000000, messages: [{ role: 'user', at: null, text: '我新买了一个东西' }] },
      ],
    }),
    'utf8',
  );
  const r = await distillDataset(fakeCtx, dsPath, { workdir: cwd, provider: 'fake', batchConvs: 10 });
  assert.equal(r.itemCount, 1);
  assert.ok(existsSync(r.file), '候选文件未写');
  const cand = JSON.parse(readFileSync(r.file, 'utf8'));
  assert.equal(cand.items[0].text, '测试蒸馏事实');
});

await check('mergeCandidates：记忆插件不在时返回 memory-plugin-missing（不抛）', async () => {
  const { mergeCandidates } = await import('./lib/merge.mjs');
  const old = process.env.DSH_PROFILE_DIR;
  process.env.DSH_PROFILE_DIR = join(cwd, 'profile', 'not-installed');
  try {
    const r = await mergeCandidates(cwd, join(cwd, 'profile', 'inbox', 'candidates-2099-01-01-plugin.json'));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'memory-plugin-missing');
  } finally {
    if (old === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = old;
  }
});

await check('parseLastJson 能从 weekly 输出里取最后一个 JSON', async () => {
  const { parseLastJson } = await import('./lib/export-run.mjs');
  const out = '[weekly] 查 Gmail…\n{"stage":"skip","ok":true}\n';
  assert.deepEqual(parseLastJson(out), { stage: 'skip', ok: true });
});

await check('import_run 在非 done 阶段不蒸馏（render 走窗口分支）', async () => {
  const r = { ok: true, stage: 'waiting-mail', actions: ['还没有就绪邮件'] };
  const render = tool('import_run').output.render({}, r).map((b) => b.text).join('\n');
  assert.ok(render.includes('本次窗口不导入'), '未走非 done 分支');
});

await check('parseDeepseekDir 能把 DeepSeek 导出转成统一数据集', async () => {
  const { parseDeepseekDir } = await import('./lib/deepseek-import.mjs');
  const dir = join(cwd, 'profile', 'ds-fixture');
  mkdirSync(join(dir, 'chat_sessions'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ export_format_version: 3 }), 'utf8');
  writeFileSync(join(dir, 'chat_session_index.json'), JSON.stringify([{ id: 'c1', title: '测试会话', updated_at: '2026-11-20T00:00:00Z' }]), 'utf8');
  writeFileSync(
    join(dir, 'chat_sessions', 'c1.json'),
    JSON.stringify({
      id: 'c1',
      title: '测试会话',
      inserted_at: '2026-11-19T00:00:00Z',
      updated_at: '2026-11-20T00:00:00Z',
      messages: [
        { role: 'USER', inserted_at: '2026-11-19T00:00:00Z', fragments: [{ type: 'REQUEST', content: '我有一条 DeepSeek 测试发言' }] },
        { role: 'ASSISTANT', inserted_at: '2026-11-19T00:00:01Z', fragments: [{ type: 'RESPONSE', content: '回答内容' }] },
      ],
    }),
    'utf8',
  );
  const r = parseDeepseekDir(dir);
  assert.equal(r.formatVersion, 3);
  assert.equal(r.conversations.length, 1);
  assert.equal(r.conversations[0].convId, 'c1');
  assert.equal(r.conversations[0].messages[0].text, '我有一条 DeepSeek 测试发言');
  assert.equal(r.userTurns, 1);
});

await check('turn-corpus 按原话哈希判重（旧会话新增的原话也能导入）', async () => {
  const { filterByCorpus, hashText } = await import('./lib/turn-corpus.mjs');
  const corpus = new Set([hashText('已经导入过的一句话')]);
  const convs = [
    { convId: 'old', title: '旧会话', messages: [
      { role: 'user', text: '已经导入过的一句话' },
      { role: 'assistant', text: '回复' },
      { role: 'user', text: '这是后来新增的一句' },
      { role: 'assistant', text: '回复2' },
    ] },
    { convId: 'dup', title: '全重复', messages: [{ role: 'user', text: '已经导入过的一句话' }] },
  ];
  const r = filterByCorpus(convs, corpus);
  assert.equal(r.conversations.length, 1, '应只保留含新原话的会话');
  assert.equal(r.conversations[0].convId, 'old');
  const texts = r.conversations[0].messages.map((m) => m.text);
  assert.ok(texts.includes('这是后来新增的一句'), '新原话应保留');
  assert.ok(!texts.includes('已经导入过的一句话'), '旧原话应被过滤');
  assert.equal(r.skippedConversations, 1);
  assert.equal(r.newTurns, 1);
});

await check('ledger：分来源账本可增量、可回溯（老会话新增原话只导新的）', async () => {
  const { filterByLedger, recordRun, loadLedger, traceLedger } = await import('./lib/ledger.mjs');
  const cwd2 = join(cwd, 'profile', 'ledger-test');
  const convs = [
    { convId: 'c-old', title: '老会话', messages: [
      { role: 'user', at: '2026-01-01T00:00:00Z', text: '第一句话' },
      { role: 'assistant', at: '2026-01-01T00:00:01Z', text: '回复一' },
    ] },
  ];
  const r1 = filterByLedger(convs, loadLedger(cwd2, 'chatgpt'));
  assert.equal(r1.newTurns, 1, '首次应有 1 条新原话');
  recordRun(cwd2, 'chatgpt', { runId: 'run-1', datasetPath: join(cwd2, 'profile', 'import-runs', 'run-1', 'dataset.json'), conversations: r1.conversations });
  assert.equal(loadLedger(cwd2, 'chatgpt').size, 1);

  // 同一会话后来又有一句新原话
  convs[0].messages.push(
    { role: 'user', at: '2026-11-20T00:00:00Z', text: '后来新增的一句话' },
    { role: 'assistant', at: '2026-11-20T00:00:01Z', text: '回复二' },
  );
  const r2 = filterByLedger(convs, loadLedger(cwd2, 'chatgpt'));
  assert.equal(r2.newTurns, 1, '只应识别到新增的那一句');
  assert.equal(r2.conversations.length, 1, '老会话应因新原话被保留');
  const texts = r2.conversations[0].messages.map((m) => m.text);
  assert.deepEqual(texts, ['后来新增的一句话', '回复二'], '应只含新原话+其后的助手回复');

  recordRun(cwd2, 'chatgpt', { runId: 'run-2', datasetPath: 'x', conversations: r2.conversations });
  assert.equal(loadLedger(cwd2, 'chatgpt').size, 2);
  const t = traceLedger(cwd2, 'chatgpt', { convId: 'c-old' });
  assert.equal(t.total, 2, '回溯应有 2 条');
  assert.equal(t.items[1].runId, 'run-2');
  // 再扫一遍应无新增（幂等）
  const r3 = filterByLedger(convs, loadLedger(cwd2, 'chatgpt'));
  assert.equal(r3.newTurns, 0);
});

// ── D) 每个工具都有 render / schema 可校验 ──
await check('每个工具都有 output.render 与 schema', () => {
  for (const t of registered) {
    assert.equal(typeof t.output.render, 'function', `${t.name} 缺 render`);
    assert.equal(t.output.schema.type, 'object', `${t.name} schema 不是 object`);
  }
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) {
  for (const f of failures) console.log(`- ${f.name}: ${f.message}`);
  process.exit(1);
}
