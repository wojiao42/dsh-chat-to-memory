// 合并候选：调用已安装的 dsh-long-term-memory 插件完成落库（单一写入通道）。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function profileDir() {
  return process.env.DSH_PROFILE_DIR || 'D:\\DeepSeekHarness-1\\home\\profiles\\desktop';
}

/**
 * @param {string} cwd 工作区（候选文件应在其 profile/inbox 下）
 * @param {string} candidatesFile
 * @returns {Promise<{ok:boolean, reason?:string, written?:object, pending?:number, duplicates?:number, report?:string}>}
 */
export async function mergeCandidates(cwd, candidatesFile) {
  const entry = join(profileDir(), 'node_modules', 'dsh-long-term-memory', 'index.js');
  if (!existsSync(entry)) return { ok: false, reason: 'memory-plugin-missing', entry };
  const mod = await import(pathToFileURL(entry).href);
  const registered = [];
  const fakeCtx = { on: () => {}, tools: { register: (t) => registered.push(t) } };
  mod.apply(fakeCtx, { dshHome: join('D:', 'DeepSeekHarness-1', 'home') });
  const tool = registered.find((t) => t.name === 'memory_import_candidates');
  if (!tool) return { ok: false, reason: 'tool-missing' };
  const result = await tool.execute({ file: candidatesFile }, { agent: { session: { header: { cwd } } } });
  return {
    ok: true,
    written: result.written,
    pending: result.pending,
    duplicates: result.duplicates,
    skipped: result.skipped,
    report: result.report,
  };
}
