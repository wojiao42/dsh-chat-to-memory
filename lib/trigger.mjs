// 触发时机决策（纯函数，便于单元测试）
//
// 为什么不能只写「距上次成功下载满 7 天就触发」：
//   导出就绪要 ~24 小时，而「就绪」邮件的下载链接只活 24 小时。
//   如果任意窗口都能触发，触发点会随"上次下载完成时间"每周往后漂移，
//   迟早漂到一个"触发后、链接失效前没有任何后续窗口"的位置。
//   实测例子：11-09 19:51 下载完成 → 11-16 22:00 才满 7 天触发 →
//   11-17 22:00 就绪 → 可窗口只有周日/周一 → 等下一个窗口时链接已过期。
//
// 解决办法：**锚定周日**触发（周日 10:00 那轮），下载靠周一/周二的窗口兜住；
// 再加 8 天兜底补触发，防止"错过所有周日"时彻底停滞。
export const MIN_GAP_DAYS = 5; // 同一周期保护：距上次成功下载不足 5 天不触发
export const CATCHUP_DAYS = 8; // 兜底：超过 8 天任何窗口都可补触发

/**
 * @param {{now:number, state:{pendingSince?:number, lastDownloadedAt?:number}, force?:boolean}} p
 * @returns {{trigger:boolean, reason:string, days:number}}
 */
export function decideTrigger({ now, state = {}, force = false }) {
  if (force) return { trigger: true, reason: '--force', days: Infinity };
  if (state.pendingSince) return { trigger: false, reason: '已有 pending，先处理下载', days: null };
  const days = state.lastDownloadedAt ? (now - state.lastDownloadedAt) / 86400000 : Infinity;
  const isSunday = new Date(now).getDay() === 0;
  if (days < MIN_GAP_DAYS) {
    return { trigger: false, reason: `距上次成功下载 ${days.toFixed(1)} 天（<${MIN_GAP_DAYS}）`, days };
  }
  if (isSunday) return { trigger: true, reason: `周日锚点，距上次 ${days.toFixed(1)} 天`, days };
  if (days >= CATCHUP_DAYS) {
    return { trigger: true, reason: `超过 ${CATCHUP_DAYS} 天兜底补触发（非周日）`, days };
  }
  return { trigger: false, reason: `非周日锚点，距上次 ${days.toFixed(1)} 天（<${CATCHUP_DAYS}）`, days };
}
