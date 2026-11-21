// 声音设计：为 4 位陪伴者各创建一个 CosyVoice 音色（无需参考音频）。
// 用法：npx tsx apps/server/src/scripts/enroll-voices.ts
// 输出：每人返回中文 + 英文各一个 voice id（vd-xxx），填进 .env 的对应变量。
//
// 中文音色（language_hints:['zh']）→ COSYVOICE_VOICE / _SZY / _SYQ / _SMY
// 英文音色（language_hints:['en']）→ COSYVOICE_VOICE_EN / _SZY_EN / _SYQ_EN / _SMY_EN
// 英文模式（练英语）走英文音色，说英文无口音。
import { loadConfig, loadDotEnv } from '../config';

type Spec = { name: string; prefix: string; voicePrompt: string; previewText: string; lang: string; envKey: string };

// —— 中文音色（沿用原 3 位；程书衡的中文音色若已建过可跳过）——
const SPECS_ZH: Spec[] = [
  {
    name: '沈知遥（女 · 数据分析师 · 中文）',
    prefix: 'szy',
    voicePrompt: '平静理性、清晰准确的年轻女性声音，语速平稳、用词精确，带一点安静的钻研劲，不夸张不煽情，像一位专注严谨的研究者。',
    previewText: '这里面真正的原因，可能不是你想的那样。如果换个角度看，答案会清楚很多。',
    lang: 'zh',
    envKey: 'COSYVOICE_VOICE_SZY',
  },
  {
    name: '沈砚秋（男 · 心理咨询师 · 中文）',
    prefix: 'syq',
    voicePrompt: '温柔克制、低沉轻柔的男性声音，语速缓慢、句间留白，带一点低低的安抚感，像一位安静深邃的心理咨询师。',
    previewText: '问出这句话，本身就是很好的开始。听起来，你怕的不是选错，是怕选错了就回不了头。',
    lang: 'zh',
    envKey: 'COSYVOICE_VOICE_SYQ',
  },
  {
    name: '苏明悦（女 · 时尚博主 · 中文）',
    prefix: 'smy',
    voicePrompt: '明亮柔软、带一点上扬和笑意的女性声音，语速轻快、生动有感染力，亲切又有活力，像一位会来事的时尚博主。',
    previewText: '我懂那种空落落的感觉。你不需要一直那么发光，也值得被好好喜欢呀。',
    lang: 'zh',
    envKey: 'COSYVOICE_VOICE_SMY',
  },
];

// —— 英文音色（练英语用，language_hints:['en']）——
const SPECS_EN: Spec[] = [
  {
    name: '程书衡（男 · 英文）',
    prefix: 'csh_en',
    voicePrompt: 'A calm, steady, warm male voice. Speaks natural, conversational English at a measured pace, with a grounded, reassuring presence.',
    previewText: "Hey, I'm here. Tell me what's been going on.",
    lang: 'en',
    envKey: 'COSYVOICE_VOICE_EN',
  },
  {
    name: '沈知遥（女 · 英文）',
    prefix: 'szy_en',
    voicePrompt: 'A calm, clear, precise young female voice. Speaks natural English with a focused, thoughtful, analytical tone, unhurried and articulate.',
    previewText: "The real reason might not be what you think. If you look at it from another angle, it gets much clearer.",
    lang: 'en',
    envKey: 'COSYVOICE_VOICE_SZY_EN',
  },
  {
    name: '沈砚秋（男 · 英文）',
    prefix: 'syq_en',
    voicePrompt: 'A gentle, low, soothing male voice. Speaks slowly with soft pauses, like a quiet, thoughtful therapist, warm and unhurried.',
    previewText: "Asking that question is already a good start. It sounds like you're afraid of making the wrong choice.",
    lang: 'en',
    envKey: 'COSYVOICE_VOICE_SYQ_EN',
  },
  {
    name: '苏明悦（女 · 英文）',
    prefix: 'smy_en',
    voicePrompt: 'A bright, warm, lively female voice with a slight upward inflection. Speaks English in a friendly, energetic, approachable way.',
    previewText: "I get that empty feeling. You don't have to shine all the time, and you still deserve to be loved.",
    lang: 'en',
    envKey: 'COSYVOICE_VOICE_SMY_EN',
  },
];

async function enrollOne(cfg: ReturnType<typeof loadConfig>, spec: Spec): Promise<void> {
  console.log(`\n===== 建模 ${spec.name}（prefix=${spec.prefix}，lang=${spec.lang}）=====`);
  const url = `${cfg.speech.dashscopeBaseUrl}/api/v1/services/audio/tts/customization`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.speech.dashscopeApiKey}`,
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
        language_hints: [spec.lang],
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
      console.log('  填进 .env：', `${spec.envKey}=${parsed.output.voice_id}`);
    } else {
      console.log(body.slice(0, 500));
    }
  } catch {
    console.log(body.slice(0, 500));
  }
}

async function main() {
  loadDotEnv();
  const cfg = loadConfig();
  if (!cfg.speech.dashscopeApiKey) {
    console.error('缺少 DASHSCOPE_API_KEY。请在 .env 里设置。');
    process.exit(1);
  }

  console.log('========== 中文音色 ==========');
  for (const spec of SPECS_ZH) await enrollOne(cfg, spec);
  console.log('\n========== 英文音色 ==========');
  for (const spec of SPECS_EN) await enrollOne(cfg, spec);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
