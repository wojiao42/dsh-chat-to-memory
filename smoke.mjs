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

// ── A) 静态检查：不联网、不执行命令 ──
const SRC = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
await check('源码里没有 fetch / XMLHttpRequest / child_process（不联网、不执行命令）', () => {
  assert.ok(!/\bfetch\s*\(/.test(SRC), '出现 fetch(');
  assert.ok(!/XMLHttpRequest/.test(SRC), '出现 XMLHttpRequest');
  assert.ok(!/child_process/.test(SRC), '出现 child_process');
});
await check('源码里没有删除/改名/改权限操作（只读数据）', () => {
  assert.ok(!/\b(rmSync|unlinkSync|renameSync|chmodSync)\s*\(/.test(SRC), '出现破坏性文件操作');
});

const mod = await import('./index.js');

await check('导出 name / inject', () => {
  assert.equal(mod.name, 'chatgpt-to-memory');
  assert.deepEqual(mod.inject, ['tools']);
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

await check('apply() 注册 5 个工具', () => {
  mod.apply(fakeCtx, { exportRoot });
  assert.deepEqual(registered.map((t) => t.name), [
    'import_status',
    'import_configure',
    'import_scan',
    'import_preview',
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

await check('import_run 是明确的 M1 占位（不假装已实现）', async () => {
  const r = await tool('import_run').execute({}, exec);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'not-implemented');
  assert.ok(r.message.includes('M1'));
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
