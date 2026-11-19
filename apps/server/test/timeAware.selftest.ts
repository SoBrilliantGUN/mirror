// 时间感知（L5）纯逻辑冒烟测试：时间锚点规范化 / 相对时间守卫 / 时间上下文 / 周期命中 / 作息关怀 / [TIME] 块。
// 时区固定东八区：所有输入用 UTC instant 构造，断言用 shanghaiParts 读回北京时间的墙上字段（不依赖跑测机的时区）。
// 运行：npm test
import { strict as assert } from 'node:assert';
import type { Memory, RecalledMemories, TimeAnchor } from '@mirror/contracts';
import {
  normalizeTimeAnchor,
  hasRelativeTime,
  currentTimeContext,
  nextOccurrence,
  upcomingDates,
  scheduleCareHint,
  anchorLabel,
  shanghaiParts,
} from '../src/brain/timeAware';
import { parseTimeAnchor, rewriteRelativeTime } from '../src/brain/timeAnchor';
import { formatTimeBlock } from '../src/brain/context';

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 固定参照：2026-11-12 02:15 北京时间 = 2026-11-11 18:15 UTC（周四）。
const NOV12_0215 = new Date(Date.UTC(2026, 10, 11, 18, 15));

const mem = (content: string, anchor?: TimeAnchor): Memory => ({
  id: 'm1', userId: 'u', characterId: 'c', kind: 'fact', content,
  entityId: null, dimension: null, aspect: null, anchor,
  accessCount: 0, lastAccess: null, superseded: false, version: 1, createdAt: '',
});

const recalled = (e: string[] = [], f: string[] = []): RecalledMemories => ({
  constraint: [], profile: [], fact: f.map((c) => mem(c)), preference: [], episodic: e.map((c) => mem(c)),
});

console.log('normalizeTimeAnchor（时间锚点规范化）');
ok('合法 absolute', () => {
  assert.deepEqual(normalizeTimeAnchor({ kind: 'absolute', at: '2026-11-18' }), { kind: 'absolute', at: '2026-11-18' });
});
ok('合法 yearly', () => {
  assert.deepEqual(normalizeTimeAnchor({ kind: 'periodic', rule: { type: 'yearly', month: 11, day: 13 } }), {
    kind: 'periodic', rule: { type: 'yearly', month: 11, day: 13 },
  });
});
ok('合法 weekly（字符串数字也能钉回）', () => {
  const r = normalizeTimeAnchor({ kind: 'periodic', rule: { type: 'weekly', weekday: '5' } });
  assert.deepEqual(r, { kind: 'periodic', rule: { type: 'weekly', weekday: 5 } });
});
ok('非法月份 → undefined', () => {
  assert.equal(normalizeTimeAnchor({ kind: 'periodic', rule: { type: 'yearly', month: 13, day: 1 } }), undefined);
});
ok('非法 absolute 格式 → undefined', () => {
  assert.equal(normalizeTimeAnchor({ kind: 'absolute', at: '明天' }), undefined);
});
ok('非对象 → undefined', () => assert.equal(normalizeTimeAnchor(null), undefined));

console.log('hasRelativeTime（相对时间守卫）');
ok('「明天」命中', () => assert.equal(hasRelativeTime('对方明天生日'), true));
ok('「下周三」命中', () => assert.equal(hasRelativeTime('下周三是我妈忌日'), true));
ok('绝对措辞不命中', () => assert.equal(hasRelativeTime('对方生日是 11 月 13 日'), false));

console.log('parseTimeAnchor（程序化时间检测与折算）');
ok('农历生日 → lunar', () => {
  assert.deepEqual(parseTimeAnchor('对方生日是农历八月十五', NOV12_0215), { kind: 'periodic', rule: { type: 'lunar', month: 8, day: 15 } });
});
ok('腊月别名（无农历标记也判农历）→ lunar', () => {
  assert.deepEqual(parseTimeAnchor('对方过阴历生日，腊月初八', NOV12_0215), { kind: 'periodic', rule: { type: 'lunar', month: 12, day: 8 } });
});
ok('阳历生日 → yearly', () => {
  assert.deepEqual(parseTimeAnchor('对方生日是11月13日', NOV12_0215), { kind: 'periodic', rule: { type: 'yearly', month: 11, day: 13 } });
});
ok('忌日 → yearly', () => {
  assert.deepEqual(parseTimeAnchor('对方妈妈忌日是三月五号', NOV12_0215), { kind: 'periodic', rule: { type: 'yearly', month: 3, day: 5 } });
});
ok('每年 → yearly', () => {
  assert.deepEqual(parseTimeAnchor('对方每年11月13日都回老家', NOV12_0215), { kind: 'periodic', rule: { type: 'yearly', month: 11, day: 13 } });
});
ok('每月 → monthly', () => {
  assert.deepEqual(parseTimeAnchor('对方每月15号发工资', NOV12_0215), { kind: 'periodic', rule: { type: 'monthly', day: 15 } });
});
ok('每周 → weekly', () => {
  assert.deepEqual(parseTimeAnchor('对方每周五去健身', NOV12_0215), { kind: 'periodic', rule: { type: 'weekly', weekday: 5 } });
});
ok('明天 → absolute', () => {
  assert.deepEqual(parseTimeAnchor('对方明天有面试', NOV12_0215), { kind: 'absolute', at: '2026-11-13' });
});
ok('下周三 → absolute', () => {
  assert.deepEqual(parseTimeAnchor('对方下周三有面试', NOV12_0215), { kind: 'absolute', at: '2026-11-18' });
});
ok('裸「周三」→ 最近一次未来 → absolute', () => {
  assert.deepEqual(parseTimeAnchor('对方周三有面试', NOV12_0215), { kind: 'absolute', at: '2026-11-18' });
});
ok('上周五 → absolute', () => {
  assert.deepEqual(parseTimeAnchor('对方上周五来过', NOV12_0215), { kind: 'absolute', at: '2026-11-06' });
});
ok('下个月15号 → absolute', () => {
  assert.deepEqual(parseTimeAnchor('对方下个月15号答辩', NOV12_0215), { kind: 'absolute', at: '2026-12-15' });
});
ok('明年3月5日 → absolute', () => {
  assert.deepEqual(parseTimeAnchor('对方明年3月5日毕业', NOV12_0215), { kind: 'absolute', at: '2027-03-05' });
});
ok('无时间 → undefined', () => {
  assert.equal(parseTimeAnchor('对方喜欢喝咖啡', NOV12_0215), undefined);
});

console.log('rewriteRelativeTime（相对词改写为绝对日期）');
ok('明天 → 具体日期', () => {
  assert.equal(rewriteRelativeTime('对方明天有面试', NOV12_0215), '对方11月13日有面试');
});
ok('下周三 → 具体日期', () => {
  assert.equal(rewriteRelativeTime('对方下周三有面试', NOV12_0215), '对方11月18日有面试');
});
ok('多个相对词都替换', () => {
  assert.equal(rewriteRelativeTime('对方明天和后天都有事', NOV12_0215), '对方11月13日和11月14日都有事');
});
ok('无相对词 → 原样', () => {
  assert.equal(rewriteRelativeTime('对方生日是11月13日', NOV12_0215), '对方生日是11月13日');
});

console.log('currentTimeContext（时间上下文纯函数，东八区）');
ok('UTC 18:15 → 北京时间 02:15 凌晨 + 周四 + 秋季', () => {
  const t = currentTimeContext(NOV12_0215);
  assert.equal(t.hour, 2);
  assert.equal(t.minute, 15);
  assert.equal(t.period, '凌晨');
  assert.equal(t.weekday, 4); // 周四
  assert.equal(t.month, 11);
  assert.equal(t.day, 12);
  assert.equal(t.season, '秋');
  assert.equal(t.isWeekend, false);
});
ok('UTC 15:30 → 北京时间 23:30 深夜', () => {
  assert.equal(currentTimeContext(new Date(Date.UTC(2026, 10, 12, 15, 30))).period, '深夜');
});
ok('跨日：UTC 16:00 → 北京时间次日 00:00 周日 weekday=7', () => {
  const t = currentTimeContext(new Date(Date.UTC(2026, 10, 14, 16, 0))); // 北京时间 11-15 00:00 周日
  assert.equal(t.weekday, 7);
  assert.equal(t.isWeekend, true);
  assert.equal(t.day, 15);
});
ok('节假日/工作日（无节假日数据）：工作日=周一~周五', () => {
  assert.equal(currentTimeContext(NOV12_0215).isWorkday, true);   // 周四 → 工作日
  assert.equal(currentTimeContext(NOV12_0215).isHoliday, false);
  assert.equal(currentTimeContext(new Date(Date.UTC(2026, 10, 14, 16, 0))).isWorkday, false); // 周日 11-15 → 非工作日
});
ok('法定节假日（放假）→ isHoliday、非工作日、带节日名', () => {
  const holidays = new Map([['2026-10-01', { isOffDay: true, name: '国庆节' }]]);
  const t = currentTimeContext(new Date(Date.UTC(2026, 9, 1, 0, 0)), holidays); // 北京 10-01 08:00
  assert.equal(t.isHoliday, true);
  assert.equal(t.isWorkday, false);
  assert.equal(t.holidayName, '国庆节');
});
ok('调休补班（周末上班）→ 工作日、非节假日', () => {
  const holidays = new Map([['2026-01-04', { isOffDay: false, name: '元旦' }]]);
  const t = currentTimeContext(new Date(Date.UTC(2026, 0, 4, 0, 0)), holidays); // 北京 01-04 08:00 周日
  assert.equal(t.isWorkday, true);
  assert.equal(t.isHoliday, false);
  assert.equal(t.isWeekend, true); // 本身是周日，但被调成工作日
});

console.log('nextOccurrence（周期/绝对下次命中，东八区）');
ok('yearly 明天生日', () => {
  const d = nextOccurrence({ kind: 'periodic', rule: { type: 'yearly', month: 11, day: 13 } }, NOV12_0215);
  assert.equal(shanghaiParts(d!).month, 11);
  assert.equal(shanghaiParts(d!).day, 13);
});
ok('yearly 当天生日（含今天）', () => {
  const d = nextOccurrence({ kind: 'periodic', rule: { type: 'yearly', month: 11, day: 12 } }, NOV12_0215);
  assert.equal(shanghaiParts(d!).day, 12);
});
ok('yearly 已过 → 明年', () => {
  const d = nextOccurrence({ kind: 'periodic', rule: { type: 'yearly', month: 1, day: 1 } }, NOV12_0215);
  assert.equal(shanghaiParts(d!).year, 2027);
});
ok('absolute 未来 → 当天', () => {
  const d = nextOccurrence({ kind: 'absolute', at: '2026-11-18' }, NOV12_0215);
  assert.equal(shanghaiParts(d!).day, 18);
});
ok('absolute 已过 → null（不重放）', () => {
  assert.equal(nextOccurrence({ kind: 'absolute', at: '2026-11-01' }, NOV12_0215), null);
});
ok('weekly 下个周五', () => {
  const d = nextOccurrence({ kind: 'periodic', rule: { type: 'weekly', weekday: 5 } }, NOV12_0215); // 周四
  assert.equal(shanghaiParts(d!).day, 13); // 次日周五
});

console.log('upcomingDates（临近日期查询）');
const fakeStore = (anchored: Memory[]) => ({ listAnchored: async () => anchored });

ok('命中 + 排序（生日明天、忌日 6 天后）', async () => {
  const out = await upcomingDates(
    fakeStore([
      mem('对方生日是 11 月 18 日', { kind: 'periodic', rule: { type: 'yearly', month: 11, day: 18 } }),
      mem('对方生日是 11 月 13 日', { kind: 'periodic', rule: { type: 'yearly', month: 11, day: 13 } }),
    ]),
    'c', 'u', NOV12_0215,
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].inDays, 1);
  assert.equal(out[0].relation, '生日');
  assert.equal(out[1].inDays, 6);
});
ok('窗口外（12 月 1 日）不返回', async () => {
  const out = await upcomingDates(
    fakeStore([mem('对方生日是 12 月 1 日', { kind: 'periodic', rule: { type: 'yearly', month: 12, day: 1 } })]),
    'c', 'u', NOV12_0215, 7,
  );
  assert.equal(out.length, 0);
});
ok('无锚点记忆 → 空', async () => {
  const out = await upcomingDates(fakeStore([mem('对方喜欢咖啡')]), 'c', 'u', NOV12_0215);
  assert.equal(out.length, 0);
});

console.log('scheduleCareHint（作息关怀软信号）');
ok('深夜 + 加班记忆 → 非空', () => {
  const hint = scheduleCareHint(new Date(Date.UTC(2026, 10, 11, 18, 0)), recalled(['对方昨天说加班到十一点']));
  assert.ok(hint.length > 0 && hint.includes('作息'));
});
ok('白天 → 空', () => {
  assert.equal(scheduleCareHint(new Date(Date.UTC(2026, 10, 12, 7, 0)), recalled(['对方昨天说加班到十一点'])), '');
});
ok('深夜但无作息痕迹 → 空', () => {
  assert.equal(scheduleCareHint(new Date(Date.UTC(2026, 10, 11, 18, 0)), recalled(['对方在准备考研'])), '');
});

console.log('anchorLabel（锚点 → 文案）');
ok('absolute → 日期', () => assert.equal(anchorLabel({ kind: 'absolute', at: '2026-11-18' }), '2026-11-18'));
ok('yearly → 月日', () => assert.equal(anchorLabel({ kind: 'periodic', rule: { type: 'yearly', month: 11, day: 13 } }), '11月13日'));
ok('weekly → 每周X', () => assert.equal(anchorLabel({ kind: 'periodic', rule: { type: 'weekly', weekday: 5 } }), '每周五'));

console.log('formatTimeBlock（[TIME] 块）');
ok('空时间上下文 → 空串', () => assert.equal(formatTimeBlock(undefined), ''));
ok('含 [TIME] + 时间上下文', () => {
  const block = formatTimeBlock(currentTimeContext(NOV12_0215));
  assert.ok(block.startsWith('[TIME]'));
  assert.ok(block.includes('11月12日'));
  assert.ok(block.includes('凌晨'));
});
ok('临近生日 → 明天 + 关系', () => {
  const block = formatTimeBlock(currentTimeContext(NOV12_0215), [
    { anchor: { kind: 'periodic', rule: { type: 'yearly', month: 11, day: 13 } }, memory: mem('对方生日是 11 月 13 日'), relation: '生日', inDays: 1 },
  ]);
  assert.ok(block.includes('明天是对方的生日'));
});
ok('作息关怀并入', () => {
  const block = formatTimeBlock(currentTimeContext(NOV12_0215), undefined, '现在凌晨，对方最近常加班');
  assert.ok(block.includes('现在凌晨'));
});

console.log(`\n全部通过：${passed} 项`);
