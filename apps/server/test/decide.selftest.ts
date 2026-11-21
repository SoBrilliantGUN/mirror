// 纯逻辑冒烟测试：decideMode / stance / voiceConfig / fallbackEmotion / ModeTracker / updateMood / parseAffect。
// 运行：npm test
import { strict as assert } from 'node:assert';
import type { Affect, SafetyAction } from '@mirror/contracts';
import { parseAffect } from '../src/brain/decide';
import { decideMode, decideStance, decideEmotion, updateMood } from '../src/brain/emotion';
import { ModeTracker } from '../src/brain/modeTracker';
import { parseEmotionTag } from '../src/brain/segmentEmotion';

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const affect = (valence: number, arousal: number, dominance: number, incongruence = false): Affect => ({
  valence,
  arousal,
  dominance,
  incongruence,
});
const safety = (level: 0 | 1 | 2): SafetyAction => ({ level, action: level ? 'refer' : 'none' });

console.log('decideMode');
ok('安全红线命中 → careful', () => {
  assert.equal(decideMode(affect(0.5, 0.1, 0.5), safety(1)), 'careful');
});
ok('效价 < -0.25 → careful', () => {
  assert.equal(decideMode(affect(-0.5, 0.1, 0.3), safety(0)), 'careful');
});
ok('效价<0 且 唤醒>0.4 且 支配<0 → careful', () => {
  assert.equal(decideMode(affect(-0.1, 0.8, -0.3), safety(0)), 'careful');
});
ok('情感不协调 → careful', () => {
  assert.equal(decideMode(affect(0.1, 0.2, 0.3, true), safety(0)), 'careful');
});
ok('平稳 → casual', () => {
  assert.equal(decideMode(affect(0.3, 0.2, 0.4), safety(0)), 'casual');
});

console.log('decideStance');
ok('支配 < 0 → accompany', () => {
  assert.equal(decideStance(affect(0, 0, -0.1)), 'accompany');
});
ok('支配 >= 0 → guide', () => {
  assert.equal(decideStance(affect(0, 0, 0)), 'guide');
});

console.log('decideEmotion（通用镜像）');
ok('开心 → warm', () => {
  assert.equal(decideEmotion(affect(0.5, 0.2, 0.3)), 'warm');
});
ok('悲伤 → tender', () => {
  assert.equal(decideEmotion(affect(-0.5, 0.2, -0.3)), 'tender');
});
ok('激动 → steady', () => {
  assert.equal(decideEmotion(affect(-0.5, 0.8, 0)), 'steady');
});
ok('平常 → natural', () => {
  assert.equal(decideEmotion(affect(0.1, 0.1, 0.1)), 'natural');
});

console.log('ModeTracker（防抖）');
ok('一轮 careful 立即进入，连续 2 轮平稳才退出', () => {
  const t = new ModeTracker();
  assert.equal(t.next(affect(-0.5, 0, 0), safety(0)), 'careful'); // 进入
  assert.equal(t.next(affect(0.5, 0, 0), safety(0)), 'careful'); // 第 1 轮平稳，仍 careful
  assert.equal(t.next(affect(0.5, 0, 0), safety(0)), 'casual'); // 第 2 轮平稳，退出
});

console.log('updateMood（EMA）');
ok('首轮 = α·affect，α=0.6', () => {
  const m = updateMood(null, affect(1, 0, 0));
  assert.ok(Math.abs(m.valence - 0.6) < 1e-9);
});

console.log('parseAffect（容错）');
ok('标准 JSON', () => {
  const a = parseAffect('{"valence":-0.5,"arousal":0.8,"dominance":-1,"incongruence":true}');
  assert.equal(a.valence, -0.5);
  assert.equal(a.incongruence, true);
});
ok('包 markdown 代码块也能解析', () => {
  const a = parseAffect('```json\n{"valence":0.1,"arousal":0.2,"dominance":0.3,"incongruence":false}\n```');
  assert.equal(a.dominance, 0.3);
});

console.log('parseEmotionTag（逐句情绪标签解析）');
ok('标准标签 → 返回', () => {
  assert.equal(parseEmotionTag('tender'), 'tender');
});
ok('带杂音也能抽到第一个标签', () => {
  assert.equal(parseEmotionTag('这句应该用 warm 语气'), 'warm');
});
ok('非法 → null', () => assert.equal(parseEmotionTag('随便'), null));

console.log(`\n全部通过：${passed} 项`);
