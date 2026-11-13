# 情绪维度模型（PAD / VAD）

> 情绪可以用三个近似正交的连续维度来描述，而不是有限的离散标签。

## 结论（被证实了什么）

- **PAD 三维模型**（Mehrabian & Russell, 1974）：情绪状态可由三个近乎正交的维度描述——
  - **P（Pleasure，效价/愉悦度）**：正负、喜恶。
  - **A（Arousal，唤醒/激活度）**：神经生理激活与警觉水平。
  - **D（Dominance，支配/优势度）**：对情境与自身的主观控制感（掌控 vs 无力）。
- 三维能解释 42 种情感量表的大部分变异；量表信度分别约 .97 / .89 / .80。
- 焦虑与抑郁都「不愉悦 + 顺从」，差别只在唤醒度（焦虑高唤醒、抑郁低唤醒）——单靠正负分不开，要靠第三维。
- **Russell 环状模型**（1980）：正负与唤醒是两条正交主轴，情绪是二维空间里的点。

## 来源（论文 / 文献）

- Mehrabian & Russell (1974). *An Approach to Environmental Psychology.* — PAD 模型出处。[Taylor & Francis 知识页](https://taylorandfrancis.com/knowledge/Engineering_and_technology/Engineering_support_and_special_topics/PAD_emotional_state_model/)
- Russell, J. A. (1980). A circumplex model of affect. — 效价×唤醒环状模型。[ScienceDirect](https://www.sciencedirect.com/topics/psychology/core-affect)
- 李晓明、傅小兰 (2008). 中文简化版 PAD 情绪量表初步试用. 《中国心理卫生杂志》22(5). [PDF](http://ir.psych.ac.cn/bitstream/311026/3992/1/%E4%B8%AD%E6%96%87%E7%AE%80%E5%8C%96%E7%89%88PAD%E6%83%85%E7%BB%AA%E9%87%8F%E8%A1%A8%E5%9C%A8%E4%BA%AC%E5%A4%A7%E5%AD%A6%E7%94%9F%E4%B8%AD%E7%9A%84%E5%88%9D%E6%AD%A5%E8%AF%95%E7%94%A8.pdf)

## 实证强度

**强**。因子分析稳定抽出三个近正交维度；VAD 标注是连续情绪识别的标准输出，被情感计算广泛采用。

## 关联的产品决策

- **L3 情绪状态机**：不贴「愤怒/悲伤/焦虑」离散标签，改打 **valence / arousal / dominance 三维分**（见 `docs/技术方案.md` 第三层）。
- 三维映射到教练行为：效价 → 接住还是同喜；唤醒 → 语气快慢/降火；支配 → 给方案还是只陪（正好是程书衡的破绽）。
