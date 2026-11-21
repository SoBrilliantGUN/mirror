// 话题树：每个维度一个 JSON 文件（维度 → 子项 → 问题）。加载时给每个问题算 id = 维度_子项_哈希码，
// 哈希取问题文本的稳定短哈希——文件间解耦、可随意增话题、且 id 唯一稳定（供「已回答」去重）。
import 原生家庭 from './原生家庭.json';
import 教育 from './教育.json';
import 职业 from './职业.json';
import 关系 from './关系.json';
import 爱好 from './爱好.json';
import 重大事件 from './重大事件.json';
import 宠物 from './宠物.json';
import 旅行 from './旅行.json';
import 价值观 from './价值观.json';
import 健康 from './健康.json';

export type TopicQuestion = { id: string; text: string; material: string; generatedAt: string };
export type TopicAspect = { aspect: string; questions: TopicQuestion[] };
export type TopicDimension = { dimension: string; aspects: TopicAspect[] };

// 稳定短哈希（8 位十六进制）：纯函数、无随机，保证跨重启 id 一致。
function hash8(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

type RawDimension = { dimension: string; aspects: { aspect: string; questions: { text: string; material?: string; generatedAt?: string }[] }[] };

function buildDimension(raw: RawDimension): TopicDimension {
  return {
    dimension: raw.dimension,
    aspects: raw.aspects.map((a) => ({
      aspect: a.aspect,
      questions: a.questions.map((q) => ({
        id: `${raw.dimension}_${a.aspect}_${hash8(q.text)}`,
        text: q.text,
        material: q.material ?? '',
        generatedAt: q.generatedAt ?? '',
      })),
    })),
  };
}

export const TOPIC_DIMENSIONS: Record<string, TopicDimension> = {
  原生家庭: buildDimension(原生家庭),
  教育: buildDimension(教育),
  职业: buildDimension(职业),
  关系: buildDimension(关系),
  爱好: buildDimension(爱好),
  重大事件: buildDimension(重大事件),
  宠物: buildDimension(宠物),
  旅行: buildDimension(旅行),
  价值观: buildDimension(价值观),
  健康: buildDimension(健康),
};

// 按维度名取该维度的完整结构（语义上「先定维度、再取对应文件」）。
export function getTopicDimension(dimension: string): TopicDimension | undefined {
  return TOPIC_DIMENSIONS[dimension];
}

export function allTopicDimensions(): TopicDimension[] {
  return Object.values(TOPIC_DIMENSIONS);
}
