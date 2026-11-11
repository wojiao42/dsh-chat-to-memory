// ChatGPT 数据导出 · 每周自动备份主流程
//
// 状态机（state.json）：
//   pendingSince   —— 已向 OpenAI 请求导出、但还没拿到下载链接的时间戳
//   lastDownloadedAt / lastZip —— 上次成功下载的时间与文件
//
// 每次运行：
//   1) 有 pending → 去 Gmail 找"导出已准备就绪"邮件，有就下载 + 解压 + 记索引
//   2) 无 pending 且距上次成功 ≥7 天 → 触发一次新的导出，记 pending
//   3) 其它情况直接退出（不浪费请求）
//
// 用法：
//   node weekly.mjs             正常（幂等，可每天跑）
//   node weekly.mjs --force     忽略 7 天频率，强制触发新导出
//   node weekly.mjs --check-only 只查邮件，不触发新导出
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launch, ROOT, LOG_DIR, ZIP_DIR, EXTRACT_DIR, logLine } from './lib/browser.mjs';
import * as gw from './lib/gmailweb.mjs';
import { decideTrigger } from './lib/trigger.mjs';

const execFileP = promisify(execFile);
const STATE_PATH = path.join(ROOT, 'state.json');
const INDEX_PATH = path.join(ROOT, 'index.json');
const PENDING_MAX = 4 * 86400000;

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const checkOnly = args.has('--check-only');

const result = { startedAt: new Date().toISOString(), actions: [], ok: false, stage: 'init' };
const say = (m) => {
  result.actions.push(m);
  console.log('[weekly] ' + m);
};

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function saveState(s) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), 'utf8');
}
function loadIndex() {
  try {
    const v = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * 统计导出包里的会话数。
 * OpenAI 的导出格式会变：旧版是一个 `conversations.json`；2026-11 起改成按体积拆成
 * `conversations-000.json`、`conversations-001.json`…（本次实测 4 个分片，无 conversations.json）。
 * 两种都支持；返回 { count, files }。
 */
async function countConversations(dir) {
  const found = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/^conversations(-\d+)?\.json$/.test(e.name)) found.push(p);
    }
  }
  if (!found.length) return { count: null, files: [] };
  let total = 0;
  let any = false;
  for (const f of found) {
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      total += Array.isArray(data) ? data.length : typeof data === 'object' && data ? Object.keys(data).length : 0;
      any = true;
    } catch {
      /* 单个分片损坏不影响其他分片 */
    }
  }
  return { count: any ? total : null, files: found.map((f) => path.basename(f)) };
}

async function unzip(zipPath, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  await execFileP(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dest}' -Force`],
    { timeout: 300000 }
  );
}

/** 去 Gmail 找已就绪的导出邮件；拿到就下载解压，返回 { downloaded: bool, reason } */
async function tryDownloadPending(state) {
  result.stage = 'gmail';
  const ctx = await launch({ headless: false });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  try {
    // Gmail 的 after:YYYY/MM/DD 对「补零日期」不认：实测 after:2026/11/07 返回 0 条、
    // after:2026/11/7 正常（2026-11-09 踩坑：就绪邮件明明到了却报"还没有"）。
    // 改用 newer_than:Nd，按 pending 已经等了多久动态算天数，最稳。
    const waitedDays = Math.max(1, Math.ceil((Date.now() - state.pendingSince) / 86400000) + 2);
    const query = `from:openai newer_than:${Math.min(waitedDays, 30)}d`;
    say(`查 Gmail：${query}`);
    await gw.gotoSearch(page, query);
    const rows = await gw.listRows(page);
    const ready = rows.filter((r) => gw.READY_SUBJECT_RE.test(r.subject));
    if (!ready.length) {
      const waited = Date.now() - state.pendingSince;
      say(`还没有"已准备就绪"邮件（已等待 ${(waited / 3600000).toFixed(1)} 小时）。OpenAI 通常几小时到 1 天。`);
      if (waited > PENDING_MAX) {
        say('超过 4 天仍未收到，视为失败，下次运行会重新触发导出。');
        return { downloaded: false, reason: 'timeout' };
      }
      return { downloaded: false, reason: 'not-ready' };
    }

    say(`找到邮件：${ready[0].subject}（${ready[0].dateTitle}）`);
    const opened = await gw.openMailBySubject(page, gw.READY_SUBJECT_RE);
    if (!opened) return { downloaded: false, reason: 'open-failed' };

    const link = await gw.getDownloadLink(page);
    if (!link) {
      say('邮件里没找到导出直链，可能邮件布局变了。');
      return { downloaded: false, reason: 'no-link' };
    }
    say('拿到下载直链');

    const dateStr = new Date().toISOString().slice(0, 10);
    const zipPath = path.join(ZIP_DIR, `chatgpt-export-${dateStr}.zip`);
    result.stage = 'download';
    // 不走 Chrome 的下载管理器（会被迅雷等外部下载器接管，导致收不到文件）。
    // 用浏览器上下文的网络栈直接取字节写盘，cookie 与页面的完全一致。
    // 下载最多重试 3 次：网络抖动（ETIMEDOUT/ECONNRESET）不等于链接失效，
    // 链接有效期约 24 小时，网络问题应保留 pending 下个窗口再试。
    let resp = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        resp = await page.context().request.get(link, { timeout: 600000 });
        break;
      } catch (e) {
        lastErr = e;
        say(`下载第 ${attempt} 次失败：${String((e && e.message) || e).split('\n')[0].slice(0, 160)}`);
        if (attempt < 3) await page.waitForTimeout(4000);
      }
    }
    if (!resp) {
      return { downloaded: false, reason: 'download-error', error: String((lastErr && lastErr.message) || lastErr) };
    }
    if (!resp.ok()) {
      const status = resp.status();
      say(`下载失败：HTTP ${status}${status === 401 || status === 403 || status === 404 || status === 410 ? '（链接已过期/无权限）' : ''}`);
      // 4xx 视为链接失效；5xx/其它视为暂时性问题，保留 pending 重试
      return { downloaded: false, reason: status >= 400 && status < 500 ? 'link-expired' : 'download-error' };
    }
    const body = await resp.body();
    fs.writeFileSync(zipPath, body);
    const bytes = fs.statSync(zipPath).size;
    say(`已下载 ${path.basename(zipPath)}（${(bytes / 1048576).toFixed(1)} MB）`);

    result.stage = 'extract';
    const extractTo = path.join(EXTRACT_DIR, dateStr);
    await unzip(zipPath, extractTo);
    say(`已解压到 ${extractTo}`);

    const conv = await countConversations(extractTo);
    const conversations = conv.count;
    if (conv.files.length) say(`会话文件：${conv.files.join('、')}`);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
    const entry = {
      downloadedAt: new Date().toISOString(),
      zip: zipPath,
      bytes,
      sha256,
      extractedTo: extractTo,
      conversations,
    };
    const idx = loadIndex().filter((e) => e.zip !== zipPath);
    idx.unshift(entry);
    fs.writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 2), 'utf8');
    say(`校验：conversations.json ${conversations === null ? '未找到' : conversations + ' 个会话'}，sha256 ${sha256.slice(0, 12)}…`);

    return { downloaded: true, zipPath, conversations };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** 触发一次新的导出请求（复用 export.mjs） */
async function triggerExport() {
  result.stage = 'trigger';
  say('触发新的数据导出请求…');
  const { stdout } = await execFileP(process.execPath, [path.join(import.meta.dirname, 'export.mjs'), '--yes'], {
    timeout: 300000,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {}
  // 只有拿到 2xx（serverAccepted）才算真的提交成功；以前只判 confirmed 会误报
  //（2026-11-08 实测：点按钮成功但接口 401 reauth_required，等了 12 小时没邮件）。
  const accepted = parsed && (parsed.serverAccepted === true || (parsed.serverAccepted === undefined && parsed.confirmed));
  if (!accepted) {
    say('导出请求未确认成功：' + (parsed && (parsed.error || parsed.note) ? parsed.error || parsed.note : '解析 export.mjs 输出失败'));
    return false;
  }
  say(`导出请求已入队（${parsed.note || 'serverAccepted'}），等 OpenAI 发邮件`);
  return true;
}

// ── 主流程 ──
let state = loadState();
const now = Date.now();

try {
  if (state.pendingSince && !force) {
    const r = await tryDownloadPending(state);
    if (r.downloaded) {
      state.lastDownloadedAt = now;
      state.lastZip = r.zipPath;
      delete state.pendingSince;
      saveState(state);
      result.stage = 'done';
      result.ok = true;
      result.downloaded = true;
    } else if (r.reason === 'download-error') {
      // 网络抖动：保留 pending（就绪邮件/链接通常还有效），下个窗口再试
      saveState(state);
      result.stage = 'download-error';
      result.ok = false;
      result.error = r.error;
      say('下载遇到网络问题（链接通常仍有效），保留 pending，下个窗口重试。');
    } else if (r.reason === 'timeout' || r.reason === 'link-expired') {
      delete state.pendingSince;
      saveState(state);
      result.stage = r.reason === 'timeout' ? 'pending-timeout' : 'link-expired';
      result.ok = false;
      say(
        r.reason === 'timeout'
          ? '超过 4 天没收到就绪邮件，已清除 pending，下次窗口会重新触发导出。'
          : '下载链接已失效，已清除 pending，下次窗口会重新触发导出。',
      );
    } else {
      saveState(state);
      result.stage = 'waiting-mail';
      result.ok = true; // 正常等待，不算失败
    }
  } else if (checkOnly) {
    say('--check-only：没有待下载的导出，退出');
    result.ok = true;
    result.stage = 'idle';
  } else {
    // 触发时机锚定周日（理由见 lib/trigger.mjs）：避免触发点每周往后漂、最后撞上"没有后续下载窗口"
    const decision = decideTrigger({ now, state, force });
    if (!decision.trigger) {
      say(`跳过触发：${decision.reason}（--force 可强制）`);
      result.ok = true;
      result.stage = 'skip';
      result.triggerReason = decision.reason;
    } else {
      say(`满足触发条件：${decision.reason}`);
      const ok = await triggerExport();
      if (ok) {
        state.pendingSince = now;
        saveState(state);
        result.stage = 'requested';
        result.ok = true;
      } else {
        result.ok = false;
        result.stage = 'trigger-failed';
      }
    }
  }
} catch (e) {
  result.error = String((e && e.stack) || e);
  result.ok = false;
}

result.finishedAt = new Date().toISOString();
logLine('weekly.log', result);
fs.writeFileSync(path.join(LOG_DIR, 'last-weekly.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
