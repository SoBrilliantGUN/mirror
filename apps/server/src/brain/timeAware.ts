import type {
  MemoryStore,
  PeriodicRule,
  RecalledMemories,
  TimeAnchor,
  TimeAware,
  TimeContext,
  UpcomingDate,
} from '@mirror/contracts';
import type { HolidayMap } from './holiday';

// 时间感知（L5）：三层都只在通话内被动体现，不推送、不调度。
// - currentTimeContext：纯函数，输入 Date，输出结构化时间上下文（A 注入用）。
// - upcomingDates：查带时间锚点的活跃记忆，评估「今天/临近」命中（B 重要日期）。
// - scheduleCareHint：深夜/凌晨 + 记忆里有作息痕迹时给一句软提示（C 作息关怀）。
// 时间锚点硬约束：记忆里的时间只能是绝对或周期，禁止相对（今天/明天/下周三）。
// 注：程序化时间检测/折算（正则找时间 → 锚点）已拆到 timeAnchor.ts，这里只留「消费」侧。

const WEEKDAY_CN = ['一', '二', '三', '四', '五', '六', '日'];

// 东八区（Asia/Shanghai）固定偏移：国内用户固定东八区，中国无夏令时，+8h 精确。
// 不依赖服务器/容器时区——Docker 默认 UTC，直接读本地时间会差 8 小时。
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

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
function shanghaiMidnight(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day) - SHANGHAI_OFFSET_MS);
}

export function startOfDay(d: Date): Date {
  const p = shanghaiParts(d);
  return shanghaiMidnight(p.year, p.month, p.day);
}

function monthToSeason(m: number): TimeContext['season'] {
  if (m >= 3 && m <= 5) return '春';
  if (m >= 6 && m <= 8) return '夏';
  if (m >= 9 && m <= 11) return '秋';
  return '冬';
}

function hourToPeriod(h: number): TimeContext['period'] {
  if (h < 5) return '凌晨';
  if (h < 11) return '上午';
  if (h < 17) return '下午';
  if (h < 19) return '傍晚';
  if (h < 23) return '晚上';
  return '深夜';
}

// A：当前时间上下文（纯函数，可单测）。时区固定东八区，不依赖服务器本地时区。
export function currentTimeContext(now: Date, holidays: HolidayMap = new Map()): TimeContext {
  const p = shanghaiParts(now);
  const dateStr = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  const entry = holidays.get(dateStr);
  const isHoliday = entry?.isOffDay ?? false;
  const isWorkday = entry ? !entry.isOffDay : p.weekday <= 5;
  return {
    now: now.toISOString(),
    hour: p.hour,
    minute: p.minute,
    weekday: p.weekday,
    isWeekend: p.weekday >= 6,
    isWorkday,
    isHoliday,
    holidayName: isHoliday ? entry?.name : undefined,
    month: p.month,
    day: p.day,
    season: monthToSeason(p.month),
    period: hourToPeriod(p.hour),
  };
}

// 时间锚点结构规范化（抽取出的 raw 可能带字符串数字/缺字段，这里钉回合法结构）。非法返回 undefined。
export function normalizeTimeAnchor(raw: unknown): TimeAnchor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (o.kind === 'absolute') {
    const at = String(o.at ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) return undefined;
    return { kind: 'absolute', at };
  }
  if (o.kind === 'periodic') {
    const r = (o.rule ?? {}) as Record<string, unknown>;
    const type = String(r.type ?? '');
    const month = Number(r.month);
    const day = Number(r.day);
    const weekday = Number(r.weekday);
    const time = typeof r.time === 'string' && r.time ? r.time : undefined;
    if (type === 'yearly' && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { kind: 'periodic', rule: { type: 'yearly', month, day } };
    }
    if (type === 'monthly' && day >= 1 && day <= 31) {
      return { kind: 'periodic', rule: { type: 'monthly', day } };
    }
    if (type === 'weekly' && weekday >= 1 && weekday <= 7) {
      const rule: PeriodicRule = { type: 'weekly', weekday, ...(time ? { time } : {}) };
      return { kind: 'periodic', rule };
    }
    if (type === 'lunar' && month >= 1 && month <= 12 && day >= 1 && day <= 30) {
      return { kind: 'periodic', rule: { type: 'lunar', month, day } };
    }
    return undefined;
  }
  return undefined;
}

// 相对时间词守卫：记忆 content 里不允许残留这些（读的时候「明天」已失效）。用于抽取后自检/告警。
const RELATIVE_TIME_WORDS = [
  '明天', '后天', '昨天', '前天', '大后天', '大前天', '今天',
  '下周', '上周', '这周', '下个月', '上个月', '这个月', '去年', '明年', '今年', '前年',
];

export function hasRelativeTime(text: string): boolean {
  return RELATIVE_TIME_WORDS.some((w) => text.includes(w));
}

// 下一次发生日期（含当天）。absolute 过期不再触发；periodic 算最近一次。lunar V0 未实现 → null。
export function nextOccurrence(anchor: TimeAnchor, from: Date): Date | null {
  const start = startOfDay(from);
  const p = shanghaiParts(from);
  if (anchor.kind === 'absolute') {
    const [y, m, d] = anchor.at.split('-').map((n) => Number(n));
    const date = shanghaiMidnight(y, m, d);
    return date >= start ? date : null;
  }
  const rule = anchor.rule;
  if (rule.type === 'yearly') {
    let d = shanghaiMidnight(p.year, rule.month, rule.day);
    if (d < start) d = shanghaiMidnight(p.year + 1, rule.month, rule.day);
    return d;
  }
  if (rule.type === 'monthly') {
    // 注意：day 29~31 在某月不存在时 JS Date 会滚到下月；V0 接受该近似（罕见，见文档 §8）。
    let d = shanghaiMidnight(p.year, p.month, rule.day);
    if (d < start) {
      const nextMonth = p.month === 12 ? 1 : p.month + 1;
      const nextYear = p.month === 12 ? p.year + 1 : p.year;
      d = shanghaiMidnight(nextYear, nextMonth, rule.day);
    }
    return d;
  }
  if (rule.type === 'weekly') {
    const jsToday = p.weekday === 7 ? 0 : p.weekday;
    const jsTarget = rule.weekday === 7 ? 0 : rule.weekday;
    const diff = (jsTarget - jsToday + 7) % 7;
    return new Date(start.getTime() + diff * DAY_MS);
  }
  return null; // lunar：V0 不实现
}

// 从记忆 content 里取「是什么日子」的短标签（供 [TIME] 块 / 祝福语用）。
export function relationOf(content: string): string {
  const keys: [RegExp, string][] = [
    [/生日/, '生日'],
    [/忌日/, '忌日'],
    [/纪念日|周年/, '纪念日'],
    [/发工资/, '发工资'],
    [/加班/, '加班'],
  ];
  for (const [re, label] of keys) if (re.test(content)) return label;
  return '重要日子';
}

// B：临近/当天命中的时间锚点（窗口默认 7 天，含当天）。无则空数组。
export async function upcomingDates(
  store: Pick<MemoryStore, 'listAnchored'>,
  characterId: string,
  userId: string,
  now: Date,
  windowDays = 7,
): Promise<UpcomingDate[]> {
  const anchored = await store.listAnchored(characterId, userId);
  const today = startOfDay(now);
  const out: UpcomingDate[] = [];
  for (const m of anchored) {
    if (!m.anchor) continue;
    const next = nextOccurrence(m.anchor, now);
    if (!next) continue;
    const inDays = Math.round((next.getTime() - today.getTime()) / 86_400_000);
    if (inDays < 0 || inDays > windowDays) continue;
    out.push({ anchor: m.anchor, memory: m, relation: relationOf(m.content), inDays });
  }
  out.sort((a, b) => a.inDays - b.inDays);
  return out;
}

const SCHEDULE_WORDS = ['加班', '熬夜', '晚睡', '通宵', '失眠', '没睡', '睡不'];

// C：作息关怀软信号——深夜/凌晨 + 记忆里有作息痕迹时给一句候选，否则空串。纯函数、不调 LLM。
export function scheduleCareHint(now: Date, recalled: RecalledMemories): string {
  const ctx = currentTimeContext(now);
  const late = ctx.hour >= 23 || ctx.hour < 5;
  if (!late) return '';
  const hits = [...recalled.episodic, ...recalled.fact].filter((m) =>
    SCHEDULE_WORDS.some((w) => m.content.includes(w)),
  );
  if (hits.length === 0) return '';
  const detail = hits.slice(0, 2).map((m) => m.content).join('；');
  const time = `${String(ctx.hour).padStart(2, '0')}:${String(ctx.minute).padStart(2, '0')}`;
  return `现在${ctx.period}（${time}），记忆里对方最近作息不太规律（${detail}），可温柔关心一句，别指责、别催睡。`;
}

// 组装成 TimeAware（upcomingDates 闭包 store；其余纯函数直接引用）。
export function createTimeAware(store: Pick<MemoryStore, 'listAnchored'>, holidays: HolidayMap = new Map()): TimeAware {
  return {
    currentTimeContext: (now) => currentTimeContext(now, holidays),
    upcomingDates: (characterId, userId, now, windowDays) =>
      upcomingDates(store, characterId, userId, now, windowDays),
    scheduleCareHint,
  };
}

// 供 context.ts 的 [TIME] 块格式化：把锚点转成人类可读文案。
export function anchorLabel(a: TimeAnchor): string {
  if (a.kind === 'absolute') return a.at;
  const r = a.rule;
  if (r.type === 'yearly') return `${r.month}月${r.day}日`;
  if (r.type === 'monthly') return `每月${r.day}日`;
  if (r.type === 'weekly') return `每周${WEEKDAY_CN[r.weekday - 1]}${r.time ? ' ' + r.time : ''}`;
  if (r.type === 'lunar') return `农历${r.month}月${r.day}`;
  return '';
}
