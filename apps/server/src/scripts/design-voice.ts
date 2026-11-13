// 声音设计：用文字描述创建程书衡的男声（无需参考音频）。
// 用法：npx tsx apps/server/src/scripts/design-voice.ts
import { loadConfig, loadDotEnv } from '../config';

async function main() {
  loadDotEnv();
  const cfg = loadConfig();
  if (!cfg.dashscopeApiKey) {
    console.error('缺少 DASHSCOPE_API_KEY');
    process.exit(1);
  }

  const url = `${cfg.dashscopeBaseUrl}/api/v1/services/audio/tts/customization`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.dashscopeApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'voice-enrollment',
      input: {
        action: 'create_voice',
        target_model: 'cosyvoice-v3.5-plus',
        voice_prompt: '沉稳可靠的中年男性，音色低沉浑厚有磁性，语速平稳，说话明确、坚定、有力，像一个值得信赖的项目总监。',
        preview_text: '别急，我们先把事情一件件理清楚，一步一步来。',
        prefix: 'csh',
        language_hints: ['zh'],
      },
      parameters: { sample_rate: 24000, response_format: 'mp3' },
    }),
  });

  const body = await res.text();
  console.log('HTTP', res.status);
  console.log(body.slice(0, 2000));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
