// 调用插件自带的导出链脚本：weekly.mjs（触发导出/等邮件/下载/解压）。
// 为什么用 spawn 而不是重写：这段逻辑已实测跑通（邮箱验证码重新认证、代理跟随、下载校验）。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 找一个能解析 playwright-core 的 node_modules 目录 */
function nodePathCandidates(pluginDir) {
  const profileDir = process.env.DSH_PROFILE_DIR || 'D:\\DeepSeekHarness-1\\home\\profiles\\desktop';
  return [
    join(profileDir, 'node_modules'),
    join(pluginDir, 'node_modules'),
    'D:\\deepseek workspace\\automation\\node_modules',
  ].filter((p) => existsSync(p));
}

/** 从输出里取最后一个完整 JSON 对象（weekly.mjs 末尾会 print 结果） */
export function parseLastJson(text) {
  const s = String(text || '');
  const starts = [];
  for (let i = 0; i < s.length; i++) if (s[i] === '{') starts.push(i);
  for (let k = starts.length - 1; k >= 0; k--) {
    const start = starts[k];
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(s.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

/**
 * 跑一次导出窗口检查。
 * @returns {{ok: boolean, stage: string, downloaded?: boolean, actions?: string[], zipPath?: string, error?: string, raw?: string}}
 */
export function runWeekly({ pluginDir, timeoutMs = 15 * 60 * 1000, force = false } = {}) {
  const script = join(pluginDir, 'weekly.mjs');
  if (!existsSync(script)) return { ok: false, stage: 'script-missing', error: `找不到 ${script}` };
  const env = { ...process.env, NODE_PATH: nodePathCandidates(pluginDir).join(';') };
  const r = spawnSync(process.execPath, force ? [script, '--force'] : [script], {
    cwd: pluginDir,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const parsed = parseLastJson(out);
  if (parsed && parsed.stage) return { ok: r.status === 0, ...parsed, raw: out.slice(-2000) };
  return {
    ok: false,
    stage: 'spawn-failed',
    error: `weekly.mjs 退出码 ${r.status}；输出尾部：${out.slice(-800)}`,
    raw: out.slice(-2000),
  };
}
