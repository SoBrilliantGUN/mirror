# speech/ 交接速查

这是「语音」目录，包 L2 语音流水线（ASR / TTS / 副语言特征 / 哭·笑检测）。文件名多沿用**阿里云供应商名**（Paraformer / NLS / CosyVoice），先背这张「供应商名 → 职责」映射，读起来快很多：

| 文件 | 供应商名 | 真实职责 | 生产路径？ |
|---|---|---|---|
| `paraformerRealtime.ts` | Paraformer | **ASR 语音识别**（流式 + interim） | ✅ 是 |
| `nlsSoundEvent.ts` | NLS | **哭/笑检测**（云端声音事件，零本地模型） | ✅ 是 |
| `cosyvoiceRealtime.ts` | CosyVoice | **实时 TTS**（WebSocket 流式出 PCM） | ✅ 是 |
| `cosyvoice.ts` | CosyVoice | **离线/非流式 TTS**（HTTP） | ❌ 仅 `scripts/gen-emotion-samples.ts` 采样用 |

其余文件按职责命名，语义自明：

- `speakPipeline.ts` —— `streamTurnSpeech`：把「决策好的 messages」流式生成 → 切句 → 逐句 TTS，含联网搜索分支。从 `session.ts` 抽出，`respond()` 只调它。
- `ttsEngine.ts` —— TtsEngine：整句合成 + 多端点重试，包 `cosyvoiceRealtime.streamTTS`。
- `emotionInstruction.ts` —— 情绪 → CosyVoice `instruction`（通用镜像层 + 人设底色 + 句尾处理）。
- `acousticFeatures.ts` —— 副语言特征（响度/音高/语速/停顿的会话内 z-score），喂 call1 打分。
- `backchannel.ts` —— 副语言附和（嗯/对/然后呢）：长段倾诉时轻声插一句，不抢话。
- `vocalEvents.ts` —— VocalEventAggregator：聚合一轮哭/笑事件、加权判主导类型。
- `greetingClips.ts` —— GreetingClipCache：招呼语片段预热/落盘（内存缓存层）。
- `nameNormalizer.ts` —— 名字同音字纠正（ASR 把「明悦」听成「明月」时改回）。
- `wsUtil.ts` —— ws message 的 RawData → Buffer 统一。

**一句话链路**：`onUserPcm`（上行 PCM）→ 同时喂 `ParaformerRealtimeASR`（识别）+ `NlsSoundEventDetector`（哭/笑）+ `AcousticFeatureExtractor`（副语言）；下行 `TtsEngine.synthesize` → `cosyvoiceRealtime.streamTTS` → 推回 RTC。
