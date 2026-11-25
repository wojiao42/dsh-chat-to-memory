// 记忆条目 → 原文的溯源索引（provenance）
// 每条：{h: 候选文本哈希, source, convId, title, at, date, quotes, runId, datasetPath, recordedAt}
// 用途：trace_origin 传 memoryText 时，先按 h 精确定位来源会话，再到账本取原文，不再靠关键词猜。
import fs from 'node:fs';
import path from 'node:path';
import { hashText } from './ledger.mjs';

export const provenancePath = (cwd) => path.join(cwd, 'profile', 'imports', 'provenance.jsonl');

export function loadProvenance(cwd) {
  const file = provenancePath(cwd);
  const byHash = new Map();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j && j.h) byHash.set(j.h, j);
    }
  } catch {}
  return byHash;
}

/** 记录一次导入的候选 → 来源映射（合并成功后调用；幂等） */
export function recordProvenance(cwd, { source, datasetPath, candidatesFile, runId }) {
  let candidates;
  try {
    candidates = JSON.parse(fs.readFileSync(candidatesFile, 'utf8'));
  } catch {
    return { added: 0 };
  }
  const items = Array.isArray(candidates.items) ? candidates.items : [];
  const file = provenancePath(cwd);
  const cur = loadProvenance(cwd);
  const now = new Date().toISOString();
  const fresh = [];
  for (const it of items) {
    if (!it || typeof it.text !== 'string') continue;
    const h = hashText(it.text);
    if (cur.has(h)) continue;
    fresh.push({
      h,
      source: source || '',
      convId: it.convId || '',
      title: it.title || '',
      at: null,
      date: it.date || '',
      quotes: Array.isArray(it.quotes) ? it.quotes : [],
      runId: runId || '',
      datasetPath: datasetPath || '',
      recordedAt: now,
    });
    cur.set(h, true);
  }
  if (!fresh.length) return { added: 0 };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${fresh.map((x) => JSON.stringify(x)).join('\n')}\n`, 'utf8');
  return { added: fresh.length };
}

/** 按记忆条目文本找溯源信息 */
export function lookupProvenance(cwd, memoryText) {
  const byHash = loadProvenance(cwd);
  const h = hashText(memoryText);
  if (byHash.has(h)) return byHash.get(h);
  // 宽松匹配：把记忆文本切成 4 字以上片段，命中任一候选文本的片段即认为相关
  const needles = String(memoryText || '')
    .split(/[，。；：、\s（）()「」【】]+/)
    .filter((x) => x.length >= 4)
    .slice(0, 6);
  for (const [ph, item] of byHash) {
    if (!needles.length) break;
    const joined = `${item.title} ${(item.quotes || []).join(' ')}`;
    if (needles.some((n) => joined.includes(n))) return item;
  }
  return null;
}
