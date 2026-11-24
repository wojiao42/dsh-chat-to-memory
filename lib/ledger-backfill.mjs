// 一次性回灌账本：把「历史确实导入过」的用户原话写进分来源 ledger。
// 证据优先序（全部是文本级，不用日期猜）：
//   ChatGPT: profile\raw\user-turns.jsonl（conv/title/t/text） + profile\corpus-chatgpt.jsonl + import-runs 数据集
//   DeepSeek: profile\corpus-deepseek.jsonl（文本）→ 与当前导出按哈希对齐，补 convId/title/at；+ processed-deepseek 会话 + import-runs 数据集
import fs from 'node:fs';
import path from 'node:path';
import { parseDeepseekDir } from './deepseek-import.mjs';
import { hashText, appendLedger, loadLedger } from './ledger.mjs';

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const WORKDIR = argOf('--workdir', 'D:\\deepseek workspace');
const CHATGPT_EXTRACT = argOf('--chatgpt-extract', '');
const DEEPSEEK_EXTRACT = argOf('--deepseek-extract', '');
const out = { ok: false, chatgpt: {}, deepseek: {} };

const readJsonl = (file) => {
  const rows = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {}
    }
  } catch {}
  return rows;
};
const asText = (s) => String(s || '');

// ── ChatGPT 账本 ──
function backfillChatgpt() {
  const entries = [];
  const seen = new Set();
  const push = (convId, title, at, text) => {
    const h = hashText(text);
    if (seen.has(h)) return;
    seen.add(h);
    entries.push({ convId: convId || '', title: title || '', at: at || null, h, text: asText(text) });
  };

  const raw = readJsonl(path.join(WORKDIR, 'profile', 'raw', 'user-turns.jsonl'));
  for (const r of raw) {
    if (r && r.role === 'user' && r.text) push(r.conv, r.title, r.t ? new Date(r.t).toISOString() : null, r.text);
  }
  out.chatgpt.fromRawTurns = entries.length;

  const corpus = readJsonl(path.join(WORKDIR, 'profile', 'corpus-chatgpt.jsonl'));
  const corpusHashes = new Set(corpus.filter((r) => r && r.text).map((r) => hashText(r.text)));
  out.chatgpt.corpusTexts = corpusHashes.size;

  // import-runs 里的历史数据集（插件自己导入过的）
  const runsDir = path.join(WORKDIR, 'profile', 'import-runs');
  let runTurns = 0;
  try {
    for (const d of fs.readdirSync(runsDir)) {
      const dsPath = path.join(runsDir, d, 'dataset.json');
      if (!fs.existsSync(dsPath)) continue;
      let ds;
      try {
        ds = JSON.parse(fs.readFileSync(dsPath, 'utf8'));
      } catch {
        continue;
      }
      for (const c of ds.conversations || []) {
        for (const m of c.messages || []) {
          if (m.role !== 'user') continue;
          push(c.convId, c.title, m.at || null, m.text);
          runTurns++;
        }
      }
    }
  } catch {}
  out.chatgpt.fromRunDatasets = runTurns;

  // 当前 ChatGPT 导出里、能被 corpus 命中的文本 → 补 convId/title/at
  if (CHATGPT_EXTRACT && fs.existsSync(CHATGPT_EXTRACT)) {
    const { readConversations } = {}; // 简化：直接读 conversations-*.json
    const files = fs
      .readdirSync(CHATGPT_EXTRACT)
      .filter((f) => /^conversations(-.*)?\.json$/.test(f));
    let matched = 0;
    for (const f of files) {
      let arr;
      try {
        arr = JSON.parse(fs.readFileSync(path.join(CHATGPT_EXTRACT, f), 'utf8'));
      } catch {
        continue;
      }
      for (const c of Array.isArray(arr) ? arr : []) {
        const mapping = c.mapping || {};
        const nodes = Object.values(mapping).sort((a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0));
        for (const n of nodes) {
          const m = n?.message;
          if (!m || m.author?.role !== 'user') continue;
          const text = (m.content?.parts || []).filter((p) => typeof p === 'string').join('\n');
          if (!text) continue;
          const h = hashText(text);
          if (!corpusHashes.has(h) && !seen.has(h)) continue; // 没证据说明导入过 → 留给下次导入
          if (seen.has(h)) continue;
          const at = m.create_time ? new Date(m.create_time * 1000).toISOString() : null;
          push(c.conversation_id || c.id, c.title, at, text);
          matched++;
        }
      }
    }
    out.chatgpt.matchedFromExport = matched;
  }

  const added = appendLedger(WORKDIR, 'chatgpt', entries, { runId: 'backfill-2026-11-24' });
  const ledger = loadLedger(WORKDIR, 'chatgpt');
  out.chatgpt.entriesPrepared = entries.length;
  out.chatgpt.added = added;
  out.chatgpt.ledgerSize = ledger.size;
}

// ── DeepSeek 账本 ──
function backfillDeepseek() {
  const entries = [];
  const seen = new Set();
  const push = (convId, title, at, text) => {
    const h = hashText(text);
    if (seen.has(h)) return;
    seen.add(h);
    entries.push({ convId: convId || '', title: title || '', at: at || null, h, text: asText(text) });
  };

  const corpus = readJsonl(path.join(WORKDIR, 'profile', 'corpus-deepseek.jsonl'));
  const corpusHashes = new Set(corpus.filter((r) => r && r.text).map((r) => hashText(r.text)));
  out.deepseek.corpusTexts = corpusHashes.size;

  // 旧哈希种子（如果存在）
  const seedFile = path.join(WORKDIR, 'profile', 'import-runs', 'deepseek-imported-turns.jsonl');
  for (const r of readJsonl(seedFile)) if (r && r.h) corpusHashes.add(r.h);

  // 今日已导入的会话（processed-deepseek）
  const knownConvs = new Set();
  try {
    for (const id of JSON.parse(fs.readFileSync(path.join(WORKDIR, 'profile', 'import-runs', 'processed-deepseek.json'), 'utf8'))) {
      knownConvs.add(id);
    }
  } catch {}
  out.deepseek.knownConversations = knownConvs.size;

  if (DEEPSEEK_EXTRACT && fs.existsSync(DEEPSEEK_EXTRACT)) {
    const parsed = parseDeepseekDir(DEEPSEEK_EXTRACT);
    let matched = 0;
    let fromKnown = 0;
    for (const c of parsed.conversations) {
      for (const m of c.messages) {
        if (m.role !== 'user') continue;
        const h = hashText(m.text);
        const imported = corpusHashes.has(h) || knownConvs.has(c.convId);
        if (!imported) continue;
        push(c.convId, c.title, m.at || null, m.text);
        matched++;
        if (knownConvs.has(c.convId)) fromKnown++;
      }
    }
    out.deepseek.matchedFromExport = matched;
    out.deepseek.fromKnownConversations = fromKnown;
    out.deepseek.conversationsSeen = parsed.conversations.length;
  }

  // 历史数据集里的 deepseek 来源（如有）
  let runTurns = 0;
  const runsDir = path.join(WORKDIR, 'profile', 'import-runs');
  try {
    for (const d of fs.readdirSync(runsDir)) {
      const dsPath = path.join(runsDir, d, 'dataset.json');
      if (!fs.existsSync(dsPath)) continue;
      let ds;
      try {
        ds = JSON.parse(fs.readFileSync(dsPath, 'utf8'));
      } catch {
        continue;
      }
      for (const c of ds.conversations || []) {
        for (const m of c.messages || []) {
          if (m.role !== 'user') continue;
          const h = hashText(m.text);
          if (!corpusHashes.has(h) && !knownConvs.has(c.convId)) continue;
          push(c.convId, c.title, m.at || null, m.text);
          runTurns++;
        }
      }
    }
  } catch {}
  out.deepseek.fromRunDatasets = runTurns;

  const added = appendLedger(WORKDIR, 'deepseek', entries, { runId: 'backfill-2026-11-24' });
  const ledger = loadLedger(WORKDIR, 'deepseek');
  out.deepseek.entriesPrepared = entries.length;
  out.deepseek.added = added;
  out.deepseek.ledgerSize = ledger.size;
}

backfillChatgpt();
backfillDeepseek();
out.ok = true;
console.log(JSON.stringify(out, null, 2));
