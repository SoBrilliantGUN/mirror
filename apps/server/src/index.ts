export { turn, planTurn, type TurnDeps, type TurnInput, type TurnPlan, type TurnResultWithMood } from './brain/turn';
export { decideMode, decideStance, decideVoiceConfig, decideEmotion } from './brain/decide';
export { ModeTracker } from './brain/modeTracker';
export { updateMood } from './brain/mood';
export { scoreAffect, parseAffect } from './brain/score';
export { generateText, splitSentences, streamSegments, streamMessages } from './brain/generate';
export { DeepSeek } from './llm/deepseek';
export { createEmbedder, type Embedder } from './llm/embedding';
export { createMemoryStore, rrfFuse } from './store/memory';
export { classifyMemory, parseMemoryType } from './brain/memoryClassifier';
export { reflectOnMemory, parseReflection } from './brain/reflect';
export { classifySegmentEmotion, parseEmotionTag } from './brain/segmentEmotion';
export { BackchannelEngine, BACKCHANNEL_PHRASES, BACKCHANNEL_INSTRUCTION, concatPcm, hasVoicePcm } from './speech/backchannel';
export { buildMemoryTools, type MemoryToolRuntime } from './brain/memoryTools';
export {
  assembleTurn,
  mergeRecalled,
  type AssembleDeps,
  type AssembleInput,
  type AssemblePlan,
  type PrefetchCache,
} from './brain/assemble';
export { consolidateTurn, prefetchNextTurn, createPrefetchCache, parseExtraction } from './brain/consolidate';
export {
  estimateTokens,
  formatMemoryBlock,
  formatStateBlock,
  formatHistory,
  buildLayeredUserPrompt,
  buildLayeredPrompts,
  type HistoryEntry,
} from './brain/context';
export {
  compressHistory,
  createSummarizer,
  estimateHistoryTokens,
  historyToText,
  pickLevel,
  DEFAULT_COMPRESS_CONFIG,
  type HistorySummarizer,
  type CompressConfig,
} from './brain/compress';
export { PERSONAS, resolvePersona, resolvePersonaDetails, resolveVoice } from './persona';
export {
  loadPersonaDetails,
  parseDetail,
  cosine,
  formatPersonaBlock,
  createPersonaMatcher,
  type PersonaDetail,
  type PersonaMatcher,
} from './persona/loadPersona';
export { NoopSafetyGuard, EmptyContextProvider, neutralAcoustic } from './stubs';
export { SafetyGuard, parseSafetyJson, keywordScan, resolveDependence, type SafetyGuardOptions } from './brain/safety';
export { CRISIS_RESOURCES, formatCrisisResources, type CrisisResource } from './brain/crisisResources';
export { loadConfig, loadDotEnv, type Config } from './config';
export { synthesize, DEFAULT_MODEL } from './speech/cosyvoice';
export { EMOTION_DIRECTION, buildInstruction, tailHint } from './speech/emotionInstruction';
export * from '@mirror/contracts';
