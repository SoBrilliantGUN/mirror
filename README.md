# Mirror · 一位会陪你变好的伙伴

> 一个基于 MBTI 的 Life Coach 聊天机器人——**纯语音、真·实时双工**（可打断/抢话）。

**一句话定位**：一位你亲手挑选、越聊越懂你、能温柔牵着你走出低谷的 AI 伙伴。它不是心理医生、不是鸡汤文、不是讨好你的玩具，而是**朋友和引路人的合体**——大多数时候照见你，关键时刻给你力量。

- **目标用户**：18–65 岁的国内男女，正经历人生低谷或成长卡点
- **明确不做什么**：不做诊断/治疗、不做恋人/成人向、不接与成长无关的闲聊
- **形态**：浏览器端纯语音通话，情绪主要靠声音承载（不靠文字括号/表情补丁）

---

## 特性概览（七个核心系统）

| # | 系统 | 一句话 |
|---|---|---|
| 1 | **对话内核**（灵魂） | 「先被听见，再被引导」——①接住情绪 ②映照内心 ③引导一步 ④陪她落回当下 |
| 2 | **深度链接** | 基于真实了解的精准共情，绝不使用 PUA/操控手段 |
| 3 | **MBTI 定位** | 只作为 16 位陪伴者的「性格底色素材」，**不对用户展示、不推断用户类型** |
| 4 | **十六人格** | 16 位陪伴者（男女各 8 位），当前上线 4 位，其余角色卡就绪待开放 |
| 5 | **长期记忆与遗忘** | 六型记忆 + 混合召回 + 30 天软衰减 + 反思巩固 |
| 6 | **时间感知** | 知道几点、今天什么日子，温柔地主动关怀（通话内被动体现） |
| 7 | **安全底线**（P0） | 语义级自伤/轻生识别 + 过度依赖识别 + 强制转介 |

**情绪模型**：不猜标签，每轮给「效价 Valence / 唤醒 Arousal / 支配 Dominance」三个维度各打 `-2..+2` 连续分；文字判正负、声音判强度，两路不一致 = 情感不协调 = 她在硬撑。

**双模式**：情绪平稳走「闲聊模式」（低延迟、轻快）；明显偏负/高唤醒/情感不协调/触及红线时切「小心翼翼模式」（放慢、停顿、共情优先）。

> 完整产品理念与边界见 [`docs/产品方案.md`](docs/产品方案.md)。

---

## 教练模式（Life Coach）

在「朋友态」之上叠加一个「教练态」（交互框架 `Frame`，与情绪强度 `Mode` 正交）——补上产品「引路人」那一半。方法用 **GROW**（目标→现状→选项→行动）。

**怎么进入**（两个触发，详见 [`docs/技术方案-L3.md`](docs/技术方案-L3.md) §六）：

- **用户明说求助**：说「我该怎么办 / 我到底想要什么 / 我好迷茫 / 帮我分析分析」这类话 → 立即进教练。
- **主动察觉**：连续两轮透出「反复卡住 / 走不出来」的信号 → 教练温柔邀入（「要不要我陪你捋捋？」），接话即进。

**怎么退出**：用户说「我做到了 / 解决了 / 我想通了 / 算了随它去」→ 教练庆祝一句、退回朋友态，课题标记完成。

**行为边界**：教练态里 GROW 是唯一主线——好奇心找话题（`[CURIOSITY]`）、换话题（`[TOPIC]`）、静默主动发话（followup/nudge/farewell）一律关闭，不被带跑；用户沉默时教练也更耐心（30s 才轻轻确认一次，再 30s 才温柔留门收尾，不催、不自问自答、不无限等）；课题档案跨通话持久（`growth_goals` 表），新通话会主动追问「后来呢」。

---

## 技术栈

- **全 TypeScript**，monorepo（`apps/*` + `packages/*`）
- **前端**：Next.js（`apps/client`）——通话 UI + 麦克风采集 + 播放 + 前端 VAD（抢话打断）
- **后端**：Node（`apps/server`）——实时传输 / 语音流水线 / 对话大脑 / 安全红线 / 状态与会话
- **桌面版**：Electron（`apps/desktop`）——内嵌 Postgres + 语音 + 英文模式，打包成便携 exe
- **实时语音**：WebRTC（服务端 `werift`），真·实时双工、可打断
- **模型**：

| 角色 | 模型 | 说明 |
|---|---|---|
| 大脑 | DeepSeek `deepseek-chat` | 流式生成；不默认上 reasoner（推理十几秒级，对语音通话太伤） |
| 安全红线 | 阿里云百炼 `qwen-flash` | 独立小模型，两路并行判定，不与大脑共用一次调用 |
| 长期记忆 embedding | `text-embedding-v3` | Postgres + pgvector 向量召回 |
| ASR | 阿里云百炼 Paraformer 实时 | 流式 + interim |
| TTS | 阿里云百炼 CosyVoice | 指令式情绪 + 声音设计音色 |
| 哭/笑检测 | 阿里云 NLS 声音事件检测 | 云端，零本地模型 |

---

## 分层架构（L0–L8）

```
L0 通话前端 → L1 实时传输 → L2 语音流水线 → L3 对话大脑 → L4 安全红线
        ↘  L5 状态与会话  →  L6 配置与角色卡
评测：L7 评测系统 · L8 情绪金标管线
```

- **L0** 通话前端（麦克风/播放/前端 VAD 打断）
- **L1** 实时传输（werift WebRTC，双向音频 + 控制信令）
- **L2** 语音流水线（ASR/TTS 适配器 + 副语言特征 + 哭/笑检测）
- **L3** 对话大脑（系统提示词组装 + 情绪三维打分 + DeepSeek 流式）
- **L4** 安全红线（语义级自伤/轻生识别 + 强制转介）
- **L5** 状态与会话（mode/mood/上下文/记忆）
- **L6** 配置与角色卡（角色卡 → 结构化 JSON）
- **L7** 评测系统（表达层轴 + 红线扫雷 + LangFuse）
- **L8** 情绪金标管线（`emotion-gold/`，层 A 测试真值）

> 各层接口契约收在 `packages/contracts`（client/server 只依赖契约，不依赖对方内部实现）。

---

## 目录结构

```
mirror/
├── apps/
│   ├── client/            # Next.js 前端：通话 UI + 采集 + 播放 + 前端 VAD
│   ├── server/            # Node 后端：L1/L2/L3/L4/L5 热路径 + 脚本 + 测试
│   │   └── src/
│   │       ├── server.ts        # 入口：装配配置/存储 → router + CallSession + 做梦巩固
│   │       ├── session.ts       # 单通通话编排（ASR→L3→TTS + 主动发话状态机 + 抢话）
│   │       ├── router.ts        # HTTP 路由（通讯录/记忆库/导出/信令）
│   │       ├── vector.ts        # 向量工具（cosine，persona 与记忆巩固共用）
│   │       └── brain/ store/ speech/ rtc/ llm/ persona/ obs/ scripts/
│   │           ├── brain/README.md   # 交接速查：L 层↔文件映射 + 情绪概念 5 连
│   │           └── speech/README.md  # 交接速查：供应商名→职责（ASR / 哭·笑 / TTS）映射
│   └── desktop/           # Electron 桌面版：内嵌 PG + 语音 + 英文模式 + 便携 exe
├── packages/
│   └── contracts/         # 共享类型 + 接口契约（"缝"的物理位置）
├── character/             # 16 位陪伴者角色库（一人一个文件夹，渐进式加载）
├── emotion-gold/          # L8 情绪金标管线（Python）
├── greetings-listen/      # 招呼语 TTS 音频与转换脚本
├── infra/                 # 本地基础设施（postgres / langfuse）
├── scripts/               # gen-personas.ts 等
├── docs/                  # 产品方案 + 技术方案（L0–L8）+ 评测 + 心理学依据
├── docker-compose.yml     # 一键起（client + server + postgres）
├── Dockerfile.client      # 前端镜像
├── Dockerfile.server      # 后端镜像
└── .env.example           # 环境变量占位（进 git；真 key 放 .env，已 gitignore）
```

---

## 快速开始

### 前置条件

- Node.js（建议 ≥ 20）
- 一个 Postgres（可选，用下面的 Docker 起，或本地已有）
- 各模型服务的 API Key（DeepSeek、阿里云百炼 DashScope 等）

### 1. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填入真实 key：
#   DEEPSEEK_API_KEY / DASHSCOPE_API_KEY / NLS_APPKEY / EMBEDDING_API_KEY ...
#   USER_NAME（可选：你的名字，避免语音识别把名字听成同音字；桌面版在「设置」里填）
```

`.env` 已 gitignore，绝不进 git。各项含义见 `.env.example` 内注释。

### 2. 起数据库（可选）

用 `docker compose` 只起 Postgres：

```bash
docker compose up -d postgres
```

### 3. 安装依赖 + 启动

```bash
npm install
npm run client      # 前端 (Next.js, localhost:3000)，自动先 gen:personas
npm start           # 后端 (Node, localhost:3001)，自动先 gen:personas
```

打开浏览器访问 `http://localhost:3000`，选一位陪伴者、对着麦克风说话。

### 一键 Docker（三件套）

```bash
docker compose up --build   # client(3000) + server(3001) + postgres(5432)
```

实时语音（WebRTC）在 Docker 下已跑通：compose 发布 `50000-50100/udp` 的 ICE 媒体段，服务端 `icePortRange` + `iceAdditionalHostAddresses` 配置，浏览器上行 RTP / 下行 TTS 均正常。密钥从根目录 `.env` 注入，`DATABASE_URL` 会在 compose 内自动指向 `postgres` 服务。

---

## 构建 / 编译（改了代码怎么生效）

monorepo 三块各管各的，**没有统一的编译命令**——改哪层就重建哪层：

| 改动的代码 | 命令 | 说明 |
|---|---|---|
| 服务端 `apps/server/` | `npm run start` | `tsx` 直跑 TS，**无需编译**，改完即生效 |
| Web 前端 `apps/client/` | `npm run client` / `npm run build -w @mirror/client` | dev 热更新 / 正式构建静态导出到 `apps/client/out/` |
| 桌面版 `apps/desktop/` | `npm run dev -w @mirror/desktop` | rebundle 主进程 + server + 重建前端 + 启动 |
| 出便携 exe | `npm run dist -w @mirror/desktop` | electron-builder 打包 `mirror-*-portable.exe` |

**桌面版构建机制**（`apps/desktop/build.mjs`）：

- esbuild 把 `apps/server/src/run.ts` → `dist/server.mjs`、`apps/desktop/src/main.ts` → `dist/main.mjs`、`preload.ts` → `dist/preload.cjs`
- `build:renderer` = `next build` 客户端 → 复制 `out/` → `apps/desktop/renderer/`
- 一句话：**只改服务端 → `npm run start`；要桌面版全量生效 → `npm run dev -w @mirror/desktop`；要出 exe → `npm run dist -w @mirror/desktop`**

类型检查与自测见下方「测试与常用脚本」。

---

## 测试与常用脚本

```bash
npm test              # 跑全部 selftest（18 个：decide/speech/acoustic/resample/memory/timeAware/safety/selfAdd/topicSwitch/search/activation/farewell/ontology/coach/speakPipeline/nameNormalizer/conversationFlow/session）
npm run typecheck     # tsc --noEmit 全量类型检查
npm run demo          # 无语音的文字 demo（run-demo）
npm run samples       # 生成情绪样例
npm run enroll-voices # 声音注册
npm run rt-tts        # 实时 TTS 自测
npm run test-nls      # NLS 哭/笑检测自测
```

---

## 陪伴者角色库

16 位陪伴者（对应 16 型 MBTI，男女各 8 位），角色卡全部集中在 [`character/`](character/)（索引见 [`character/README.md`](character/README.md)）。**当前上线 4 位**：程书衡（ESTJ）、沈砚秋（INFJ）、沈知遥（INTP）、苏明悦（ESFP）；其余 12 位角色卡就绪、暂不开放。

- **对外呈现**：只展示姓名 + 性格气质，**绝不显示 MBTI 类型**
- **对内实现**：每位暗扣一个 MBTI 类型，性格底色取自 `character/<姓名>/角色卡.md`
- **活人感**：每位锚定一位对应 MBTI 的真实知名人物作为蓝本
- **渐进式加载**：`角色卡.md` 常驻，`认知/`、`经历/`、`偏好/` 详情命中触发才加载（像 Claude 的记忆系统）

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [`GLOSSARY.md`](GLOSSARY.md) | **术语表（统一语言）**——一词一义，项目唯一权威词汇表 |
| [`docs/产品方案.md`](docs/产品方案.md) | 产品理念、七个核心系统、市场与商业 |
| [`docs/技术方案.md`](docs/技术方案.md) | 架构总览、分层、数据流、项目结构 |
| [`docs/技术方案-L0.md`](docs/技术方案-L0.md) ~ [`L8`](docs/技术方案-L8.md) | 分层详细设计（L0 通话前端 … L8 情绪金标） |
| [`docs/技术方案-对话增强.md`](docs/技术方案-对话增强.md) | 主动发话、找话题、去 AI 味等行为增强 |
| [`docs/长期记忆与上下文装配.md`](docs/长期记忆与上下文装配.md) | 六型记忆、召回、30 天衰减、反思巩固 |
| [`docs/如何写角色卡.md`](docs/如何写角色卡.md) | 角色卡写作规范 |
| [`docs/人格提示词.md`](docs/人格提示词.md) | 人格提示词 |
| [`docs/评测指标.md`](docs/评测指标.md) / [`评测用例.md`](docs/评测用例.md) / [`评测prompts.md`](docs/评测prompts.md) | 评测定义 |
| [`docs/心理学依据/`](docs/心理学依据/) | 设计决策的心理学出处 |

---

## 安全与隐私

- **`.env` 从第一个 commit 起就 gitignore**——key 一旦进历史就删不干净。
- **安全红线（P0）**：危机识别（自伤/轻生，语义级）+ 过度依赖识别，触发强制转介（提示词话术 + 热线号码确定性注入 + 前端 overlay 显示号码）。
- 内置国内心理危机资源（全国心理援助热线 12356、北京心理危机干预热线 010-82951332 等，上线前逐一核实）。
- 记忆默认可删除、可导出，不默认永久保留。

---

## 当前状态与下一步

**已落地（当前 v0）**

- 纯语音、真·实时双工（WebRTC，可打断/抢话）
- 对话内核（「先被听见，再被引导」+ 双模式 + 身份边界）
- 安全红线（危机识别 + 过度依赖识别 + 强制转介）
- 4 位陪伴者上线（程书衡 / 沈知遥 / 沈砚秋 / 苏明悦）
- 六型记忆 + 反思巩固 + 软激活遗忘（情节记忆软衰减 + 提及续命）+ 强制在场
- 副语言（声学 z-score）+ 哭/笑检测（NLS）+ 情感不协调
- 逐句情绪 + backchannel 附和 + 副语言发声
- 主动发话状态机（打招呼 / 追问 / checkin / 找话题 / 失落收尾）
- 时间感知（时间上下文 + 节假日 / 作息关怀）
- 人设增补（`SelfAdded`，永久固化 + 冲突校验 + 衰减）
- 好奇心底座（图补全）+ 联网搜索（博查）
- 好奇心找话题：话题树（10 维度 JSON、问题带 id）按「了解程度 + 新鲜感 + 兴趣」三值加权随机选维度→随机选未回答话题，换话题/静默时注入具体推荐问题（`gen:topics` 离线搜素材写死）
- 话题兴趣度分析：每通电话结束后抽自由话题 + 深入度，攒够「>3 通且每通深入」就去搜网、总结进备用话题库，找话题时自然带出
- 挂机模式（系统托盘）：关窗口缩托盘继续后台跑，点图标重开或彻底退出（做梦每天最多一次）
- 通话 UI 打磨：「对方正在说」只在真说话时亮；服务额度不足（429）时弹提示，不再默默卡住
- **Life Coach 成长引导**：朋友态 / 教练态自动切换 + GROW 四步 + 课题档案（跨通话持久）+ 新通话主动追问「后来呢」+ 解决后庆祝收口退回朋友
- 评测系统（L7）+ 情绪金标管线（L8）

**下一步（尚未落地）**

- 16 位陪伴者全部上线（当前 4 位，其余 12 位角色卡就绪）
- 情节记忆「晋升核心」（反复提及 → 升永久；暂由 reflect 反思巩固代偿，未做独立强化层）
- 情绪金标测试集补全（Tier 2/3 采集、500 条人工金标）
- 公网部署（HTTPS / STUN / TURN）与隐私合规打磨
