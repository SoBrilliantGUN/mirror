import { RTCPeerConnection, MediaStreamTrack, useOPUS, RtpBuilder } from 'werift';
import OpusScript from 'opusscript';
import { resample } from './resample';

// 等 ICE 采集完成（非 trickle，把 host candidate 写进 SDP 再交换）。
function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    pc.iceGatheringStateChange.subscribe((state) => {
      if (state === 'complete') finish();
    });
    setTimeout(finish, 3000);
  });
}

export type RtcCallbacks = {
  onUserPcm: (chunk: Uint8Array) => void; // 16kHz 单声道 PCM（喂 ASR）
  onInterrupt: () => void;
  onPlaybackEnd?: () => void; // 下行播放队列播完（一轮真正说完，静默计时从这里起算）
  onHangup?: () => void;      // 客户端经 data channel 明确挂断（立刻停，不等断连）
  onClose?: () => void;       // 连接真正断开（closed/failed），只触发一次（挂断收尾用）
};

export type RtcPeer = {
  handleOffer(offerSdp: string): Promise<string>;
  whenReady(timeoutMs?: number): Promise<void>; // 等连接真正建立（首包到达），超时兜底
  pushAgentPcm(chunk: Uint8Array, gain?: number): void; // 24kHz PCM 入播放队列（gain 可选，鸭音用）
  end(): void; // 整轮结束：把末尾不满 20ms 的残余补齐发出
  clear(): void; // 打断：清空队列、停掉出帧（立刻停声）
  close(): void;
  sendControl(obj: unknown): void; // 经 data channel 发控制消息（如挂断）
};

const FRAME_SAMPLES = 960; // 20ms @ 48kHz 的采样数
const FRAME_BYTES = FRAME_SAMPLES * 2; // Int16 字节数

export type RtcIceOptions = {
  portRange: [number, number]; // ICE UDP 端口段（与 compose 发布一致）
  hostAddress: string;         // 额外宣告的主机地址（本地 127.0.0.1，远程公网/LAN IP）
};

export function createRtcPeer(cbs: RtcCallbacks, ice: RtcIceOptions): RtcPeer {
  const pc = new RTCPeerConnection({
    codecs: { audio: [useOPUS()], video: [] },
    // Docker 关键：固定 ICE UDP 端口段 + 额外宣告可达地址，
    // 让浏览器能经 compose 发布的 udp 段直达容器（只宣告、不绑定）。
    icePortRange: ice.portRange,
    iceAdditionalHostAddresses: [ice.hostAddress],
  });
  const opus = new OpusScript(48000, 1, OpusScript.Application.VOIP);
  let rtpBuilder: RtpBuilder | null = null; // 懒创建：SSRC 要等协商后从 sender 拿

  let sendTrack: MediaStreamTrack | null = null;
  let pcm48Queue = Buffer.alloc(0); // 48kHz PCM 播放队列
  let ended = false; // true = 这一轮不再有新的 PCM 进来（用于冲末尾残余）
  let closed = false;
  let pacerTimer: ReturnType<typeof setTimeout> | null = null;
  let nextFrameAt = 0; // 下一帧该在的墙钟时间（ms）
  let playoutTimestamp = 0; // RTP 时间戳（48kHz 采样），逐帧 +960
  let firstRtpResolve: (() => void) | null = null; // 首个上行 RTP 到达时 resolve（连接真正建立）
  const firstRtpPromise = new Promise<void>((r) => { firstRtpResolve = r; });

  // 发送轨道（下行 TTS）
  sendTrack = new MediaStreamTrack({ kind: 'audio' });
  pc.addTrack(sendTrack);

  // 接收浏览器麦克风（上行）
  pc.ontrack = (event) => {
    const track = event.track as MediaStreamTrack;
    console.log('[RTC] ontrack：收到远端音轨');
    let n = 0;
    track.onReceiveRtp.subscribe((rtpPacket) => {
      n++;
      if (n === 1) firstRtpResolve?.(); // 首包到达：连接真正建立，招呼语可以开播
      if (n % 50 === 1) {
        console.log('[RTC] 收到第', n, '个 RTP 包，payload', (rtpPacket.payload as Uint8Array)?.length ?? '?', '字节');
      }
      try {
        const pcm48 = opus.decode(Buffer.from(rtpPacket.payload));
        const pcm16 = resample(new Int16Array(pcm48.buffer, pcm48.byteOffset, pcm48.length / 2), 48000, 16000);
        cbs.onUserPcm(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength));
      } catch (e) {
        if (n % 50 === 1) console.error('[RTC] 解码失败：', e);
      }
    });
  };

  // data channel（打断信令 + 服务端下发的控制消息）
  let controlChannel: { send: (data: string) => void; readyState?: string } | null = null;

  // 连接状态：断开（客户端挂断 / 网络失败 / 服务端 close）时回调一次，用于收尾（会话记录等）。
  let closeFired = false;
  pc.connectionStateChange.subscribe((state) => {
    if ((state === 'closed' || state === 'failed') && !closeFired) {
      closeFired = true;
      cbs.onClose?.();
    }
  });
  pc.ondatachannel = (event) => {
    controlChannel = event.channel;
    event.channel.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'interrupt') cbs.onInterrupt();
        else if (msg.type === 'hangup') cbs.onHangup?.();
      } catch {
        /* 非 JSON 消息忽略 */
      }
    };
  };

  // 把一帧已编码 Opus 发出去。
  function sendFrame(frame: Buffer) {
    if (!sendTrack || closed) return;
    if (!rtpBuilder) {
      const sender = pc.getSenders().find((s) => s.track === sendTrack);
      rtpBuilder = new RtpBuilder({ clockRate: 48e3, ssrc: sender?.ssrc ?? 0 });
      console.log('[RTC] 建 RtpBuilder，ssrc=', sender?.ssrc);
    }
    playoutTimestamp += FRAME_SAMPLES;
    const rtp = rtpBuilder.create(frame, { timestamp: playoutTimestamp });
    rtp.header.marker = true;
    sendTrack.writeRtp(rtp);
  }

  // 队列非空时启动出帧定时器（idle 后靠 pushAgentPcm 重启）。
  function ensurePacer() {
    if (pacerTimer !== null || closed) return;
    nextFrameAt = performance.now();
    pacerTimer = setTimeout(paceTick, 0);
  }

  function paceTick() {
    pacerTimer = null;
    if (closed) return;
    if (pcm48Queue.length >= FRAME_BYTES) {
      const frameBuf = pcm48Queue.subarray(0, FRAME_BYTES);
      pcm48Queue = pcm48Queue.subarray(FRAME_BYTES);
      sendFrame(opus.encode(frameBuf, FRAME_SAMPLES));
      nextFrameAt += 20; // 下一帧按真实时钟 +20ms，不靠估算总时长
      const delay = Math.max(0, nextFrameAt - performance.now());
      pacerTimer = setTimeout(paceTick, delay);
    } else if (ended && pcm48Queue.length > 0) {
      // 整轮结束：末尾残余 < 20ms，补静音发最后一帧（否则最后音节被吞）
      const padded = Buffer.alloc(FRAME_BYTES);
      pcm48Queue.copy(padded, 0, 0, pcm48Queue.length);
      pcm48Queue = Buffer.alloc(0);
      sendFrame(opus.encode(padded, FRAME_SAMPLES));
      cbs.onPlaybackEnd?.(); // 残余也发完了，这一轮真正说完
    } else if (ended) {
      // 队列已空且整轮结束：播放完毕
      cbs.onPlaybackEnd?.();
      nextFrameAt = 0;
    } else {
      // 队列空且未结束：停，等下一句的 PCM 进来再启动
      nextFrameAt = 0;
    }
  }

  return {
    async handleOffer(offerSdp) {
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGathering(pc);
      return pc.localDescription?.sdp ?? answer.sdp;
    },

    // 等连接真正建立（首个上行 RTP 到达），超时兜底。缓存招呼语别在连接就绪前抢跑（开头会被切）。
    whenReady(timeoutMs = 1500): Promise<void> {
      return Promise.race([firstRtpPromise, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
    },

    pushAgentPcm(chunk, gain = 1.0) {
      if (closed) return;
      ended = false; // 又有新数据了（下一句），取消“已结束”状态
      const pcm24 = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
      const pcm48 = resample(pcm24, 24000, 48000);
      if (gain !== 1.0) {
        for (let i = 0; i < pcm48.length; i++) pcm48[i] = Math.round(pcm48[i] * gain); // 鸭音：在重采样后的新数组上做，不污染缓存片段
      }
      pcm48Queue = Buffer.concat([pcm48Queue, Buffer.from(pcm48.buffer, pcm48.byteOffset, pcm48.byteLength)]);
      ensurePacer();
    },

    end() {
      if (closed) return;
      ended = true;
      // 队列空则无事可做；有残余则重启一次出帧去冲尾部
      if (pcm48Queue.length > 0) ensurePacer();
      else cbs.onPlaybackEnd?.(); // 队列早已空：播放早已完成，直接通知
    },

    clear() {
      pcm48Queue = Buffer.alloc(0);
      ended = false;
      if (pacerTimer !== null) {
        clearTimeout(pacerTimer);
        pacerTimer = null;
      }
      nextFrameAt = 0;
    },

    close() {
      closed = true;
      if (pacerTimer !== null) {
        clearTimeout(pacerTimer);
        pacerTimer = null;
      }
      pcm48Queue = Buffer.alloc(0);
      pc.close();
    },

    sendControl(obj) {
      try {
        if (controlChannel && controlChannel.readyState === 'open') {
          controlChannel.send(JSON.stringify(obj));
        }
      } catch {
        /* 通道未就绪，忽略 */
      }
    },
  };
}
