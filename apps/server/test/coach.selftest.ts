// 纯逻辑冒烟测试：教练意图解析（parseCoachCue）+ 交互框架状态机（CoachTracker）+ 课题巩固解析（parseGoalExtract/deriveStage）。
// 运行：npm test
import { strict as assert } from 'node:assert';
import { CoachTracker, parseCoachCue } from '../src/brain/coach';
import { deriveStage, parseGoalExtract } from '../src/brain/consolidate/goalTurn';

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('parseCoachCue（容错）');
ok('标准 explicit', () => assert.equal(parseCoachCue('{"explicit":true,"invite":false,"theme":null}').explicit, true));
ok('标准 invite + theme', () => {
  const c = parseCoachCue('{"explicit":false,"invite":true,"theme":"和妈妈的关系"}');
  assert.equal(c.invite, true);
  assert.equal(c.theme, '和妈妈的关系');
});
ok('标准 resolved', () => assert.equal(parseCoachCue('{"explicit":false,"invite":false,"resolved":true,"theme":null}').resolved, true));
ok('缺失 resolved 默认 false', () => assert.equal(parseCoachCue('{"explicit":true}').resolved, false));
ok('theme null', () => assert.equal(parseCoachCue('{"explicit":false,"invite":false,"theme":null}').theme, null));
ok('包 markdown 代码块也能解析', () => assert.equal(parseCoachCue('```json\n{"explicit":true}\n```').explicit, true));
ok('字符串 "true" 也算', () => assert.equal(parseCoachCue('{"explicit":"true"}').explicit, true));
ok('非法 JSON → 全 false', () => {
  const c = parseCoachCue('不是 json');
  assert.equal(c.explicit, false);
  assert.equal(c.invite, false);
  assert.equal(c.theme, null);
});

console.log('CoachTracker 状态机');
ok('初始是 friend', () => assert.equal(new CoachTracker().current, 'friend'));
ok('explicit → 立即进 coach', () => {
  const t = new CoachTracker();
  assert.equal(t.next({ explicit: true, invite: false, resolved: false, theme: null }), 'coach');
});
ok('单次 invite 不触发', () => {
  const t = new CoachTracker();
  assert.equal(t.next({ explicit: false, invite: true, resolved: false, theme: null }), 'friend');
  assert.equal(t.shouldInvite, false);
});
ok('连续 2 次 invite → 触发温柔邀入（仍 friend）', () => {
  const t = new CoachTracker();
  t.next({ explicit: false, invite: true, resolved: false, theme: null });
  assert.equal(t.next({ explicit: false, invite: true, resolved: false, theme: '累' }), 'friend');
  assert.equal(t.shouldInvite, true);
});
ok('邀入后用户接话（explicit）→ 进 coach', () => {
  const t = new CoachTracker();
  t.next({ explicit: false, invite: true, resolved: false, theme: null });
  t.next({ explicit: false, invite: true, resolved: false, theme: null });
  assert.equal(t.next({ explicit: true, invite: false, resolved: false, theme: null }), 'coach');
});
ok('邀入后用户不接（闲聊）→ 回到陪伴', () => {
  const t = new CoachTracker();
  t.next({ explicit: false, invite: true, resolved: false, theme: null });
  t.next({ explicit: false, invite: true, resolved: false, theme: null });
  assert.equal(t.next({ explicit: false, invite: false, resolved: false, theme: null }), 'friend');
  assert.equal(t.shouldInvite, false);
});
ok('进了 coach 就保持', () => {
  const t = new CoachTracker();
  t.next({ explicit: true, invite: false, resolved: false, theme: null });
  assert.equal(t.next({ explicit: false, invite: false, resolved: false, theme: null }), 'coach');
});
ok('coach 态遇 resolved → 退回 friend（收口）', () => {
  const t = new CoachTracker();
  t.next({ explicit: true, invite: false, resolved: false, theme: null });
  assert.equal(t.next({ explicit: false, invite: false, resolved: true, theme: null }), 'friend');
});
ok('退回 friend 后能再次进 coach', () => {
  const t = new CoachTracker();
  t.next({ explicit: true, invite: false, resolved: false, theme: null });
  t.next({ explicit: false, invite: false, resolved: true, theme: null }); // 退回
  assert.equal(t.next({ explicit: true, invite: false, resolved: false, theme: null }), 'coach');
});
ok('invite 被一次无关话打断 → 计数清零', () => {
  const t = new CoachTracker();
  t.next({ explicit: false, invite: true, resolved: false, theme: null });
  t.next({ explicit: false, invite: false, resolved: false, theme: null });
  t.next({ explicit: false, invite: true, resolved: false, theme: null });
  assert.equal(t.current, 'friend');
  assert.equal(t.shouldInvite, false); // 又只累积了 1 次
});

console.log('parseGoalExtract / deriveStage');
ok('title + goal + stage', () => {
  const g = parseGoalExtract('{"title":"和妈妈的边界","goal":"好好说话又不委屈自己","stage":"goal"}');
  assert.equal(g.title, '和妈妈的边界');
  assert.equal(g.goal, '好好说话又不委屈自己');
  assert.equal(g.stage, 'goal');
});
ok('闲聊 → title null', () => assert.equal(parseGoalExtract('{"title":null}').title, null));
ok('done 检测', () => assert.equal(parseGoalExtract('{"title":"x","done":true}').done, true));
ok('deriveStage 兜底：有 will 取 will', () => {
  const g = parseGoalExtract('{"title":"x","will":"这周打电话"}');
  assert.equal(deriveStage(g), 'will');
});
ok('deriveStage 兜底：只有 goal 取 goal', () => {
  const g = parseGoalExtract('{"title":"x","goal":"想要稳定"}');
  assert.equal(deriveStage(g), 'goal');
});
ok('deriveStage：显式 stage 优先', () => {
  const g = parseGoalExtract('{"title":"x","goal":"g","will":"w","stage":"reality"}');
  assert.equal(deriveStage(g), 'reality');
});
ok('全空 → null', () => assert.equal(deriveStage(parseGoalExtract('{"title":"x"}')), null));

console.log(`\n全部通过：${passed} 项`);
