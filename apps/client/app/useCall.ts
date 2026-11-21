'use client';

import { useRef, useState } from 'react';

export type TranscriptRow = { role: 'user' | 'agent'; text: string };
export type SafetyInfo = { level: number; resources: { name: string; number: string; note?: string }[] };

// useCall 只管「麦克风 + WebRTC 信令 + VAD 打断 + 健康轮询」这条底层链路，
// 通话的 UI 收尾（挂断后 inCall=false / 断线提示）经 onEnded 回调交回页面。
export function useCall(getServer: () => string) {
  const [status, setStatus] = useState('');
  const [muted, setMuted] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptRow[]>([]);
  const [safety, setSafety] = useState<SafetyInfo | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const vadRunningRef = useRef(false);
  const audioElsRef = useRef<HTMLAudioElement[]>([]);
  const healthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const endedRef = useRef<((reason: 'hangup' | 'disconnect') => void) | null>(null);
  const memoryRef = useRef<(() => void) | null>(null);

  function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') finish(); });
      setTimeout(finish, 3000);
    });
  }

  function startVad(stream: MediaStream, audioCtx: AudioContext) {
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const ON_RMS = 0.06, OFF_RMS = 0.03, MIN_SPEECH_MS = 120;
    let wasSpeaking = false, speakingSince = 0, interruptSent = false;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / data.length);
      const speaking = rms > (wasSpeaking ? OFF_RMS : ON_RMS);
      if (speaking && !wasSpeaking) { speakingSince = performance.now(); interruptSent = false; }
      if (speaking && !interruptSent && performance.now() - speakingSince >= MIN_SPEECH_MS) {
        interruptSent = true;
        if (dcRef.current?.readyState === 'open') dcRef.current.send(JSON.stringify({ type: 'interrupt' }));
      }
      wasSpeaking = speaking;
      if (vadRunningRef.current) requestAnimationFrame(tick);
    };
    vadRunningRef.current = true;
    tick();
  }

  function clearHealthPoll() {
    if (healthTimerRef.current !== null) { clearInterval(healthTimerRef.current); healthTimerRef.current = null; }
  }

  function stopMedia() {
    vadRunningRef.current = false;
    clearHealthPoll();
    for (const el of audioElsRef.current) {
      try { el.pause(); el.srcObject = null; el.remove(); } catch { /* ignore */ }
    }
    audioElsRef.current = [];
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    pcRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }

  function startHealthPoll() {
    clearHealthPoll();
    const tick = async () => {
      try {
        const res = await fetch(`${getServer()}/health`, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
      } catch {
        stopMedia();
        setStatus('');
        endedRef.current?.('disconnect');
      }
    };
    healthTimerRef.current = setInterval(tick, 3000);
  }

  function hangup() {
    if (dcRef.current?.readyState === 'open') dcRef.current.send(JSON.stringify({ type: 'hangup' }));
    stopMedia();
    setStatus('');
    setSafety(null);
    endedRef.current?.('hangup');
  }

  function start(companionName: string, onEnded: (reason: 'hangup' | 'disconnect') => void, onMemory?: () => void) {
    endedRef.current = onEnded;
    memoryRef.current = onMemory ?? null;
    setStatus('连接中…');
    setSafety(null);
    setMuted(false);
    setTranscript([]);
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(async (stream) => {
        streamRef.current = stream;
        const pc = new RTCPeerConnection();
        pcRef.current = pc;
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));

        const dc = pc.createDataChannel('control');
        dcRef.current = dc;
        dc.onmessage = (ev) => {
          try {
            const msg = JSON.parse(String(ev.data));
            if (msg.type === 'hangup') hangup();
            if (msg.type === 'memory') memoryRef.current?.();
            if (msg.type === 'safety') setSafety({ level: msg.level, resources: msg.resources });
            if (msg.type === 'transcript') {
              if (msg.replace) {
                // ASR 纠错后回传：替换最后一条用户原文。
                setTranscript((prev) => {
                  const next = [...prev];
                  for (let i = next.length - 1; i >= 0; i--) {
                    if (next[i].role === 'user') { next[i] = { ...next[i], text: String(msg.text ?? '') }; break; }
                  }
                  return next;
                });
              } else {
                setTranscript((prev) => [...prev, { role: msg.role, text: String(msg.text ?? '') }]);
              }
            }
          } catch { /* 非 JSON 忽略 */ }
        };

        const audioCtx = new AudioContext();
        audioCtxRef.current = audioCtx;
        audioCtx.resume().catch(() => {});
        pc.ontrack = (e) => {
          const stream2 = e.streams[0] ?? new MediaStream([e.track]);
          const el = document.createElement('audio');
          el.srcObject = stream2;
          el.autoplay = true;
          document.body.appendChild(el);
          el.play().catch(() => {});
          audioElsRef.current.push(el);
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc);
        const res = await fetch(`${getServer()}/rtc/offer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sdp: pc.localDescription?.sdp ?? offer.sdp, name: companionName }),
        });
        if (!res.ok) {
          let msg = '信令 HTTP ' + res.status;
          try {
            const body = (await res.json()) as { error?: string };
            if (body?.error) msg = body.error;
          } catch { /* 非 JSON 响应，保留默认提示 */ }
          throw new Error(msg);
        }
        const { sdp } = await res.json();
        await pc.setRemoteDescription({ type: 'answer', sdp });

        setStatus('已接通，开始说话吧');
        startVad(stream, audioCtx);
        startHealthPoll();
      })
      .catch((e) => {
        console.error('接通失败：', e);
        setStatus('出错：' + (e instanceof Error ? e.message : String(e)));
      });
  }

  function toggleMute() {
    setMuted((prev) => {
      const next = !prev;
      streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
      return next;
    });
  }

  return { status, muted, transcript, safety, start, hangup, toggleMute, dismissSafety: () => setSafety(null) };
}
