// DeepSeek 网页导出 → 统一数据集（CLI，可被插件 spawn）。
// 流程：检查登录态 → 查/触发官方导出 → 等生成 → 下载 ZIP → 解压（PowerShell Expand-Archive）→ 转成与 ChatGPT 源一致的数据集 JSON。
//
// 用法：node deepseek-import.mjs --workdir "D:\deepseek workspace" [--profile "D:\ChatGPT-Backups\profile-deepseek"] [--show]
// 输出：最后一行 JSON {ok, stage, ...}
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { filterByLedger, loadLedger } from './ledger.mjs';

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const WORKDIR = argOf('--workdir', 'D:\\deepseek workspace');
const PROFILE = argOf('--profile', 'D:\\ChatGPT-Backups\\profile-deepseek');
const SHOW = args.includes('--show');
const ROOT = 'D:\\ChatGPT-Backups';
const ZIP_DIR = path.join(ROOT, 'deepseek-zips');
const EXTRACT_DIR = path.join(ROOT, 'deepseek-extracted');
fs.mkdirSync(ZIP_DIR, { recursive: true });

const out = { ok: false, stage: 'start' };
const quit = (code = 0) => {
  console.log(JSON.stringify(out, null, 2));
  process.exit(code);
};

/** 从已解压目录解析成统一数据集格式 */
export function parseDeepseekDir(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'chat_session_index.json'), 'utf8'));
  const byId = new Map(idx.map((it) => [it.id, it]));
  const sessionsDir = path.join(dir, 'chat_sessions');
  const conversations = [];
  let userTurns = 0;
  for (const f of fs.readdirSync(sessionsDir)) {
    if (!f.endsWith('.json')) continue;
    let conv;
    try {
      conv = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
    } catch {
      continue;
    }
    const meta = byId.get(conv.id) || conv;
    const msgs = [];
    for (const m of conv.messages || []) {
      const role = m.role === 'USER' ? 'user' : m.role === 'ASSISTANT' ? 'assistant' : null;
      if (!role) continue;
      const parts = (m.fragments || [])
        .filter((x) => x && typeof x.content === 'string')
        .filter((x) => (role === 'user' ? x.type !== 'THINK' : true))
        .map((x) => x.content);
      let text = parts.join('\n').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (role === 'assistant') text = text.slice(0, 100);
      if (role === 'user') userTurns++;
      msgs.push({ role, at: m.inserted_at || null, text });
    }
    if (!msgs.some((m) => m.role === 'user')) continue;
    conversations.push({
      convId: conv.id,
      title: conv.title || meta.title || '(无标题)',
      updatedAt: Date.parse(conv.updated_at || meta.updated_at || conv.inserted_at || 0) || null,
      messages: msgs,
    });
  }
  return {
    formatVersion: manifest.export_format_version,
    sessions: idx.length,
    conversations,
    userTurns,
  };
}

async function main() {
  out.stage = 'launch';
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      ...(SHOW
        ? ['--window-position=120,120', '--window-size=1280,940']
        : ['--window-position=-32000,-32000', '--window-size=1280,900', '--disable-backgrounding-occluded-windows']),
    ],
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    const token = await page.evaluate(() => {
      try {
        const v = JSON.parse(localStorage.getItem('userToken') || '{}');
        return typeof v === 'string' ? v : v.value || '';
      } catch {
        return '';
      }
    });
    if (!/chat\.deepseek\.com/.test(page.url()) || !token) {
      out.stage = 'need-login';
      out.error = 'DeepSeek 登录态失效：请先在专用浏览器窗口里登录一次（--show 可显示窗口）';
      quit(2);
    }
    const call = (u) =>
      page.evaluate(async (url) => {
        const tok = JSON.parse(localStorage.getItem('userToken') || '{}').value || '';
        const r = await fetch(url, { credentials: 'include', headers: { Authorization: 'Bearer ' + tok } });
        return { status: r.status, text: await r.text() };
      }, u);

    out.stage = 'check-export';
    const hist = await call('/api/v0/download_export_history');
    let j = null;
    try {
      j = JSON.parse(hist.text);
    } catch {}
    let bd = j?.data?.biz_data;
    if (!bd) {
      out.stage = 'trigger-export';
      await call('/api/v0/export_all');
    }
    out.stage = 'waiting-export';
    const deadline = Date.now() + 15 * 60 * 1000;
    let url = bd?.status === 'FINISHED' ? bd.history_download_url : null;
    let expireAt = bd?.expires_at || null;
    while (!url && Date.now() < deadline) {
      await page.waitForTimeout(8000);
      const s = await call('/api/v0/download_export_history');
      let k = null;
      try {
        k = JSON.parse(s.text);
      } catch {}
      bd = k?.data?.biz_data;
      if (bd?.status === 'FINISHED' && bd.history_download_url) {
        url = bd.history_download_url;
        expireAt = bd.expires_at;
        break;
      }
      if (bd?.status === 'EMPTY') break;
    }
    if (!url) {
      out.stage = 'export-pending';
      out.error = '15 分钟内未生成下载链接（导出任务会保留，稍后重试即可）';
      quit(1);
    }

    out.stage = 'download';
    const res = await ctx.request.get(url, { timeout: 20 * 60 * 1000 });
    if (!res.ok()) {
      out.stage = 'download-error';
      out.error = `HTTP ${res.status()}`;
      quit(1);
    }
    const buf = await res.body();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const zipPath = path.join(ZIP_DIR, `deepseek_data-${stamp}.zip`);
    fs.writeFileSync(zipPath, buf);
    out.zipPath = zipPath;
    out.zipBytes = buf.length;

    out.stage = 'extract';
    const dir = path.join(EXTRACT_DIR, stamp);
    fs.mkdirSync(dir, { recursive: true });
    // Expand-Archive 解压（Windows 内置；避免额外依赖）
    const ps = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10 * 60 * 1000,
    });
    if (r.status !== 0) {
      out.stage = 'extract-error';
      out.error = `Expand-Archive 失败：${(r.stderr || '').slice(-300)}`;
      quit(1);
    }
    out.extractDir = dir;

    out.stage = 'parse';
    const parsed = parseDeepseekDir(dir);
    out.sessions = parsed.sessions;
    out.conversations = parsed.conversations.length;
    out.userTurns = parsed.userTurns;
    out.formatVersion = parsed.formatVersion;

    const runsDir = path.join(WORKDIR, 'profile', 'import-runs');
    fs.mkdirSync(runsDir, { recursive: true });
    // 原话级去重：以分来源账本为准（不靠日期/会话 id 猜）
    const ledger = loadLedger(WORKDIR, 'deepseek');
    const filtered = filterByLedger(parsed.conversations, ledger);
    const runStamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-deepseek';
    const runDir = path.join(runsDir, runStamp);
    fs.mkdirSync(runDir, { recursive: true });
    const datasetPath = path.join(runDir, 'dataset.json');
    fs.writeFileSync(datasetPath, `${JSON.stringify({ conversations: filtered.conversations }, null, 1)}\n`, 'utf8');
    out.stage = 'done';
    out.ok = true;
    out.datasetPath = datasetPath;
    out.ledgerFile = WORKDIR + '\\profile\\imports\\deepseek\\ledger.jsonl';
    out.conversationsTotal = parsed.conversations.length;
    out.skippedConversations = filtered.skippedConversations;
    out.touchedConvIds = filtered.touchedConvIds;
    out.newConversations = filtered.conversations.length;
    out.newUserTurns = filtered.newTurns;
    out.newHashes = filtered.newHashes.size;
    out.expireAt = expireAt;
    quit(0);
  } catch (e) {
    out.stage = 'error';
    out.error = String((e && e.message) || e);
    quit(1);
  } finally {
    await ctx.close().catch(() => {});
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
if (isMain) main();
