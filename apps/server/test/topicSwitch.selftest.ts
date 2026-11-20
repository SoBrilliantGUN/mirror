// 纯逻辑冒烟测试：evaluateDisinterest（换话题触发）。
// 运行：npm test
import { strict as assert } from 'node:assert';
import { evaluateDisinterest, evaluatePerfunctory, AROUSAL_LOW, REPLY_SLOW_MS } from '../src/brain/topicSwitch';

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 便捷：低唤醒 + 慢回复 = 命中。
const hit = { arousal: AROUSAL_LOW - 0.1, latencyMs: REPLY_SLOW_MS + 1 };
const notSlow = { arousal: AROUSAL_LOW - 0.1, latencyMs: REPLY_SLOW_MS - 1 };
const notLow = { arousal: AROUSAL_LOW + 0.1, latencyMs: REPLY_SLOW_MS + 1 };

console.log('evaluateDisinterest');
ok('第 1 轮命中：streak=1，不换话题', () => {
  const r = evaluateDisinterest(hit.arousal, hit.latencyMs, 0);
  assert.equal(r.streak, 1);
  assert.equal(r.switchTopic, false);
});
ok('连续 3 轮命中：第 3 轮换话题', () => {
  const r1 = evaluateDisinterest(hit.arousal, hit.latencyMs, 0);
  const r2 = evaluateDisinterest(hit.arousal, hit.latencyMs, r1.streak);
  const r3 = evaluateDisinterest(hit.arousal, hit.latencyMs, r2.streak);
  assert.equal(r3.streak, 3);
  assert.equal(r3.switchTopic, true);
});
ok('单独低唤醒（回复快）→ 清零不触发', () => {
  const r = evaluateDisinterest(notSlow.arousal, notSlow.latencyMs, 2);
  assert.equal(r.streak, 0);
  assert.equal(r.switchTopic, false);
});
ok('单独慢回复（唤醒不低）→ 清零不触发', () => {
  const r = evaluateDisinterest(notLow.arousal, notLow.latencyMs, 2);
  assert.equal(r.streak, 0);
  assert.equal(r.switchTopic, false);
});
ok('中途一轮正常 → 计数清零', () => {
  const r1 = evaluateDisinterest(hit.arousal, hit.latencyMs, 0); // streak 1
  const r2 = evaluateDisinterest(notLow.arousal, notLow.latencyMs, r1.streak); // reset
  const r3 = evaluateDisinterest(hit.arousal, hit.latencyMs, r2.streak); // streak 1 again
  assert.equal(r3.streak, 1);
  assert.equal(r3.switchTopic, false);
});

console.log('evaluatePerfunctory');
ok('「嗯」算敷衍：streak=1，不换话题', () => {
  const r = evaluatePerfunctory('嗯', 0);
  assert.equal(r.streak, 1);
  assert.equal(r.switchTopic, false);
});
ok('「随便」「不知道」「就这样吧」都算敷衍', () => {
  assert.equal(evaluatePerfunctory('随便', 0).streak, 1);
  assert.equal(evaluatePerfunctory('不知道', 0).streak, 1);
  assert.equal(evaluatePerfunctory('就这样吧', 0).streak, 1);
});
ok('「对的对的」算敷衍', () => {
  assert.equal(evaluatePerfunctory('对的对的', 0).streak, 1);
});
ok('连续 2 轮敷衍 → 换话题', () => {
  const r1 = evaluatePerfunctory('嗯', 0);
  const r2 = evaluatePerfunctory('哦哦', r1.streak);
  assert.equal(r2.streak, 2);
  assert.equal(r2.switchTopic, true);
});
ok('「准备面试」不算敷衍 → 清零', () => {
  const r = evaluatePerfunctory('准备面试', 2);
  assert.equal(r.streak, 0);
  assert.equal(r.switchTopic, false);
});
ok('「我是医生」不算敷衍（有实质内容字）', () => {
  assert.equal(evaluatePerfunctory('我是医生', 0).streak, 0);
});
ok('空文本（纯哭/笑）不算敷衍 → 清零', () => {
  const r = evaluatePerfunctory('', 1);
  assert.equal(r.streak, 0);
  assert.equal(r.switchTopic, false);
});

console.log(`\n全部通过：${passed} 项`);
