// 触发 ChatGPT 官方数据导出（等价于 设置 → Data controls → Export → 确认）。
// 结果：OpenAI 会把下载链接发到注册邮箱，链接 24 小时内有效。
//
// 关键坑（2026-11-08 实测）：直接点确认会 401
//   {"detail":{"message":"Recent login required","code":"reauth_required"}}
// 网页此时会跳到 auth.openai.com 要求"First, verify it's you"（邮箱验证码重新认证）。
// 所以完整流程是：点 Export → 确认 → 出现验证码页就自动从 Gmail 取码并提交 → 回到设置页
// → 再点一次 Export → 确认 → 拿到 200 {"status":"queued"}。
// 只有拿到 2xx 才算真的提交成功（之前只点按钮的版本会误报成功）。
//
// 用法：
//   node export.mjs            只点 Export 并打印弹窗内容，不确认（安全演练）
//   node export.mjs --yes      真正确认导出（含自动重新认证）
import fs from 'node:fs';
import path from 'node:path';
import { launch, sessionState, maskEmail, logLine, LOG_DIR } from './lib/browser.mjs';
import * as gw from './lib/gmailweb.mjs';

const confirm = process.argv.includes('--yes');
const ctx = await launch({ headless: false });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const result = { startedAt: new Date().toISOString(), confirmed: false, ok: false, step: 'start' };
const apiHits = [];
page.on('response', async (res) => {
  const u = res.url();
  if (/estuary|export/i.test(u)) {
    let body = '';
    try { body = (await res.text()).slice(0, 300); } catch {}
    apiHits.push({ url: u.slice(0, 240), status: res.status(), body });
  }
});
const sleep = (ms) => page.waitForTimeout(ms);
const bodyText = (n = 600) =>
  page.evaluate((len) => (document.body.innerText || '').replace(/\n{2,}/g, '\n').slice(0, len), n).catch(() => '');

async function waitCf(ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const title = await page.title().catch(() => '');
    if (title && !/just a moment|attention required|security verification/i.test(title)) return true;
    await sleep(1500);
  }
  return false;
}

async function dumpDialogs(tag) {
  const d = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
    return nodes.map((n) => ({
      text: (n.innerText || '').slice(0, 600),
      buttons: Array.from(n.querySelectorAll('button,[role="button"]')).map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim()).filter(Boolean),
    }));
  });
  const shot = path.join(LOG_DIR, `export-${tag}-${Date.now()}.png`);
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  return { dialogs: d, screenshot: shot };
}

/** 从 Gmail 最新验证码邮件摘要里取 6 位码（摘要形如 "... continue: 560312"） */
async function readLoginCode() {
  const mail = await ctx.newPage();
  try {
    for (let i = 0; i < 25; i++) {
      await gw.gotoSearch(mail, 'from:openai newer_than:10m');
      const rows = await gw.listRows(mail);
      for (const r of rows) {
        const m = String(r.snippet).match(/(\d{6})/);
        if (m && /code|验证码|verify|临时|temporary/i.test(r.subject)) return { code: m[1], subject: r.subject };
      }
      await mail.waitForTimeout(4000);
    }
    return null;
  } finally {
    await mail.close().catch(() => {});
  }
}

/** 点 Export（若还有弹窗再点 Confirm） */
async function clickExportConfirm() {
  const btn = page.getByRole('button', { name: /export chatgpt account data|^export$/i }).first();
  await btn.waitFor({ state: 'visible', timeout: 45000 });
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click({ timeout: 15000 }).catch(() => {});
  await sleep(3000);
  result.step = 'export-clicked';
  const dialog = page.locator('[role="dialog"], [role="alertdialog"]').first();
  let clicked = null;
  if (await dialog.count().catch(() => 0)) {
    for (const re of [/^confirm/i, /^export$/i, /^continue$/i]) {
      const b = dialog.getByRole('button', { name: re }).first();
      if (await b.count().catch(() => 0)) {
        clicked = (await b.innerText().catch(() => '')).trim();
        await b.click({ timeout: 10000 }).catch(() => {});
        break;
      }
    }
  }
  return clicked;
}

/** 出现验证码页就自动重新认证；成功返回 true */
async function completeReauth() {
  let codeInput = null;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const inp = page.locator('input[name="code"], input[autocomplete="one-time-code"]').first();
    if (await inp.count().catch(() => 0)) {
      codeInput = inp;
      break;
    }
    // 已经回到设置页且拿到 2xx，说明不需要验证
    if (apiHits.some((h) => h.status >= 200 && h.status < 300)) return false;
  }
  if (!codeInput) return false;
  result.reauthStarted = true;
  result.reauthUrl = page.url();
  const got = await readLoginCode();
  if (!got) throw new Error('重新认证需要验证码，但没在 Gmail 找到验证码邮件');
  result.reauthCodeSource = got.subject;
  await codeInput.fill(got.code);
  await page.getByRole('button', { name: /^continue$/i }).first().click({ timeout: 10000 }).catch(() => {});
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    if (/chatgpt\.com/.test(page.url()) && !/auth\.openai\.com/.test(page.url())) break;
  }
  result.reauthDoneUrl = page.url();
  return true;
}

async function waitAccepted(ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = apiHits.filter((h) => /data_export|estuary/i.test(h.url)).find((h) => h.status >= 200 && h.status < 300);
    if (hit) return hit;
    await sleep(1500);
  }
  return null;
}

try {
  await page.goto('https://chatgpt.com/settings/data-controls', { waitUntil: 'domcontentloaded', timeout: 60000 });
  result.cfPassed = await waitCf();
  if (!result.cfPassed) throw new Error('Cloudflare 挑战未通过');
  result.step = 'page-loaded';
  await sleep(3000);

  const s = await sessionState(page);
  result.session = { hasToken: s.hasToken, email: maskEmail(s.email) };
  if (!s.hasToken) throw new Error('登录态失效，需要先运行 relogin.mjs 或 open-login.mjs');

  const clicked = await clickExportConfirm();
  result.confirmButton = clicked;
  result.afterClick = await dumpDialogs('after-click');

  if (!confirm) {
    result.ok = true;
    result.note = '演练模式：未确认。确认导出请加 --yes';
  } else {
    result.confirmed = Boolean(clicked);
    result.step = 'confirm-clicked';

    // 第一次尝试：可能直接 200，也可能需要重新认证
    let accepted = await waitAccepted(20000);

    if (!accepted) {
      const didReauth = await completeReauth().catch((e) => {
        result.reauthError = String((e && e.message) || e);
        return false;
      });
      if (didReauth) {
        // 重新认证后回到设置页，再点一次 Export → Confirm
        if (!/settings\/data-controls/.test(page.url())) {
          await page.goto('https://chatgpt.com/settings/data-controls', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        }
        await sleep(4000);
        result.retryConfirmButton = await clickExportConfirm();
        accepted = await waitAccepted(45000);
      }
    }

    result.serverAccepted = Boolean(accepted);
    result.exportApi = apiHits.slice(-10);
    result.ok = Boolean(accepted);
    result.note = accepted
      ? `导出已入队（HTTP ${accepted.status}，${accepted.body || ''}）`
      : '未拿到 2xx 导出响应，导出可能没提交成功';
    result.afterConfirm = await dumpDialogs('after-confirm').catch(() => null);
    result.afterConfirmText = await bodyText(300);
  }
} catch (e) {
  result.error = String((e && e.message) || e);
  result.exportApi = apiHits.slice(-10);
  try {
    result.failure = await dumpDialogs('failure');
  } catch {}
}

result.finishedAt = new Date().toISOString();
logLine('export.log', result);
fs.writeFileSync(path.join(LOG_DIR, 'last-export.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify(result, null, 2));
await ctx.close().catch(() => {});
process.exit(result.ok ? 0 : 1);
