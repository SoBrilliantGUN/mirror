// 程序化时间锚点检测与折算：从记忆 content 里用正则找时间，转成 absolute / periodic（含农历/阳历生日），
// 并把相对词（明天/下周三/下个月/明年）改写成折算后的具体日期。
// 替代 LLM 输出锚点——模型会忘，正则不会。纯函数、不调 LLM，可单测。
//
// 支持的时间表达 → 解析结果（不用读正则就能知道覆盖面；细节看下方各分支）：
//   「生日是11月13日」      → periodic yearly 11/13      「明天」            → absolute 次日
//   「农历八月十五」         → periodic lunar 8/15        「下周三」          → absolute 下周该日
//   「每周五」              → periodic weekly 5          「每月15号」        → periodic monthly 15
//   「2024年3月15日」        → absolute 2024-03-15        「3月15日」         → absolute 今年该日
import type { PeriodicRule, TimeAnchor } from '@mirror/contracts';
import { shanghaiParts, startOfDay } from './timezone';

const WEEKDAY_CN = ['一', '二', '三', '四', '五', '六', '日'];

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

// 状态性时间词：描述「记录当时」的瞬时状态（目前/正在/即将/现在/当前…），会过期、不能当永久事实。
// 命中则在末尾标注记录日期，避免后续召回把「当时的快照」当成「现在仍然如此」。
const TRANSIENT_TIME_RE = /目前|正在|即将|现在|当前|最近|眼下|这几天|这阵子/;

export function tagRecordedAt(content: string, now: Date): string {
  if (!TRANSIENT_TIME_RE.test(content)) return content;
  const p = shanghaiParts(now);
  return `${content}（记录于${p.year}年${p.month}月${p.day}日）`;
}

const DAY_MS = 86_400_000;

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const LUNAR_MONTH_ALIAS: Record<string, number> = { 正: 1, 冬: 11, 腊: 12 };
const WEEKDAY_MAP: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

// 中文数字 → 数值（一~九、十、十一~九十九）。非法返回 null。
function cnToNum(s: string): number | null {
  if (CN_NUM[s] != null) return CN_NUM[s];
  if (s === '十') return 10;
  let m = /^十([一二三四五六七八九])$/.exec(s); if (m) return 10 + CN_NUM[m[1]];
  m = /^([一二三四五六七八九])十$/.exec(s); if (m) return CN_NUM[m[1]] * 10;
  m = /^([一二三四五六七八九])十([一二三四五六七八九])$/.exec(s); if (m) return CN_NUM[m[1]] * 10 + CN_NUM[m[2]];
  return null;
}

// 解析「月」字段：阿拉伯数字 / 中文数字 / 农历月别名（正=1、冬=11、腊=12）。返回 1-12 或 null。
function parseMonth(s: string): number | null {
  if (/^\d{1,2}$/.test(s)) { const n = Number(s); return n >= 1 && n <= 12 ? n : null; }
  if (LUNAR_MONTH_ALIAS[s] != null) return LUNAR_MONTH_ALIAS[s];
  return cnToNum(s);
}

// 解析「日」字段：阿拉伯数字 / 中文数字 / 初X / 廿X。返回 1-31 或 null。
function parseDay(s: string): number | null {
  if (/^\d{1,2}$/.test(s)) { const n = Number(s); return n >= 1 && n <= 31 ? n : null; }
  let m = /^初([一二三四五六七八九十])$/.exec(s); if (m) return m[1] === '十' ? 10 : CN_NUM[m[1]];
  m = /^廿([一二三四五六七八九]?)$/.exec(s); if (m) return 20 + (m[1] ? CN_NUM[m[1]] : 0);
  const n = cnToNum(s);
  return n != null && n >= 1 && n <= 31 ? n : null;
}

function dateKey(y: number, mo: number, d: number): string {
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// 某 Date 的绝对锚点（按东八区墙上字段）。
function absoluteAt(d: Date): TimeAnchor {
  const p = shanghaiParts(d);
  return { kind: 'absolute', at: dateKey(p.year, p.month, p.day) };
}

// 月日字段（M月D日/D号，月日都支持中文或阿拉伯数字）。供生日/周期/绝对日期复用。
const MONTH_FIELD = '([正冬腊]|[一二三四五六七八九十]{1,3}|\\d{1,2})';
const DAY_FIELD = '([初一二三四五六七八九十廿]{1,3}|\\d{1,2})';
const MD_RE = new RegExp(`${MONTH_FIELD}月${DAY_FIELD}[日号]`);

function matchMonthDay(text: string): { month: number; day: number } | null {
  const m = MD_RE.exec(text);
  if (!m) return null;
  const month = parseMonth(m[1]);
  const day = parseDay(m[2]);
  return month != null && day != null ? { month, day } : null;
}

// 农历生日/节日：带「农历/阴历」标记，或 正月/腊月/冬月 别名（这些月名只存在于农历，无标记也判农历）。
function matchLunarDate(text: string): { month: number; day: number } | null {
  const m = new RegExp(`(农历|阴历)?\\s*${MONTH_FIELD}月${DAY_FIELD}[日号]?`).exec(text);
  if (!m) return null;
  const hasLunarMark = m[1] != null;
  const month = parseMonth(m[2]);
  const day = parseDay(m[3]);
  if (month == null || day == null) return null;
  if (hasLunarMark || m[2] === '正' || m[2] === '冬' || m[2] === '腊') return { month, day };
  return null;
}

// 关系日期（生日/忌日/纪念日/周年）+ 一个具体月日 → yearly（阳历，默认）。
function matchRelationDate(text: string): { month: number; day: number } | null {
  if (!/(生日|忌日|纪念日|周年)/.test(text)) return null;
  return matchMonthDay(text);
}

// 相对天（今天/明天/后天/昨天/…）。长词在前，避免「大后天」被「后天」先吃掉。
const DAY_OFFSET: [string, number][] = [
  ['大后天', 3], ['后天', 2], ['明天', 1], ['今天', 0],
  ['大前天', -3], ['前天', -2], ['昨天', -1],
];

function dateLabel(d: Date): string {
  const p = shanghaiParts(d);
  return `${p.month}月${p.day}日`;
}

// 从一段文本里程序化抽出时间锚点；找不到返回 undefined。
export function parseTimeAnchor(text: string, now: Date): TimeAnchor | undefined {
  const p = shanghaiParts(now);
  const today = startOfDay(now);

  // 1) 农历（生日/节日）→ lunar
  const lunar = matchLunarDate(text);
  if (lunar) return { kind: 'periodic', rule: { type: 'lunar', month: lunar.month, day: lunar.day } };

  // 2) 关系日期（生日/忌日/纪念日/周年）→ yearly（阳历）
  const relation = matchRelationDate(text);
  if (relation) return { kind: 'periodic', rule: { type: 'yearly', month: relation.month, day: relation.day } };

  // 3) 显式周期
  if (/每年/.test(text)) {
    const md = matchMonthDay(text);
    if (md) return { kind: 'periodic', rule: { type: 'yearly', month: md.month, day: md.day } };
  }
  {
    const m = /每(?:个?月)\s*(?:(\d{1,2}|[初一二三四五六七八九十廿]{1,3})[日号])?/.exec(text);
    if (m && m[1]) {
      const day = parseDay(m[1]);
      if (day != null) return { kind: 'periodic', rule: { type: 'monthly', day } };
    }
  }
  {
    const m = /每(?:周|星期|礼拜)([一二三四五六日天])/.exec(text);
    if (m) return { kind: 'periodic', rule: { type: 'weekly', weekday: WEEKDAY_MAP[m[1]] } };
  }

  // 4) 相对时间 → absolute
  for (const [word, off] of DAY_OFFSET) {
    if (text.includes(word)) return absoluteAt(new Date(today.getTime() + off * DAY_MS));
  }
  {
    const m = /(这|本|下|上)(?:周|星期|礼拜)([一二三四五六日天])/.exec(text);
    if (m) {
      const target = WEEKDAY_MAP[m[2]];
      const delta = target - p.weekday;
      const diff = m[1] === '下' ? delta + 7 : m[1] === '上' ? delta - 7 : delta;
      return absoluteAt(new Date(today.getTime() + diff * DAY_MS));
    }
  }
  {
    const m = /(?:周|星期|礼拜)([一二三四五六日天])/.exec(text); // 裸「周X」→ 最近一次未来
    if (m) {
      const target = WEEKDAY_MAP[m[1]];
      const diff = (target - p.weekday + 7) % 7;
      return absoluteAt(new Date(today.getTime() + diff * DAY_MS));
    }
  }
  {
    const m = /(下|上|这|本)(?:个?月)\s*([初一二三四五六七八九十廿]{1,3}|\d{1,2})[日号]/.exec(text);
    if (m) {
      let y = p.year, mo = p.month;
      if (m[1] === '下') { mo += 1; if (mo === 13) { mo = 1; y += 1; } }
      else if (m[1] === '上') { mo -= 1; if (mo === 0) { mo = 12; y -= 1; } }
      const day = parseDay(m[2]);
      if (day != null) return { kind: 'absolute', at: dateKey(y, mo, day) };
    }
  }
  {
    const m = new RegExp(`(今|明|去|前)年\\s*${MONTH_FIELD}月${DAY_FIELD}[日号]`).exec(text);
    if (m) {
      let y = p.year;
      if (m[1] === '明') y += 1; else if (m[1] === '去') y -= 1; else if (m[1] === '前') y -= 2;
      const month = parseMonth(m[2]);
      const day = parseDay(m[3]);
      if (month != null && day != null) return { kind: 'absolute', at: dateKey(y, month, day) };
    }
  }

  // 5) 绝对日期（无关系词、非周期）→ absolute（当年；带年份则用年份）
  {
    const m = new RegExp(`(\\d{4})年\\s*${MONTH_FIELD}月${DAY_FIELD}[日号]`).exec(text);
    if (m) {
      const month = parseMonth(m[2]);
      const day = parseDay(m[3]);
      if (month != null && day != null) return { kind: 'absolute', at: dateKey(Number(m[1]), month, day) };
    }
  }
  {
    const md = matchMonthDay(text);
    if (md) return { kind: 'absolute', at: dateKey(p.year, md.month, md.day) };
  }

  return undefined;
}

// 把 content 里的相对时间词替换成折算后的具体日期（绝对措辞），相对词失效问题一并解决。
export function rewriteRelativeTime(text: string, now: Date): string {
  let out = text;
  const p = shanghaiParts(now);
  const today = startOfDay(now);

  for (const [word, off] of DAY_OFFSET) {
    out = out.replaceAll(word, dateLabel(new Date(today.getTime() + off * DAY_MS)));
  }
  out = out.replace(/(这|本|下|上)(?:周|星期|礼拜)([一二三四五六日天])/g, (_, wk: string, wd: string) => {
    const target = WEEKDAY_MAP[wd];
    const delta = target - p.weekday;
    const diff = wk === '下' ? delta + 7 : wk === '上' ? delta - 7 : delta;
    return dateLabel(new Date(today.getTime() + diff * DAY_MS));
  });
  out = out.replace(/(下|上)(?:个?月)\s*([初一二三四五六七八九十廿]{1,3}|\d{1,2})[日号]?/g, (_, dir: string, dayRaw: string) => {
    let y = p.year, mo = p.month;
    if (dir === '下') { mo += 1; if (mo === 13) { mo = 1; y += 1; } }
    else { mo -= 1; if (mo === 0) { mo = 12; y -= 1; } }
    const d = parseDay(dayRaw);
    return d != null ? `${mo}月${d}日` : `${mo}月`;
  });
  out = out.replace(new RegExp(`(明|去|前)年\\s*${MONTH_FIELD}月${DAY_FIELD}[日号]?`, 'g'), (_, dir: string, moRaw: string, dayRaw: string) => {
    let y = p.year;
    if (dir === '明') y += 1; else if (dir === '去') y -= 1; else y -= 2;
    const mo = parseMonth(moRaw);
    const d = parseDay(dayRaw);
    return mo != null && d != null ? `${y}年${mo}月${d}日` : `${y}年`;
  });

  return out;
}
