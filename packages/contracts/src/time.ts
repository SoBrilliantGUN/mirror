import type { Memory, RecalledMemories } from './memory';

// —— 时间锚点（L5 时间感知）：记忆里的时间只能是绝对或周期，禁止相对（今天/明天/下周三）。 ——
export type PeriodicRule =
  | { type: 'yearly'; month: number; day: number }        // 生日/纪念日：每年 3 月 15 日
  | { type: 'monthly'; day: number }                      // 每月 15 号
  | { type: 'weekly'; weekday: number; time?: string }    // 每周五（1=周一…7=周日，+ 可选时刻）
  | { type: 'lunar'; month: number; day: number };        // 农历八月十五（预留，V0 不实现）

export type TimeAnchor =
  | { kind: 'absolute'; at: string }        // 一次性：'2026-11-12'（忌日、某次重大事件）
  | { kind: 'periodic'; rule: PeriodicRule };  // 周期：每年/每月/每周

// —— 当前时间上下文（A 时间上下文注入，纯函数产出） ——
export type TimeContext = {
  now: string;          // ISO，便于 judge 对齐
  hour: number;         // 0–23
  minute: number;
  weekday: number;      // 1–7（1=周一）
  isWeekend: boolean;
  isWorkday: boolean;   // 是否工作日（调休补班=工作日，法定假日=非工作日）
  isHoliday: boolean;   // 是否法定节假日（放假）
  holidayName?: string; // 节日名（如"国庆节"），仅 isHoliday 时有
  month: number;
  day: number;
  season: '春' | '夏' | '秋' | '冬';
  period: '凌晨' | '上午' | '下午' | '傍晚' | '晚上' | '深夜';
};

// —— 临近/当天命中的重要日期（B 重要日期记忆） ——
export type UpcomingDate = {
  anchor: TimeAnchor;
  memory: Memory;       // 携带该锚点的记忆（生日是哪条）
  relation: string;     // 从 content 里取的「是什么日子」，如 "生日" / "忌日"
  inDays: number;       // 距今天数：0=今天，1=明天，≤windowDays=本周内
};

// 时间感知接口：三层都只在通话内被动体现（不推送、不调度）。
export interface TimeAware {
  // A：当前时间上下文（纯函数，可单测）。
  currentTimeContext(now: Date): TimeContext;
  // B：临近/当天命中的时间锚点（窗口默认 7 天，含当天）。无则空数组。
  upcomingDates(characterId: string, userId: string, now: Date, windowDays?: number): Promise<UpcomingDate[]>;
  // C：作息关怀软信号——深夜/凌晨 + 记忆里对方有「晚睡/加班」痕迹时给一句候选，否则空串。
  scheduleCareHint(now: Date, recalled: RecalledMemories): string;
}
