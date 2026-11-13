// 冒烟：验证 CosyVoice 实时 TTS 的 WebSocket 流式。
// 用法：npm run rt-tts
import { writeFileSync } from 'node:fs';
import { loadConfig, loadDotEnv } from '../config';
import { streamTTS } from '../speech/cosyvoiceRealtime';
import { buildInstruction, EMOTION_PROSODY } from '../speech/emotionInstruction';
import { PERSONAS } from '../persona/generated';

async function main() {
  loadDotEnv();
  const cfg = loadConfig();
  if (!cfg.dashscopeApiKey) {
    console.error('缺 DASHSCOPE_API_KEY');
    process.exit(1);
  }
  if (!cfg.cosyvoiceVoice) {
    console.error('缺 COSYVOICE_VOICE');
    process.exit(1);
  }

  const text = '别急，我们先把事情一件件理清楚。';
  const emotion = 'steady' as const;
  const instruction = buildInstruction(emotion, PERSONAS['程书衡'].voiceTint);
  const prosody = EMOTION_PROSODY[emotion];

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of streamTTS({
    wsUrl: cfg.dashscopeWsUrl,
    apiKey: cfg.dashscopeApiKey,
    model: cfg.cosyvoiceModel,
    voice: cfg.cosyvoiceVoice,
    instruction,
    text,
    rate: prosody.rate,
    pitch: prosody.pitch,
  })) {
    chunks.push(chunk);
    bytes += chunk.length;
  }
  console.log('收到 PCM：', bytes, '字节 |', chunks.length, 'chunks');
  if (chunks.length) {
    writeFileSync('samples/realtime_test.pcm', Buffer.concat(chunks.map((c) => Buffer.from(c))));
    console.log('已存 samples/realtime_test.pcm');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
