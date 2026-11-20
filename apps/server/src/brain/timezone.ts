// 东八区（Asia/Shanghai）时区换算：国内用户固定东八区，中国无夏令时，+8h 精确。
// 不依赖服务器/容器时区——Docker 默认 UTC，直接读本地时间会差 8 小时。
// 被 timeAware.ts（时间上下文/周期命中）、timeAnchor.ts（锚点解析/折算）、server.ts、consolidate 共用。
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

// 把「此刻」换算成东八区墙上字段：给 instant 加 8h 偏移后读其 UTC 字段，即北京时间。
export function shanghaiParts(now: Date): { year: number; month: number; day: number; weekday: number; hour: number; minute: number } {
  const w = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const jsDay = w.getUTCDay(); // 0=周日…6=周六
  return {
    year: w.getUTCFullYear(),
    month: w.getUTCMonth() + 1, // 1-12
    day: w.getUTCDate(),
    weekday: jsDay === 0 ? 7 : jsDay, // 1=周一…7=周日
    hour: w.getUTCHours(),
    minute: w.getUTCMinutes(),
  };
}

// 东八区某年某月某日 00:00 的 epoch ms（北京时间的「当天零点」）。
export function shanghaiMidnight(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day) - SHANGHAI_OFFSET_MS);
}

export function startOfDay(d: Date): Date {
  const p = shanghaiParts(d);
  return shanghaiMidnight(p.year, p.month, p.day);
}
