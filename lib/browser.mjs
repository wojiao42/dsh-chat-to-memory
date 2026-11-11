// 共享的浏览器启动与会话检测。
// 用系统 Chrome（channel:'chrome'）+ 独立 user-data-dir，不碰用户日常浏览器的 profile。
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

export const ROOT = 'D:\\ChatGPT-Backups';
export const PROFILE_DIR = path.join(ROOT, 'profile');
export const LOG_DIR = path.join(ROOT, 'logs');
export const ZIP_DIR = path.join(ROOT, 'zips');
export const EXTRACT_DIR = path.join(ROOT, 'extracted');

for (const d of [ROOT, PROFILE_DIR, LOG_DIR, ZIP_DIR, EXTRACT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

/**
 * 代理由**用户环境**提供，脚本只跟随，不写死端口。
 * 来源顺序：
 *   1) 环境变量（HTTPS_PROXY / HTTP_PROXY / ALL_PROXY，或显式 CHATGPT_EXPORT_PROXY）
 *   2) Windows 系统代理（HKCU Internet Settings，即用户自己设的那个）
 *   3) 都没有 → 直连
 * 为什么还要显式传：Playwright 的 `browserContext.request`（下载用）不从系统代理走，
 * 页面本身会走系统代理；不传给 request 就会直连被污染的 IP（2026-11-09 实测超时）。
 * 用户 2026-11-09 明确：代理是他的责任、由他保证环境，agent 不该自行管理代理。
 */
function readWindowsSystemProxy() {
  if (process.platform !== 'win32') return null;
  try {
    const r = spawnSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 },
    );
    if (r.status !== 0 || !r.stdout) return null;
    const enable = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(r.stdout);
    const m = r.stdout.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
    if (!enable || !m) return null;
    let server = m[1].trim();
    if (!server) return null;
    // 可能是 "http=host:port;https=host:port" 这种分协议写法
    if (server.includes('=')) {
      const parts = Object.fromEntries(
        server.split(';').map((p) => {
          const [k, v] = p.split('=');
          return [String(k || '').trim().toLowerCase(), String(v || '').trim()];
        }),
      );
      server = parts.https || parts.http || '';
    }
    if (!server) return null;
    return /^[a-z]+:\/\//i.test(server) ? server : `http://${server}`;
  } catch {
    return null;
  }
}

/** 当前生效的代理（用户环境提供；没有返回 null） */
export function resolveProxy() {
  const env =
    process.env.CHATGPT_EXPORT_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  if (env && env.trim()) return env.trim();
  return readWindowsSystemProxy();
}

/** 代理端口是否可连（连不上就不传，避免整个浏览器起不来） */
export function proxyReachable(proxy, timeoutMs = 800) {
  try {
    const u = new URL(proxy);
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    return new Promise((resolve) => {
      const socket = net.connect({ host: u.hostname, port });
      const done = (ok) => {
        socket.destroy();
        resolve(ok);
      };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.setTimeout(timeoutMs, () => done(false));
    });
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * 启动持久化上下文的 Chrome。
 * @param {{headless?: boolean, proxy?: string|null}} [opts]
 *        proxy 省略时按 resolveProxy() 跟随用户环境；传 null 表示强制直连。
 */
export async function launch(opts = {}) {
  const { headless = true } = opts;
  let useProxy = Object.prototype.hasOwnProperty.call(opts, 'proxy') ? opts.proxy : resolveProxy();
  if (useProxy && !(await proxyReachable(useProxy))) {
    console.error(`[browser] 代理 ${useProxy} 连不上，本次退回直连（请确认代理环境）`);
    useProxy = null;
  }
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless,
    ...(useProxy ? { proxy: { server: useProxy, bypass: 'localhost,127.0.0.1,<local>' } } : {}),
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    acceptDownloads: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  ctx.setDefaultTimeout(45000);
  return ctx;
}

/**
 * 通过页面内 fetch 读取 ChatGPT 会话信息（带 cookie，比解析 DOM 稳）。
 * @returns {Promise<{status?: number, hasToken?: boolean, email?: string|null, error?: string}>}
 */
export async function sessionState(page) {
  try {
    return await page.evaluate(async () => {
      try {
        const res = await fetch('/api/auth/session', { credentials: 'include' });
        const j = await res.json().catch(() => null);
        return {
          status: res.status,
          hasToken: Boolean(j && j.accessToken),
          email: (j && j.user && (j.user.email || j.user.name)) || null,
        };
      } catch (e) {
        return { error: String(e) };
      }
    });
  } catch (e) {
    return { error: String(e) };
  }
}

/** 邮箱脱敏：a***@gmail.com */
export function maskEmail(email) {
  if (!email || !email.includes('@')) return email || null;
  const [name, domain] = email.split('@');
  const head = name.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(1, Math.min(3, name.length - 1)))}@${domain}`;
}

/** 简单文件日志 */
export function logLine(file, obj) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...obj });
  fs.appendFileSync(path.join(LOG_DIR, file), line + '\n');
  return line;
}
