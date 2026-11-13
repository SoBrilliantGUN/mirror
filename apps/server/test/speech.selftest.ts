// L2 纯逻辑冒烟测试：情绪方向映射 + 指令组合。
// 运行：npm test
import { strict as assert } from 'node:assert';
import type { EmotionTag } from '@mirror/contracts';
import { EMOTION_DIRECTION, buildInstruction } from '../src/speech/emotionInstruction';
import { concatPcm, hasVoicePcm } from '../src/speech/backchannel';

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const ALL: EmotionTag[] = ['warm', 'tender', 'steady', 'natural'];

console.log('emotionInstruction');
ok('4 个方向都有非空指令', () => {
  for (const e of ALL) {
    assert.ok(EMOTION_DIRECTION[e] && EMOTION_DIRECTION[e].length > 0, `缺 ${e}`);
  }
});
ok('buildInstruction 叠加人设底色', () => {
  assert.ok(buildInstruction('steady', '语气沉稳、克制').includes('语气沉稳、克制'));
  assert.equal(buildInstruction('steady', undefined), EMOTION_DIRECTION.steady);
});

console.log('backchannel 纯函数');
ok('静音 → false', () => {
  const pcm = new Uint8Array(new Int16Array(320).buffer); // 320 个 0 采样
  assert.equal(hasVoicePcm(pcm), false);
});
ok('有声 → true', () => {
  const samples = new Int16Array(320).fill(16000);
  const pcm = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  assert.equal(hasVoicePcm(pcm), true);
});
ok('concatPcm 拼接', () => {
  const c = concatPcm([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
  assert.equal(c.length, 5);
  assert.deepEqual(Array.from(c), [1, 2, 3, 4, 5]);
});

console.log(`\n全部通过：${passed} 项`);
