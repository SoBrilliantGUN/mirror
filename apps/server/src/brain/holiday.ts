// 中国法定节假日 + 调休数据：缓存优先（.holiday-cache.json），miss 则联网查（holiday-cn GitHub），
// 落盘缓存最近一年。数据源是国务院节假日安排（NateScarlet/holiday-cn 仓库每年更新）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HolidayEntry, HolidayMap } from '@mirror/contracts';

// HolidayEntry / HolidayMap 类型已上移到 contracts/time.ts（TimeAware 签名要用），这里 re-export 兼容旧引用。
export type { HolidayEntry, HolidayMap };

// 桌面版由 Electron 主进程注入到 userData 下；`npm start` 仍用仓库相对路径（apps/server/）。
function holidayCacheDir(): string {
  return process.env.HOLIDAY_CACHE_DIR ?? join(process.cwd(), 'apps', 'server');
}

const CACHE_FILE = join(holidayCacheDir(), '.holiday-cache.json');
const DATA_URL = (year: number) =>
  `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`;

type CacheShape = { year: number; days: Record<string, HolidayEntry> };

function loadCache(year: number): HolidayMap | null {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as CacheShape;
    if (data.year !== year || !data.days) return null;
    const map = new Map<string, HolidayEntry>();
    for (const [date, v] of Object.entries(data.days)) {
      if (v && typeof v.isOffDay === 'boolean') {
        map.set(date, { isOffDay: v.isOffDay, name: v.name ?? '' });
      }
    }
    return map.size > 0 ? map : null;
  } catch (e) {
    console.warn('[holiday] 读缓存失败，将重新联网查：', e);
    return null;
  }
}

function saveCache(year: number, map: HolidayMap): void {
  try {
    mkdirSync(holidayCacheDir(), { recursive: true });
    const days: Record<string, HolidayEntry> = {};
    for (const [date, v] of map) days[date] = v;
    writeFileSync(CACHE_FILE, JSON.stringify({ year, days }, null, 2));
    console.log(`[holiday] 已缓存 ${year} 年节假日（${map.size} 条）`);
  } catch (e) {
    console.warn('[holiday] 写缓存失败（不影响本次使用）：', e);
  }
}

// 加载某年节假日表：缓存优先，miss 则联网并落盘。失败回退空表（退化为「工作日=周一~周五」）。
export async function loadHolidayMap(year: number): Promise<HolidayMap> {
  const cached = loadCache(year);
  if (cached) {
    console.log(`[holiday] 从缓存加载 ${year} 年节假日（${cached.size} 条）`);
    return cached;
  }
  try {
    const res = await fetch(DATA_URL(year), { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      days?: Array<{ name?: string; date?: string; isOffDay?: boolean }>;
    };
    if (!data.days || !Array.isArray(data.days)) throw new Error('响应缺 days');
    const map = new Map<string, HolidayEntry>();
    for (const d of data.days) {
      if (!d.date || typeof d.isOffDay !== 'boolean') continue;
      map.set(d.date, { isOffDay: d.isOffDay, name: d.name ?? '' });
    }
    if (map.size === 0) throw new Error('响应为空');
    saveCache(year, map);
    return map;
  } catch (e) {
    console.warn('[holiday] 联网查失败，退化为按周末算工作日：', e);
    return new Map();
  }
}
