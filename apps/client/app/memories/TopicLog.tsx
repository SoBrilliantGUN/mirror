'use client';

import { useEffect, useState } from 'react';

const getServer = () => process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:3001';

type LibraryEntry = { topic: string; summary: string; createdAt: string };
type Engagement = { topic: string; dimension: string | null; sessions: number; engagedSessions: number; turns: number };

// 把一次主题参与的进度翻成行话。min 是「兴趣阈值」（由 /topics 接口回传，前端不写死）。
function describeEngagement(e: Engagement, min: number | null): { line: string; note: string; qualified: boolean } {
  const qualified = min !== null && e.sessions >= min && e.sessions === e.engagedSessions;
  const dim = e.dimension ? `（${e.dimension}）` : '';
  const note = min === null
    ? ''
    : qualified
      ? '已达兴趣阈值，下次通话结束会搜网总结'
      : `差 ${Math.max(1, min - e.sessions)} 通深入对话`;
  return { line: `${e.topic}${dim} · 出现 ${e.sessions} 通 / 深入 ${e.engagedSessions} 通 / 约 ${e.turns} 轮`, note, qualified };
}

export default function TopicLog({ persona, onClose }: { persona: string; onClose: () => void }) {
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [interestMin, setInterestMin] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!persona) return;
    setLoading(true);
    fetch(`${getServer()}/topics?persona=${encodeURIComponent(persona)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setLibrary(d?.library ?? []);
        setEngagements(d?.engagements ?? []);
        setInterestMin(typeof d?.interestSessionMin === 'number' ? d.interestSessionMin : null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [persona]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel lib-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-h">
          <h3>🗂️ 话题{persona ? ` · ${persona}` : ''}</h3>
          <button className="panel-close" onClick={onClose}>✕</button>
        </div>
        <div className="lib-sub">
          每通电话结束后，TA 会后台抽出你聊过的自由主题；聊得足够多且每通都深入的主题，才会自动上网搜、总结成备用话题。下面是进度与已搜话题。
        </div>
        <div className="dream-list">
          {loading ? (
            <div className="empty">加载中…</div>
          ) : library.length === 0 && engagements.length === 0 ? (
            <div className="empty">还没有话题记录，聊几通之后再来看看。</div>
          ) : (
            <>
              {library.length > 0 && (
                <>
                  <div className="topic-section-h">已上网搜过的话题（备用话题库）</div>
                  {library.map((l, i) => (
                    <div className="dream-item" key={`lib-${i}`}>
                      <div className="dream-item-time">{l.createdAt.slice(0, 16).replace('T', ' ')}</div>
                      <div className="dream-item-body">
                        <div className="dream-line"><b>{l.topic}</b></div>
                        <div className="dream-line">{l.summary}</div>
                      </div>
                    </div>
                  ))}
                </>
              )}
              {engagements.length > 0 && (
                <>
                  <div className="topic-section-h">主题兴趣进度</div>
                  {engagements.map((e, i) => {
                    const { line, note, qualified } = describeEngagement(e, interestMin);
                    return (
                      <div className="dream-item" key={`eng-${i}`}>
                        <div className="dream-item-body">
                          <div className="dream-line">{line}</div>
                          {note && (
                            <div className={`dream-line muted${qualified ? ' qualified' : ''}`}>{qualified ? '✓ ' : '○ '}{note}</div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
