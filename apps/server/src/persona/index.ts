import type { Persona } from '@mirror/contracts';
import { PERSONAS } from './generated';
import { loadPersonaDetails, type PersonaDetail } from './loadPersona';

// 名字 → 人设。由 scripts/gen-personas.ts 从 character/<姓名>/ 生成（唯一事实源）。
// 前端 /rtc/offer 带 name，服务端据此取人设（选人机制）。
export { PERSONAS };

// 未知 / 未上线 → null（拒绝）。调用方回 4xx；不再静默兜底程书衡。
export function resolvePersona(name: string): Persona | null {
  const p = PERSONAS[name];
  if (!p || !p.available) return null;
  return p;
}

// 人物详情渐进式加载源（认知/经历/偏好）；不存在返回 []。
export function resolvePersonaDetails(name: string): PersonaDetail[] {
  return loadPersonaDetails(name);
}

// 名字 → 音色环境变量。实际 CosyVoice 音色 ID 由 scripts/design-voice.ts 声音设计 enroll 生成后填入 env。
// 每位陪伴者一个音色（2 男 2 女），不能共用一张嘴。
const VOICE_ENV_KEY: Record<string, string> = {
  '程书衡': 'COSYVOICE_VOICE',
  '沈知遥': 'COSYVOICE_VOICE_SZY',
  '沈砚秋': 'COSYVOICE_VOICE_SYQ',
  '苏明悦': 'COSYVOICE_VOICE_SMY',
};

// 取该陪伴者的实际音色 ID；没配的回落 fallback（默认程书衡音色），调用方负责 warn。
export function resolveVoice(name: string, fallback: string): string {
  const key = VOICE_ENV_KEY[name];
  if (!key) return fallback;
  return process.env[key] || fallback;
}
