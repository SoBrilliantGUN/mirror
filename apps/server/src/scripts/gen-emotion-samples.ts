// 离线验真：同一句文本 × 4 个情绪方向，各生成一段 mp3 到 samples/ 目录。
// 用法：npm run samples（需 .env 配好 DASHSCOPE_API_KEY 和 COSYVOICE_VOICE）
import { mkdirSync, writeFileSync } from 'node:fs';
import type { EmotionTag } from '@mirror/contracts';
import { loadConfig, loadDotEnv } from '../config';
import { synthesize } from '../speech/cosyvoice';
import { buildInstruction, EMOTION_PROSODY } from '../speech/emotionInstruction';
import { PERSONAS } from '../persona/generated';

const SAMPLE_TEXT = '别急，我们先把事情一件件理清楚。';
const ALL: EmotionTag[] = ['warm', 'tender', 'steady', 'natural'];
const requested = process.argv.slice(2) as EmotionTag[];
const EMOTIONS: EmotionTag[] = requested.length ? requested : ALL;

async function main() {
  loadDotEnv();
  const cfg = loadConfig();
  if (!cfg.dashscopeApiKey) {
    console.error('缺少 DASHSCOPE_API_KEY');
    process.exit(1);
  }
  if (!cfg.cosyvoiceVoice) {
    console.error('缺少 COSYVOICE_VOICE（音色 ID）');
    process.exit(1);
  }

  mkdirSync('samples', { recursive: true });
  for (const emotion of EMOTIONS) {
    const instruction = buildInstruction(emotion, PERSONAS['程书衡'].voiceTint);
    const prosody = EMOTION_PROSODY[emotion];
    const audio = await synthesize(cfg.dashscopeApiKey, SAMPLE_TEXT, instruction, {
      model: cfg.cosyvoiceModel,
      voice: cfg.cosyvoiceVoice,
      rate: prosody.rate,
      pitch: prosody.pitch,
    });
    const file = `samples/${emotion}.mp3`;
    writeFileSync(file, Buffer.from(audio));
    console.log(`✓ ${emotion.padEnd(7)} → ${file}`);
  }
  console.log('\n全部生成完毕，去 samples/ 目录逐个听。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
