// 声音设计：为沈知遥 / 沈砚秋 / 苏明悦 各创建一个 CosyVoice 音色（无需参考音频）。
// 用法：npx tsx apps/server/src/scripts/enroll-voices.ts
// 输出：每人返回一个 voice id（vd-xxx），把它填进 .env 的 COSYVOICE_VOICE_SZY / _SYQ / _SMY。
import { loadConfig, loadDotEnv } from '../config';

// 每位要建模的陪伴者：voice_prompt 描述音色，preview_text 是 enroll 时的样句，prefix 是音色 ID 前缀。
const SPECS: { name: string; prefix: string; voicePrompt: string; previewText: string }[] = [
  {
    name: '沈知遥（女 · 数据分析师）',
    prefix: 'szy',
    voicePrompt:
      '平静理性、清晰准确的年轻女性声音，语速平稳、用词精确，带一点安静的钻研劲，不夸张不煽情，像一位专注严谨的研究者。',
    previewText: '这里面真正的原因，可能不是你想的那样。如果换个角度看，答案会清楚很多。',
  },
  {
    name: '沈砚秋（男 · 心理咨询师）',
    prefix: 'syq',
    voicePrompt:
      '温柔克制、低沉轻柔的男性声音，语速缓慢、句间留白，带一点低低的安抚感，像一位安静深邃的心理咨询师。',
    previewText: '问出这句话，本身就是很好的开始。听起来，你怕的不是选错，是怕选错了就回不了头。',
  },
  {
    name: '苏明悦（女 · 时尚博主）',
    prefix: 'smy',
    voicePrompt:
      '明亮柔软、带一点上扬和笑意的女性声音，语速轻快、生动有感染力，亲切又有活力，像一位会来事的时尚博主。',
    previewText: '我懂那种空落落的感觉。你不需要一直那么发光，也值得被好好喜欢呀。',
  },
];

// prefix → .env 变量名
const ENV_KEY: Record<string, string> = {
  szy: 'COSYVOICE_VOICE_SZY',
  syq: 'COSYVOICE_VOICE_SYQ',
  smy: 'COSYVOICE_VOICE_SMY',
};

async function main() {
  loadDotEnv();
  const cfg = loadConfig();
  if (!cfg.dashscopeApiKey) {
    console.error('缺少 DASHSCOPE_API_KEY。请在 .env 里设置。');
    process.exit(1);
  }

  const url = `${cfg.dashscopeBaseUrl}/api/v1/services/audio/tts/customization`;
  for (const spec of SPECS) {
    console.log(`\n===== 建模 ${spec.name}（prefix=${spec.prefix}）=====`);
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
          voice_prompt: spec.voicePrompt,
          preview_text: spec.previewText,
          prefix: spec.prefix,
          language_hints: ['zh'],
        },
        parameters: { sample_rate: 24000, response_format: 'mp3' },
      }),
    });

    const body = await res.text();
    console.log('HTTP', res.status);
    try {
      const parsed = JSON.parse(body) as { output?: { voice_id?: string } };
      if (parsed.output?.voice_id) {
        console.log('✓ 音色已创建：', parsed.output.voice_id);
        console.log('  填进 .env：', `${ENV_KEY[spec.prefix]}=${parsed.output.voice_id}`);
      } else {
        console.log(body.slice(0, 500));
      }
    } catch {
      console.log(body.slice(0, 500));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
