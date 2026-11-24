// 从已解压的 DeepSeek 导出构建数据集（不联网、不下载）。
// 用法：node deepseek-build-dataset.mjs --extract <dir> --workdir "D:\deepseek workspace" [--since 2026-10-01]
import fs from 'node:fs';
import path from 'node:path';
import { parseDeepseekDir } from './deepseek-import.mjs';

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const EXTRACT = argOf('--extract');
const WORKDIR = argOf('--workdir', 'D:\\deepseek workspace');
const SINCE = argOf('--since', '');
const out = { ok: false, stage: 'start' };
if (!EXTRACT || !fs.existsSync(EXTRACT)) {
  out.stage = 'extract-missing';
  out.error = `找不到解压目录：${EXTRACT}`;
  console.log(JSON.stringify(out, null, 2));
  process.exit(1);
}

const parsed = parseDeepseekDir(EXTRACT);
const sinceTs = SINCE ? Date.parse(SINCE) : null;
const runsDir = path.join(WORKDIR, 'profile', 'import-runs');
fs.mkdirSync(runsDir, { recursive: true });
const cursorFile = path.join(runsDir, 'processed-deepseek.json');
let processed = new Set();
try {
  processed = new Set(JSON.parse(fs.readFileSync(cursorFile, 'utf8')));
} catch {}

const candidates = parsed.conversations.filter((c) => {
  if (processed.has(c.convId)) return false;
  if (sinceTs && !(c.updatedAt > sinceTs)) return false;
  return true;
});
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-deepseek';
const runDir = path.join(runsDir, stamp);
fs.mkdirSync(runDir, { recursive: true });
const datasetPath = path.join(runDir, 'dataset.json');
fs.writeFileSync(datasetPath, `${JSON.stringify({ conversations: candidates }, null, 1)}\n`, 'utf8');
const userTurns = candidates.reduce((a, c) => a + c.messages.filter((m) => m.role === 'user').length, 0);
const report = {
  ok: true,
  stage: 'done',
  sessions: parsed.sessions,
  conversationsTotal: parsed.conversations.length,
  skippedProcessed: parsed.conversations.length - candidates.length - (parsed.conversations.length - candidates.length), // placeholder
  since: SINCE || null,
  datasetPath,
  conversations: candidates.length,
  userTurns,
  cursorCount: processed.size,
};
// 记录游标（下次不重复）
if (candidates.length) {
  const next = new Set([...processed, ...candidates.map((c) => c.convId)]);
  fs.writeFileSync(cursorFile, JSON.stringify([...next], null, 1), 'utf8');
}
console.log(JSON.stringify(report, null, 2));
