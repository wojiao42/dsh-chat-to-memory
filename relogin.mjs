// 重新登录 ChatGPT（邮箱验证码），用于满足数据导出接口的「最近登录」要求。
//
// 背景：POST /backend-api/accounts/data_export 在会话不够"新"时返回
//   401 {"detail":{"message":"Recent login required","code":"reauth_required"}}
// 官方网页在这种情况下会要求你重新登录。这里用「邮箱验证码」把这一步自动化：
//   登录页填邮箱 → OpenAI 发临时验证码邮件 → 从同一浏览器里的 Gmail 读码 → 提交 → 登录成功。
// 前置条件：Chrome profile 里 Gmail 仍保持登录（本机就是这种情况）。
//
// 用法：node relogin.mjs            （会先退出当前 ChatGPT 会话，再重新登录）
//       node relogin.mjs --dry-run  （只检查登录状态，不做任何改动）
import path from 'node:path';
import { launch, sessionState, maskEmail, logLine, LOG_DIR } from './lib/browser.mjs';
import * as gw from './lib/gmailweb.mjs';

const EMAIL = 'wojiao42@gmail.com';
const dryRun = process.argv.includes('--dry-run');
const result = { startedAt: new Date().toISOString(), ok: false, steps: [] };
const step = (m) => {
  result.steps.push(m);
  console.log('[relogin] ' + m);
};

async function waitCf(page, ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = await page.title().catch(() => '');
    if (t && !/just a moment|attention required/i.test(t)) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

/**
 * 读「新到的」验证码邮件，直接从列表摘要里取码。
 * 实测两点：
 *  1) 打开邮件正文取码不可靠（`div.a3s` 有时还是上一封的内容），列表摘要里就带着
 *     "Enter this temporary verification code to continue: 560312"；
 *  2) OpenAI 对"重发验证码"有节流，短时间内多次请求只会发一封，所以必须认摘要里的码，
 *     并允许"没有新邮件时沿用最近一封仍在有效期内（默认 15 分钟）的码"。
 * baseline 是请求验证码之前最新一封 OpenAI 邮件的摘要指纹。
 */
async function fetchLoginCode(ctx, baseline) {
  const mail = await ctx.newPage();
  const sigOf = (r) => `${r.subject}||${r.dateTitle}||${r.snippet}`;
  const codeOf = (r) => (String(r.snippet).match(/(\d{6})/) || [])[1] || null;
  const isCodeMail = (r) => /login code|登录代码|verification code|验证码/i.test(r.subject) && codeOf(r);
  try {
    const t0 = Date.now();
    let best = null;
    while (Date.now() - t0 < 120000) {
      await gw.gotoSearch(mail, 'from:openai newer_than:1h');
      const rows = await gw.listRows(mail);
      const fresh = rows.find((r) => isCodeMail(r) && sigOf(r) !== baseline);
      const any = rows.find(isCodeMail);
      if (fresh) return { code: codeOf(fresh), subject: fresh.subject, fresh: true };
      if (any && !best) best = { code: codeOf(any), subject: any.subject, fresh: false };
      if (best && Date.now() - t0 > 15000) break; // 没有新邮件就先用现有的
      await mail.waitForTimeout(4000);
    }
    if (best) return best;
    throw new Error('120s 内没找到任何 ChatGPT 登录验证码邮件');
  } finally {
    await mail.close().catch(() => {});
  }
}

/** 取当前最新一封 OpenAI 邮件的指纹，作为"新邮件"判据 */
async function newestMailSignature(ctx) {
  const mail = await ctx.newPage();
  try {
    await gw.gotoSearch(mail, 'from:openai newer_than:1h');
    const rows = await gw.listRows(mail);
    return rows.length ? `${rows[0].subject}||${rows[0].dateTitle}||${rows[0].snippet}` : '';
  } finally {
    await mail.close().catch(() => {});
  }
}

const ctx = await launch({ headless: false });
const page = ctx.pages()[0] ?? (await ctx.newPage());
try {
  // 0) 当前登录状态
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await waitCf(page);
  await page.waitForTimeout(4000);
  const st0 = await sessionState(page);
  step(`当前登录：hasToken=${st0.hasToken} email=${maskEmail(st0.email)}`);
  if (dryRun) {
    result.ok = true;
    result.dryRun = true;
    result.hasToken = st0.hasToken;
    throw Object.assign(new Error('__DRY_RUN_DONE__'), { code: 'dry' });
  }

  // 1) 退出当前会话（重新登录才算"最近登录"）
  if (st0.hasToken) {
    step('退出当前 ChatGPT 会话…');
    await page.goto('https://chatgpt.com/auth/logout', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000);
    // 兜底：如果仍在登录态，走设置页的 Log out
    let st = await sessionState(page).catch(() => ({}));
    if (st.hasToken) {
      step('导航退出未生效，尝试 UI 退出…');
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(3000);
      const menu = page.locator('button[aria-label*="profile" i], button[aria-label*="account" i], button#radix-\\:r0\\:').first();
      await menu.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const logout = page.getByRole('menuitem', { name: /log out|退出登录/i }).first();
      await logout.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(5000);
      st = await sessionState(page).catch(() => ({}));
    }
    step(`退出后 hasToken=${Boolean(st.hasToken)}`);
  }

  // 2) 邮箱验证码登录
  step('打开登录页并用邮箱继续…');
  await page.goto('https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await waitCf(page);
  await page.waitForTimeout(4000);
  const emailInput = page.locator('input[type="email"], input[name="username"]').first();
  await emailInput.waitFor({ state: 'visible', timeout: 30000 });
  await emailInput.fill(EMAIL);
  // 记录"请求验证码之前"的最新邮件指纹，避免拿到上一轮的旧码
  const baseline = await newestMailSignature(ctx).catch(() => '');
  await page.getByRole('button', { name: /^continue$/i }).first().click();
  await page.waitForURL(/email-verification/, { timeout: 40000 }).catch(() => {});
  step(`已请求验证码，页面：${page.url()}`);

  // 3) 从 Gmail 取码并提交
  const { code, subject } = await fetchLoginCode(ctx, baseline);
  step(`收到验证码邮件「${subject}」（码 ${code.slice(0, 2)}****）`);
  const codeInput = page.locator('input[name="code"], input[autocomplete="one-time-code"], input[type="text"]').first();
  await codeInput.waitFor({ state: 'visible', timeout: 30000 });

  // 提交一次（提交后页面通常直接跳转 chatgpt.com，所以填值和点击只做一遍）
  const submitOnce = async (codeValue) => {
    await codeInput.fill(codeValue).catch(() => {});
    const bySubmit = page.locator('button[type="submit"]').first();
    if (await bySubmit.count().catch(() => 0)) {
      await bySubmit.click({ timeout: 10000 }).catch(() => {});
    } else {
      await page
        .getByRole('button', { name: /submit|verify|continue|确认|提交/i })
        .first()
        .click({ timeout: 10000 })
        .catch(() => {});
    }
    await page.waitForTimeout(6000).catch(() => {});
    return {
      url: page.url(),
      body: await page.evaluate(() => (document.body.innerText || '').slice(0, 400)).catch(() => null),
    };
  };

  let after = await submitOnce(code);
  step(`已提交验证码，当前页面：${after.url}`);
  if (/incorrect|invalid|expired|错误|失效/i.test(String(after.body || ''))) {
    step('验证码被判无效，点「Resend email」重发后再试一次…');
    const baseline2 = await newestMailSignature(ctx).catch(() => '');
    await page.getByRole('button', { name: /resend/i }).first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(6000);
    const again = await fetchLoginCode(ctx, baseline2).catch(() => null);
    if (again && again.code && again.code !== code) {
      after = await submitOnce(again.code);
      step(`二次提交（码 ${again.code.slice(0, 2)}****），当前页面：${after.url}`);
    } else {
      step('重发后没拿到新码（可能被节流），保持第一次结果');
    }
  }
  result.afterSubmit = after;

  // 4) 确认登录成功
  let ok = false;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(2000);
    const url = page.url();
    const st = await sessionState(page).catch(() => ({}));
    if (st.hasToken && !/auth\.openai\.com|email-verification/.test(url)) {
      ok = true;
      break;
    }
  }
  result.ok = ok;
  result.email = maskEmail(EMAIL);
  step(ok ? '✔ 重新登录成功' : '✘ 重新登录未成功（仍无 token）');
} catch (e) {
  if (e && e.code === 'dry') {
    /* dry-run 正常结束 */
  } else {
    result.error = String((e && e.message) || e);
    console.error('[relogin] 失败：', result.error);
    try {
      result.failure = {
        url: page.url(),
        body: await page.evaluate(() => (document.body.innerText || '').slice(0, 1200)),
        buttons: await page.$$eval('button, [role="button"], a', (els) =>
          els.map((x) => (x.innerText || '').trim()).filter(Boolean).slice(0, 25),
        ),
      };
      const shot = path.join(LOG_DIR, `relogin-failure-${Date.now()}.png`);
      await page.screenshot({ path: shot });
      result.failure.screenshot = shot;
    } catch {}
  }
} finally {
  await ctx.close().catch(() => {});
}

result.finishedAt = new Date().toISOString();
logLine('relogin.log', result);
console.log(JSON.stringify({ ok: result.ok, error: result.error ?? null, steps: result.steps }, null, 2));
process.exit(result.ok ? 0 : 1);
