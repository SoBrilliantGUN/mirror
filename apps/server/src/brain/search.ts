import type { Tool } from '../llm/deepseek';

// 联网搜索工具：描述里写清触发条件，让模型自己判断「这轮要不要搜」。
export const SEARCH_TOOL: Tool = {
  type: 'function',
  function: {
    name: 'search_web',
    description:
      '调用它联网搜索，获取实时、准确的信息。当对方问你一个你不确定或不认识的词、新梗、冷门专名/地名是什么，或纠正了你关于某词/事实的说法，或问时效性/实时性的东西（今天天气、最近新闻、当前时间、行情、最新进展等）时，你必须调用这个工具拿到真实结果再回答——严禁凭空编造、严禁用陈旧记忆硬答、严禁嘴上说「我搜一下」却不真正调用。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索词' } },
      required: ['query'],
    },
  },
};

// 「边查边嘟囔」的 filler 短语，随机挑一句。
const FILLERS = ['我查一下…', '我看看…', '让我查查…'];
export function pickFiller(): string {
  return FILLERS[Math.floor(Math.random() * FILLERS.length)];
}
