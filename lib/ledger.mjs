// 分来源的导入账本（turn ledger）：记录每条已导入的用户原话，支持回溯与增量。
//
// 结构：
//   profile/imports/<source>/ledger.jsonl   每行一条原话：{src,convId,title,at,h,text,runId,importedAt}
//   profile/imports/<source>/runs/<runId>.json  一次导入的摘要（含新增会话/原话、数据集路径）
//
// 判重规则：只导入「哈希不在账本里」的用户原话；同一会话后来新增的原话也会被识别。
// 账本只在蒸馏+合并成功后追加，失败不会吞数据。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SOURCES = ['chatgpt', 'deepseek'];

export function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[。，、！？；：""''（）()\[\]{}<>《》…·.,!?;:'"`~\-—_]/g, '')
    .trim();
}

export const hashText = (s) => crypto.createHash('sha1').update(normalizeText(s)).digest('hex');

export const importsRoot = (cwd) => path.join(cwd, 'profile', 'imports');
export const ledgerPath = (cwd, source) => path.join(importsRoot(cwd), source, 'ledger.jsonl');
export const runsDir = (cwd, source) => path.join(importsRoot(cwd), source, 'runs');

export function loadLedger(cwd, source) {
  const file = ledgerPath(cwd, source);
  const byHash = new Map();
  const byConv = new Map();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (!j || !j.h) continue;
      byHash.set(j.h, j);
      if (j.convId) {
        const arr = byConv.get(j.convId) || [];
        arr.push(j);
        byConv.set(j.convId, arr);
      }
    }
  } catch {
    // 没有账本 = 空
  }
  return { byHash, byConv, size: byHash.size };
}

export function appendLedger(cwd, source, entries, meta = {}) {
  const file = ledgerPath(cwd, source);
  const cur = loadLedger(cwd, source).byHash;
  const now = new Date().toISOString();
  const fresh = [];
  for (const e of entries) {
    if (!e || !e.h || cur.has(e.h)) continue;
    fresh.push({
      src: source,
      convId: e.convId || '',
      title: e.title || '',
      at: e.at || null,
      h: e.h,
      text: e.text || '',
      runId: meta.runId || '',
      importedAt: meta.at || now,
    });
    cur.set(e.h, true);
  }
  if (!fresh.length) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${fresh.map((x) => JSON.stringify(x)).join('\n')}\n`, 'utf8');
  return fresh.length;
}

/**
 * 按账本过滤会话：只保留含新原话的会话；会话内只保留新原话 + 紧随其后的助手回复。
 * @returns {{conversations:Array, newTurns:number, skippedConversations:number, touchedConvIds:string[]}}
 */
export function filterByLedger(conversations, ledger) {
  const out = [];
  const touched = [];
  let newTurns = 0;
  let skippedConversations = 0;
  for (const conv of conversations) {
    const msgs = conv.messages || [];
    const kept = [];
    let changed = false;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role !== 'user') continue;
      const h = hashText(m.text);
      if (ledger.byHash.has(h)) continue;
      changed = true;
      newTurns++;
      kept.push({ ...m, _h: h });
      const next = msgs[i + 1];
      if (next && next.role === 'assistant') kept.push(next);
    }
    if (!changed) {
      skippedConversations++;
      continue;
    }
    touched.push(conv.convId);
    out.push({ ...conv, messages: kept });
  }
  return { conversations: out, newTurns, skippedConversations, touchedConvIds: touched };
}

/** 把数据集里的新原话记进账本，并写本次运行摘要 */
export function recordRun(cwd, source, { runId, datasetPath, conversations, extra = {} }) {
  const entries = [];
  for (const c of conversations || []) {
    const title = c.title || '';
    for (const m of c.messages || []) {
      if (m.role !== 'user') continue;
      entries.push({ convId: c.convId, title, at: m.at || null, h: m._h || hashText(m.text), text: m.text });
    }
  }
  const added = appendLedger(cwd, source, entries, { runId });
  const dir = runsDir(cwd, source);
  fs.mkdirSync(dir, { recursive: true });
  const summary = {
    runId,
    source,
    at: new Date().toISOString(),
    datasetPath: datasetPath || '',
    conversations: (conversations || []).length,
    newTurns: entries.length,
    recorded: added,
    ...extra,
  };
  fs.writeFileSync(path.join(dir, `${runId}.json`), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return { added, summary };
}

/** 回溯：某来源/会话在每次导入里新增了哪些原话 */
export function traceLedger(cwd, source, { convId, limit = 50 } = {}) {
  const { byConv } = loadLedger(cwd, source);
  const items = [];
  for (const [cid, arr] of byConv) {
    if (convId && cid !== convId) continue;
    for (const e of arr) items.push(e);
  }
  items.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  return { total: items.length, items: items.slice(-limit) };
}
