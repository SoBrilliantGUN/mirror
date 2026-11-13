# emotion-gold —— 层 A 情绪金标测试集管线

给 `scoreAffect` 造**测试真值**（层 A），对齐它已有的输出 schema：

- `affect` = PAD 三维（效价 valence / 唤起 arousal / 支配 dominance，各 0~1）
- `incongruence` = 跨通道不一致 bool（文字 vs 声音 打架）
- 核心难点「情感不协调」= 文字「我没事我挺开心」+ 声音哭腔 → `incongruence=true`

> 与 `docs/评测prompts.md §1.5`、`docs/评测用例.md` 的「情感不协调（副语言不一致·跨通道）」一一对应。
> 金标只评「层 A 读没读对」；「读对之后回应对不对」是层 B，由 judge 另评，别混在一起。

## 获取 Tier 2 真实语料（可选）

```bash
# OPUS 中文字幕（自动下载，先 zh_cn 简体、兜底 zh_tw 繁体），reservoir 抽样 N 条
python emotion-gold/fetch_subtitles.py --limit 5000 --output texts.jsonl

# 或导入 chinese-chatbot-corpus 的电视剧对白 TSV（百度网盘手动下后转）
python emotion-gold/fetch_subtitles.py --tsv ./clean_chat_corpus/subtitle.tsv --limit 5000 --output texts.jsonl
```

> 注：`zh_cn`（简体）URL 未经实测确认，脚本会自动 fallback 到 `zh_tw`（繁体，已确认可下约 15MB）。
> 繁体若要转简体，装 `opencc` 后加一行转换即可，本脚本未内置（避免多余依赖）。

## 三个子命令

```bash
# 1. 自动打分（LLM 打 text_vad + audio_vad(潜台词) + incongruence）
python emotion-gold/pipeline.py score --input texts.jsonl --output scored.jsonl

# 2. 分层抽样，挑 N 条人工金标（重点保「不一致」稀有样本）
python emotion-gold/pipeline.py stratify --input scored.jsonl --output gold_pick.jsonl --n 500

# 3. 人工金标 vs 自动打分 对账
python emotion-gold/pipeline.py agreement --gold gold.jsonl --auto scored.jsonl --output report.json
```

`texts.jsonl` 每行：`{"id":"..","text":"..","context":".."(可选),"speaker":".."(可选),"source":".."(可选)}`
也接受纯文本文件（每行一条，id 自动编号）。

复用项目 `.env` 的 `DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / SCORE_MODEL`，无需额外配置。

## 为什么 500 条够（但必须分层）

500 条做**测试集**（不是训练集）误差 ≈ ±4.4%（1/√500），v1 评测够用。但**随机抽会翻车**：
真实对话里「逞强/不一致」只占 5~15%，随机 500 条只落 25~75 条不一致，测不准你最在乎的指标。

所以 `stratify` 按配额分层、超额采不一致：

| 桶 | 配额 | 作用 |
|---|---|---|
| strong mismatch（逞强/反讽） | 40% | 杀手锏，重点保 |
| weak mismatch | 20% | 边界 |
| congruent（按 VAD 象限铺开） | 40% | 基础情绪 + 防过拟合 |

这 500 条「一鱼两吃」：既是最终测试真值，又是**标定集**（`agreement` 反推 LLM 自动打分有多准）。

## 三层锚定（替代「从零编造」标签）

词典只是**锚点**，不是真值；最终金标 = LLM 打底 + 人工校对。

| 层 | 资源 | 放到哪 | 提供 |
|---|---|---|---|
| L1 词级骨架 | 大连理工情感词汇本体（约 2.7 万词） | `lexicons/dutir.csv` | 类别 + 强度 + 极性 → 粗略 valence/arousal |
| L2 词级补 VAD | NRC-VAD（英文约 2 万词，三维连续） | `lexicons/nrc_vad.csv` | valence/arousal/dominance 0~1 |
| L3 句级锚点 | EmotionTalk 的 5 维情感 / continuous label | 采集阶段用，不进本模块 | 句级正负/弱正负 |

- DUTIR：http://ir.dlut.edu.cn（林鸿飞团队）
- NRC-VAD：https://saifmohammad.com/WebPages/nrc-vad.html
- 缺词典文件时 `anchor_vad` 返回 `None`，不影响主流程。

## 数据源建议（对应三层测试集）

- **Tier 2 文本**：话剧剧本（如梦之梦/窝头会馆/李白等）、人人影视字幕、电影剧本。
- **Tier 3 音视频金标**：EmotionTalk（19,250 句 / 23.6h / 19 演员交互对话，开源）、
  M3ED（24,449 句 / 56 部剧）。两者现成标签是「7 类离散」为主，
  **audio-VAD 连续三维 + incongruence 仍需自己补标**（抽几千句子集即可）。

## 语言

面向国内用户，中文为主。词典以 DUTIR（中文）为主，NRC-VAD（英文）仅作补强、非必需。

## 自检（无需 API / 词典）

```bash
python emotion-gold/selfcheck.py
```
