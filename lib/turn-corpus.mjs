// 已导入原话语料（turn-level 去重）。
// 目的：不靠日期猜「哪些导入过」，而是按用户原话的归一化哈希判重；同一会话后来新增的原话也能导入。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[。，、！？；：""''（）()\[\]{}<>《》…·.,!?;:'"`~\-—_]/g, '')
    .trim();

export const hashText = (s) => crypto.createHash('sha1').update(normalize(s)).digest('hex');

export function loadCorpus(file) {
  const set = new Set();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j && j.h) set.add(j.h);
      } catch {
        // 容忍单行损坏
      }
    }
  } catch {
    // 没有语料文件就当空
  }
  return set;
}

export function saveCorpus(file, hashes, meta = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = new Date().toISOString();
  const lines = [];
  for (const h of hashes) lines.push(JSON.stringify({ h, at: meta.at || now }));
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

/** 追加新哈希（去重） */
export function appendCorpus(file, hashes, meta = {}) {
  const cur = loadCorpus(file);
  const now = new Date().toISOString();
  const add = [...hashes].filter((h) => !cur.has(h));
  if (!add.length) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${add.map((h) => JSON.stringify({ h, at: meta.at || now })).join('\n')}\n`, 'utf8');
  return add.length;
}

/**
 * 按原话哈希过滤会话：只保留含「新原话」的会话，且会话里只保留新原话 + 紧随其后的助手回复（上下文）。
 * @returns {{conversations, newHashes:Set<string>, skippedConversations:number, newTurns:number, totalTurns:number}}
 */
export function filterByCorpus(conversations, corpus) {
  const out = [];
  const newHashes = new Set();
  let skippedConversations = 0;
  let newTurns = 0;
  let totalTurns = 0;
  for (const conv of conversations) {
    const msgs = conv.messages || [];
    const kept = [];
    let convHasNew = false;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role !== 'user') continue;
      totalTurns++;
      const h = hashText(m.text);
      if (corpus.has(h)) continue;
      newHashes.add(h);
      newTurns++;
      convHasNew = true;
      kept.push(m);
      // 带上紧随其后的助手回复，作为蒸馏上下文
      const next = msgs[i + 1];
      if (next && next.role === 'assistant') kept.push(next);
    }
    if (!convHasNew) {
      skippedConversations++;
      continue;
    }
    out.push({ ...conv, messages: kept });
  }
  return { conversations: out, newHashes, skippedConversations, newTurns, totalTurns };
}
