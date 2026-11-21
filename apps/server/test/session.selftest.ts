// CallSession turn-taking 冒烟 harness：用 mock rtc/tts/asr/llm/stores + 极短计时，
// 驱动真实 handleOffer 装配 + 打断（doBargeIn）路径，验证不碰真实网络/设备也能跑通。
// 这是「拆主动发话/打断状态机」前补的 canary——后续重构后重跑这里若仍绿，行为没变。
import { strict as assert } from 'node:assert';
import { CallSession } from '../src/session';
import type { RtcCallbacks } from '../src/rtc/webrtc';

let passed = 0;
function ok(name: string, fn: () => Promise<void>) {
  return (async () => {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  })();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeCfg() {
  return {
    databaseUrl: '', userName: '', contextMaxTokens: 64000, memoryRecallTopK: 5,
    llm: {
      deepseekApiKey: '', deepseekBaseUrl: '', scoreModel: 'deepseek-chat', generateModel: 'deepseek-chat',
      safetyModel: 'qwen-turbo', safetyBaseUrl: '', embeddingApiKey: '', embeddingBaseUrl: '', embeddingModel: 'text-embedding-v3', embeddingDim: 1024,
    },
    speech: {
      dashscopeApiKey: '', dashscopeBaseUrl: '', dashscopeWsUrl: 'ws://localhost:1', dashscopeWsFallbackUrl: '', dashscopeOfficialApiKey: '',
      cosyvoiceModel: '', cosyvoiceVoice: '', paraformerModel: '',
    },
    nls: { enabled: false, appKey: '', token: '', akId: '', akSecret: '' },
    search: { bochaApiKey: '', bochaBaseUrl: '' },
    obs: { langfusePublicKey: '', langfuseSecretKey: '', langfuseBaseUrl: '' },
    ice: { hostAddress: '', portRange: [50000, 50100] },
  } as any;
}

const mockObs = {
  trace: async (_n: string, _m: unknown, fn: () => Promise<unknown>) => fn(),
  span: async (_n: string, fn: () => Promise<unknown>) => fn(),
  score: () => {}, event: () => {}, setOutput: () => {}, setSession: () => {},
} as any;

// 建一个完全 mock 的 CallSession，返回可驱动回调的句柄。
function makeSession() {
  const rtcCalls: string[] = [];
  let cbs: RtcCallbacks = null!;
  let agentAudibleOn: (() => void) | null = null;

  const rtc = {
    handleOffer: async () => 'fake-sdp',
    whenReady: async () => {},
    pushAgentPcm: () => {},
    sendControl: (o: any) => { rtcCalls.push('sendControl:' + o.type); },
    end: () => { rtcCalls.push('end'); },
    clear: () => { rtcCalls.push('clear'); },
    close: () => { rtcCalls.push('close'); },
  };
  const rtcFactory = (c: RtcCallbacks) => { cbs = c; return rtc as any; };
  const asrFactory = () => ({ start: async () => {}, sendAudio: () => {}, finish: () => {}, close: () => {} } as any);
  const ttsFactory = (_ep: any, _push: any, onStart: () => void, _sleep: any) => {
    agentAudibleOn = onStart;
    return { synthesize: async () => {} } as any;
  };
  const greetingClipsFactory = () => ({ ensure: async () => {}, pick: () => null } as any);

  const session = new CallSession({
    cfg: makeCfg(),
    llm: { chat: async () => 'x', stream: async function* () { yield '好。'; }, streamWithTools: async function* () {} } as any,
    safetyLlm: { chat: async () => '' } as any,
    embedder: { embed: async (t: string[]) => t.map(() => []) } as any,
    memory: { recall: async () => ({ constraint: [], profile: [], fact: [], preference: [], episodic: [] }), search: async () => [], write: async () => ({}), getCoverage: async () => [], listActive: async () => [], listAnchored: async () => [], listAll: async () => [], update: async () => null, remove: async () => 0, retract: async () => 0, retractById: async () => 0, prune: async () => 0 } as any,
    askedQuestions: { record: async () => {}, recent: async () => [] } as any,
    conversationSummaries: { save: async () => {}, recent: async () => [] } as any,
    selfAdded: { listActive: async () => [], write: async () => ({}), touch: async () => {}, archiveStale: async () => 0 } as any,
    goals: { listActive: async () => [], create: async () => ({}), update: async () => null, complete: async () => {}, archive: async () => {}, touch: async () => {} } as any,
    identity: { list: async () => [], upsert: async () => {} } as any,
    sessions: { start: async () => 'sid', end: async () => {}, signals: async () => ({ recentCalls7d: 0, currentCallMinutes: 0, lastGapMinutes: null }) } as any,
    transcript: { insert: async () => {}, list: async () => [] } as any,
    topics: { recordEngagement: async () => {}, topicSessionStats: async () => [], hasLibraryTopic: async () => false, saveLibrary: async () => {}, listLibrary: async () => [] } as any,
    obs: mockObs,
    timeAware: { currentTimeContext: () => ({}), upcomingDates: async () => [], scheduleCareHint: () => '' } as any,
    summarizer: async () => '',
    memoryBudget: 1000,
    historyBudget: 1000,
    userId: 'u',
    rtcFactory,
    asrFactory,
    ttsFactory,
    greetingClipsFactory,
    timing: { interruptGraceMs: 5, followupMs: 5, coachSilentMs: 5, coachCloseMs: 5, reanswerMs: 5, reanswerLimit: 1, vocalDebounceMs: 5, vocalMaxHoldMs: 5, vocalCooldownMs: 5, noReplyLimit: 1 },
  });

  return { session, rtcCalls, getCbs: () => cbs, setAgentAudible: () => agentAudibleOn?.() };
}

async function run() {
  console.log('CallSession turn-taking 冒烟（mock harness）');

  await ok('handleOffer 用 mock 装配成功，进入通话态', async () => {
    const { session } = makeSession();
    const r = await session.handleOffer({ sdp: 'fake', name: '程书衡' });
    assert.ok('sdp' in (r as any));
    assert.equal(session.isInCall, true);
  });

  await ok('打断（agentAudible）→ 宽限后 doBargeIn → rtc.clear', async () => {
    const { session, rtcCalls, getCbs, setAgentAudible } = makeSession();
    await session.handleOffer({ sdp: 'fake', name: '程书衡' });
    setAgentAudible();           // 模拟 TTS 开始播放，置 agentAudible=true
    getCbs().onInterrupt();      // 触发 handleBargeIn('rtc')
    await sleep(60);             // 等 interruptGraceMs(5ms) 过后 doBargeIn 真正触发
    assert.ok(rtcCalls.includes('clear'), '应调用 rtc.clear：' + JSON.stringify(rtcCalls));
  });

  await ok('打断在 agent 没说话时被忽略（不 clear）', async () => {
    const { session, rtcCalls, getCbs } = makeSession();
    await session.handleOffer({ sdp: 'fake', name: '程书衡' });
    getCbs().onInterrupt();      // agentAudible=false → handleBargeIn 直接 return
    await sleep(60);
    assert.ok(!rtcCalls.includes('clear'), '不该 clear：' + JSON.stringify(rtcCalls));
  });

  console.log(`\n全部通过：${passed} 项`);
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
