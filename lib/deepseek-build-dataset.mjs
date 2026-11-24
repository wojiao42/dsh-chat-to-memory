// 从已解压的 DeepSeek 导出构建数据集（不联网、不下载）。
// 用法：node deepseek-build-dataset.mjs --extract <dir> --workdir "D:\deepseek workspace" [--since 2026-10-01]
import fs from 'node:fs';
import path from 'node:path';
import { parseDeepseekDir } from './deepseek-import.mjs';
import { filterByLedger, loadLedger } from './ledger.mjs';

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
const ledger = loadLedger(WORKDIR, 'deepseek');
// 可选 --since 仅用于「只看某时间后的会话」（默认不启用，判重完全靠原话哈希）
const scope = sinceTs ? parsed.conversations.filter((c) => (c.updatedAt || 0) > sinceTs) : parsed.conversations;
const filtered = filterByLedger(scope, ledger);
const candidates = filtered.conversations;
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-deepseek';
const runDir = path.join(runsDir, stamp);
fs.mkdirSync(runDir, { recursive: true });
const datasetPath = path.join(runDir, 'dataset.json');
fs.writeFileSync(datasetPath, `${JSON.stringify({ conversations: candidates }, null, 1)}\n`, 'utf8');
const userTurns = candidates.reduce((a, c) => a + c.messages.filter((m) => m.role === 'user').length, 0);
const newHashes = { size: filtered.newTurns };
const report = {
  ok: true,
  stage: 'done',
  sessions: parsed.sessions,
  conversationsTotal: parsed.conversations.length,
  skippedConversations: filtered.skippedConversations,
  newHashes: newHashes.size,
  ledgerFile: path.join(WORKDIR, 'profile', 'imports', 'deepseek', 'ledger.jsonl'),
  since: SINCE || null,
  datasetPath,
  conversations: candidates.length,
  userTurns,
};
// 注意：语料不在这里写；等蒸馏+合并成功后由插件调用 markDatasetImported() 追加
console.log(JSON.stringify(report, null, 2));
