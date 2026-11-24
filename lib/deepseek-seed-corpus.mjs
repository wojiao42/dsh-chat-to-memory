// 一次性：把「历史已导入」的用户原话哈希灌进语料（之后完全靠哈希判重）。
// 规则：updated_at ≤ --until 的历史批次 + 已在 processed-deepseek.json 里的会话。
import fs from 'node:fs';
import path from 'node:path';
import { parseDeepseekDir } from './deepseek-import.mjs';
import { hashText, saveCorpus } from './turn-corpus.mjs';

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const EXTRACT = argOf('--extract', 'D:\\ChatGPT-Backups\\deepseek-extracted\\2026-11-24');
const WORKDIR = argOf('--workdir', 'D:\\deepseek workspace');
const UNTIL = argOf('--until', '2026-09-30T23:59:59Z');
const runsDir = path.join(WORKDIR, 'profile', 'import-runs');
const corpusFile = path.join(runsDir, 'deepseek-imported-turns.jsonl');
const cursorFile = path.join(runsDir, 'processed-deepseek.json');

const parsed = parseDeepseekDir(EXTRACT);
let known = new Set();
try {
  known = new Set(JSON.parse(fs.readFileSync(cursorFile, 'utf8')));
} catch {}
const untilTs = Date.parse(UNTIL);
const hashes = new Set();
let convs = 0;
let turns = 0;
for (const c of parsed.conversations) {
  const isOld = (c.updatedAt || 0) <= untilTs;
  if (!isOld && !known.has(c.convId)) continue;
  convs++;
  for (const m of c.messages) {
    if (m.role !== 'user') continue;
    hashes.add(hashText(m.text));
    turns++;
  }
}
// 与已有语料合并（保留旧的）
const prev = new Set();
try {
  for (const line of fs.readFileSync(corpusFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j?.h) prev.add(j.h);
    } catch {}
  }
} catch {}
const all = new Set([...prev, ...hashes]);
const merged = new Set();
for (const h of all) merged.add(h);
saveCorpus(corpusFile, merged, { at: new Date().toISOString() });
console.log(
  JSON.stringify(
    {
      corpusFile,
      conversationsSeeded: convs,
      turnsSeeded: turns,
      totalUniqueHashes: merged.size,
      until: UNTIL,
      knownCursorCount: known.size,
    },
    null,
    2,
  ),
);
