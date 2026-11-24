// 回溯：查看某来源 / 某会话在每次导入里新增了哪些原话。
// 用法：
//   node lib/trace-ledger.mjs --source deepseek [--conv <convId>] [--limit 50] [--runs]
import fs from 'node:fs';
import path from 'node:path';
import { loadLedger, runsDir } from './ledger.mjs';

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const WORKDIR = argOf('--workdir', 'D:\\deepseek workspace');
const SOURCE = argOf('--source', 'deepseek');
const CONV = argOf('--conv', '');
const LIMIT = Number(argOf('--limit', '50'));
const SHOW_RUNS = args.includes('--runs');

if (SHOW_RUNS) {
  const dir = runsDir(WORKDIR, SOURCE);
  const runs = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        runs.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      } catch {}
    }
  } catch {}
  runs.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  console.log(JSON.stringify({ source: SOURCE, runs }, null, 2));
  process.exit(0);
}

const { byHash, byConv } = loadLedger(WORKDIR, SOURCE);
const items = [];
for (const [cid, arr] of byConv) {
  if (CONV && cid !== CONV) continue;
  for (const e of arr) items.push(e);
}
items.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
const sliced = items.slice(-LIMIT);
console.log(
  JSON.stringify(
    {
      source: SOURCE,
      ledgerTotal: byHash.size,
      conversations: byConv.size,
      filtered: CONV || null,
      shown: sliced.length,
      items: sliced.map((e) => ({
        convId: e.convId,
        title: e.title,
        at: e.at,
        text: e.text.length > 80 ? `${e.text.slice(0, 80)}…` : e.text,
        runId: e.runId,
        importedAt: e.importedAt,
      })),
    },
    null,
    2,
  ),
);
