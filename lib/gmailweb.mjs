// 通过 Gmail 网页版找 OpenAI 的"数据导出已准备就绪"邮件，取出下载直链。
// 依赖独立 Chrome profile 里已登录的 Gmail 会话（ChatGPT 用 Google 登录时顺带建立）。
export const EXPORT_LINK_RE = /chatgpt\.com\/backend-api\/estuary\/content\//i;
export const READY_SUBJECT_RE = /准备就绪|export is ready|data export is ready|your data export/i;

export async function gotoSearch(page, query) {
  const url = 'https://mail.google.com/mail/u/0/#search/' + encodeURIComponent(query);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  // Gmail 是 SPA，等列表行出现
  await page.waitForSelector('tr.zA', { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

export async function listRows(page) {
  return await page.$$eval('tr.zA', (trs) =>
    trs.map((tr) => ({
      subject: (tr.querySelector('.bog') || {}).innerText || '',
      snippet: (tr.querySelector('.y2') || {}).innerText || '',
      dateTitle: (() => {
        const s = tr.querySelector('.xW span');
        return s ? s.getAttribute('title') || s.innerText : '';
      })(),
    }))
  );
}

/** 点击第一封标题匹配的邮件，返回标题；找不到返回 null */
export async function openMailBySubject(page, re) {
  const rows = await page.$$('tr.zA');
  for (const tr of rows) {
    const subject = await tr.$eval('.bog', (el) => el.innerText).catch(() => '');
    if (re.test(subject)) {
      await tr.click();
      await page.waitForSelector('div.a3s', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);
      return subject;
    }
  }
  return null;
}

/** 在当前打开的邮件正文里取下载直链 */
export async function getDownloadLink(page) {
  return await page.evaluate((linkRe) => {
    const re = new RegExp(linkRe, 'i');
    const body = document.querySelector('div.a3s');
    const anchors = body ? Array.from(body.querySelectorAll('a[href]')) : [];
    const hit = anchors.find((a) => re.test(a.href)) || anchors.find((a) => /下载|download/i.test(a.innerText || ''));
    return hit ? hit.href : null;
  }, EXPORT_LINK_RE.source);
}

/** 把 YYYY-MM-DD HH:mm 转 Gmail 的 after: 语法 */
export function gmailAfter(ms) {
  const d = new Date(ms - 86400000); // 往前一天，避免时区边界漏邮件
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}
