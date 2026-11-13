// L0 副语言特征提取冒烟测试：合成正弦/静音喂进去，断言 z-score 方向正确。
// 运行：npm test
import { strict as assert } from 'node:assert';
import { AcousticFeatureExtractor } from '../src/speech/acousticFeatures';

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const SR = 16000;

// 合成 int16 PCM 字节流（16kHz 单声道）。
function sine(freq: number, ms: number, amp = 0.5): Uint8Array {
  const n = Math.floor((SR * ms) / 1000);
  const i16 = new Int16Array(n);
  for (let i = 0; i < n; i++) i16[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / SR) * amp * 32767);
  return new Uint8Array(i16.buffer);
}

function silence(ms: number): Uint8Array {
  const n = Math.floor((SR * ms) / 1000);
  return new Uint8Array(new Int16Array(n).buffer);
}

console.log('acousticFeatures');
ok('冷启动（首回合）z 全 0', () => {
  const ex = new AcousticFeatureExtractor();
  ex.push(sine(200, 500));
  assert.deepEqual(ex.finalize('你好'), { rateZ: 0, pitchZ: 0, loudnessZ: 0, pauseZ: 0 });
});

ok('音高升高 → pitchZ > 0（相对基线）', () => {
  const ex = new AcousticFeatureExtractor();
  ex.push(sine(180, 500));
  ex.finalize('一');
  ex.push(sine(360, 500));
  const a = ex.finalize('二');
  assert.ok(a.pitchZ > 0, `期望 pitchZ>0，实得 ${a.pitchZ}`);
});

ok('静音 → loudnessZ < 0 且 pauseZ > 0（相对正弦基线）', () => {
  const ex = new AcousticFeatureExtractor();
  ex.push(sine(200, 500));
  ex.finalize('一');
  ex.push(silence(500));
  const a = ex.finalize('');
  assert.ok(a.loudnessZ < 0, `期望 loudnessZ<0，实得 ${a.loudnessZ}`);
  assert.ok(a.pauseZ > 0, `期望 pauseZ>0，实得 ${a.pauseZ}`);
});

console.log('detectGender（会话级 F0 性别判定）');
ok('低基频正弦 → 判男', () => {
  const ex = new AcousticFeatureExtractor();
  ex.push(sine(120, 2000)); // 2s 男声基频（~120Hz）
  assert.equal(ex.detectGender(), '男');
});
ok('高基频正弦 → 判女', () => {
  const ex = new AcousticFeatureExtractor();
  ex.push(sine(220, 2000)); // 2s 女声基频（~220Hz）
  assert.equal(ex.detectGender(), '女');
});
ok('样本不足 → null', () => {
  const ex = new AcousticFeatureExtractor();
  ex.push(sine(200, 400)); // <60 有声帧
  assert.equal(ex.detectGender(), null);
});

console.log(`\n全部通过：${passed} 项`);
