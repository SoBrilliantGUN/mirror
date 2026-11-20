// 纯逻辑冒烟测试：streamTurnSpeech（逐句流水线：流式生成 → 切句 → 逐句 TTS + AWAITS 提取 + 打断中止）。
// 用 mock llm / tts / gate / obs 驱动，不碰真实网络，验证从 session.ts 抽出后行为不变。
import { strict as assert } from 'node:assert';
import { streamTurnSpeech, type StreamTurnSpeechDeps } from '../src/speech/speakPipeline';
import { GenerationGate } from '../src/brain/generationGate';

let passed = 0;
function ok(name: string, fn: () => Promise<void> | void) {
  return (async () => {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  })();
}

// mock LLM：stream 吐原始文本（由 streamMessages 切句），chat 固定回 'warm'（供逐句情绪分类）。
function fakeLlm(raw: string) {
  return {
    async *stream() { yield raw; },
    async chat() { return 'warm'; },
    async *streamWithTools() {},
  } as any;
}

const fakeObs = {
  span: async (_name: string, fn: () => Promise<unknown>, _meta?: unknown) => fn(),
  score: () => {},
} as any;

function baseDeps(overrides: Partial<StreamTurnSpeechDeps> = {}): StreamTurnSpeechDeps {
  const gate = new GenerationGate();
  const { gen, signal } = gate.begin();
  return {
    llm: fakeLlm(''),
    generateModel: 'deepseek-chat',
    messages: [{ role: 'user', content: 'x' }],
    baseEmotion: 'natural',
    voice: 'v',
    voiceTint: '',
    rate: 1.0,
    cosyvoiceModel: 'cosy',
    dashscopeWsUrl: 'ws://x',
    dashscopeApiKey: 'k',
    bochaApiKey: '',
    bochaBaseUrl: '',
    searchEnabled: false,
    gate,
    gen,
    signal,
    tts: { synthesize: async () => {} } as any,
    pushAgentPcm: () => {},
    sleep: async () => {},
    tStart: Date.now(),
    obs: fakeObs,
    ...overrides,
  };
}

async function run() {
  console.log('streamTurnSpeech（非搜索路径）');
  await ok('多句流式 → 逐句合成 + 拼接 + AWAITS 提取', async () => {
    const texts: string[] = [];
    const deps = baseDeps({
      llm: fakeLlm('你好呀。今天怎么样？[[AWAITS:1]]'),
      tts: { synthesize: async (p: any) => { texts.push(p.text); } } as any,
    });
    const r = await streamTurnSpeech(deps);
    assert.equal(r.fullText, '你好呀。今天怎么样？');
    assert.equal(r.awaitsResponse, true);
    assert.deepEqual(texts, ['你好呀。', '今天怎么样？']);
    assert.ok(r.firstTokenMs >= 0);
  });

  await ok('纯陈述结尾 [[AWAITS:0]] → awaits=false', async () => {
    const deps = baseDeps({ llm: fakeLlm('我在这儿。[[AWAITS:0]]') });
    const r = await streamTurnSpeech(deps);
    assert.equal(r.awaitsResponse, false);
  });

  await ok('模型漏打 AWAITS 标签 → awaits=null（回退正则）', async () => {
    const deps = baseDeps({ llm: fakeLlm('我在听。') });
    const r = await streamTurnSpeech(deps);
    assert.equal(r.awaitsResponse, null);
  });

  await ok('空流 → 空正文', async () => {
    const deps = baseDeps({ llm: { async *stream() {}, async chat() { return 'warm'; }, async *streamWithTools() {} } as any });
    const r = await streamTurnSpeech(deps);
    assert.equal(r.fullText, '');
  });

  console.log('streamTurnSpeech（打断中止）');
  await ok('gate 失效 → 提前停、后句不合成', async () => {
    const gate = new GenerationGate();
    const { gen, signal } = gate.begin();
    const texts: string[] = [];
    const deps = baseDeps({
      llm: fakeLlm('第一句。第二句。'),
      gate,
      gen,
      signal,
      tts: { synthesize: async (p: any) => { texts.push(p.text); gate.invalidate(); } } as any,
    });
    const r = await streamTurnSpeech(deps);
    assert.equal(r.fullText, '第一句。');
    assert.deepEqual(texts, ['第一句。']);
  });

  console.log(`\n全部通过：${passed} 项`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
