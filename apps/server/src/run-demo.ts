// 冒烟：跑一轮真实 turn（需要 DEEPSEEK_API_KEY）。
// 用法：DEEPSEEK_API_KEY=sk-xxx npx tsx apps/server/src/run-demo.ts
import { loadConfig, loadDotEnv } from './config';
import { DeepSeek } from './llm/deepseek';
import { PERSONAS } from './persona/generated';
import { NoopSafetyGuard, EmptyContextProvider, neutralAcoustic } from './stubs';
import { ModeTracker } from './brain/modeTracker';
import { CoachTracker } from './brain/coach';
import { turn } from './brain/turn';
import type { MoodState } from '@mirror/contracts';

async function main() {
  loadDotEnv();
  const cfg = loadConfig();
  if (!cfg.deepseekApiKey) {
    console.error('缺少 DEEPSEEK_API_KEY。请在环境变量里设置，或复制 .env.example 为 .env。');
    process.exit(1);
  }

  const llm = new DeepSeek({ apiKey: cfg.deepseekApiKey, baseUrl: cfg.deepseekBaseUrl });
  const context = await new EmptyContextProvider().get('demo-user');

  // 会话级状态（L5）：每会话一个 tracker + mood；教练交互框架 tracker 同理。
  const tracker = new ModeTracker();
  const coachTracker = new CoachTracker();
  let mood: MoodState | null = context.mood;

  const sample = '我手头事太多了，脑子快炸了。';
  const result = await turn(
    {
      llm,
      scoreModel: cfg.scoreModel,
      generateModel: cfg.generateModel,
      safetyGuard: new NoopSafetyGuard(),
      tracker,
      coachTracker,
      mood,
    },
    { text: sample, acoustic: neutralAcoustic(), persona: PERSONAS['程书衡'], context },
  );
  mood = result.mood;

  console.log('对方说：', sample);
  console.log('打分：', result.affect);
  console.log('mode：', result.mode, '| stance：', result.stance, '| emotion：', result.emotion);
  console.log('voiceConfig：', result.voiceConfig);
  console.log('程书衡：');
  for (const seg of result.segments) {
    console.log(`  ${seg}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
