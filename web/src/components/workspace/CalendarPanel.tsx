import { useCallback, useState } from 'react';
import { Reveal } from '../Reveal';
import './CalendarPanel.css';
import type { Jin10CalendarEvent } from '../../types';
import { refreshJin10Calendar } from '../../api';

function starIcons(count: number): string {
  return '★'.repeat(Math.min(count, 5));
}

function formatEventTime(pubTime: string): string {
  if (!pubTime) return '';
  try {
    const d = new Date(pubTime);
    if (isNaN(d.getTime())) return pubTime;
    const now = new Date();
    const isToday = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (isToday) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return pubTime;
  }
}

function actualVsConsensus(actual: string, consensus: string): 'better' | 'worse' | 'neutral' {
  if (!actual || actual === '--' || actual === '-') return 'neutral';
  if (!consensus || consensus === '--' || consensus === '-') return 'neutral';
  const a = parseFloat(actual.replace('%', ''));
  const c = parseFloat(consensus.replace('%', ''));
  if (isNaN(a) || isNaN(c)) return 'neutral';
  if (a > c) return 'better';
  if (a < c) return 'worse';
  return 'neutral';
}

export function CalendarPanel({
  events,
  jin10Available,
}: {
  events: Jin10CalendarEvent[];
  jin10Available: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const handleRefresh = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setFeedback(null);
    try {
      const result = await refreshJin10Calendar();
      if (result.error) {
        setFeedback(`刷新失败: ${result.error}`);
      } else {
        setFeedback(`已加载 ${result.count} 条日历事件`);
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '刷新失败');
    } finally {
      setLoading(false);
    }
  }, [loading]);

  if (!jin10Available) {
    return (
      <Reveal className="calendar-panel bezel-ring">
        <div className="empty-state lg">
          <p>财经日历需要配置 Jin10 数据源。</p>
          <p><small>在 MCP 设置中配置 Jin10 服务器并填入 Token 即可启用。</small></p>
        </div>
      </Reveal>
    );
  }

  // Only show important events (4+ stars)
  const important = events.filter((e) => e.star >= 4);

  // Split into upcoming (actual empty) and published
  const upcoming = important.filter((e) => !e.actual || e.actual === '--' || e.actual === '-');
  const published = important
    .filter((e) => e.actual && e.actual !== '--' && e.actual !== '-')
    // Most recently published first
    .sort((a, b) => {
      const ta = new Date(a.pubTime).getTime();
      const tb = new Date(b.pubTime).getTime();
      if (isNaN(ta) || isNaN(tb)) return 0;
      return tb - ta;
    });

  return (
    <Reveal className="calendar-panel bezel-ring">
      <div className="calendar-panel__head">
        <span className="calendar-panel__title">财经日历</span>
        <button
          className="shell-button sm"
          onClick={handleRefresh}
          disabled={loading}
          type="button"
        >
          {loading ? '刷新中...' : '刷新'}
        </button>
      </div>

      {feedback && <div className="calendar-panel__feedback">{feedback}</div>}

      {important.length === 0 && (
        <div className="empty-state sm">
          {events.length === 0 ? '暂无日历数据。点击“刷新”加载今日财经事件。' : '今日无 4 星以上重要事件。'}
        </div>
      )}

      {published.length > 0 && (
        <div className="calendar-section">
          <div className="calendar-section__title">已公布</div>
          {published.map((event, i) => {
            const comparison = actualVsConsensus(event.actual, event.consensus);
            return (
              <div key={`${event.pubTime}-${event.title}-${i}`} className={`calendar-event ui-control published star-${Math.min(event.star, 3)}`}>
                <div className="calendar-event__head">
                  <span className="calendar-event__stars">{starIcons(event.star)}</span>
                  <span className="calendar-event__time">{formatEventTime(event.pubTime)}</span>
                  <span className="calendar-event__title">{event.title}</span>
                </div>
                <div className="calendar-event__values">
                  <span>前值: <strong>{event.previous || '--'}</strong></span>
                  <span>预期: <strong>{event.consensus || '--'}</strong></span>
                  <span>
                    实际: <strong className={comparison}>{event.actual}</strong>
                    {comparison === 'better' && ' ↑'}
                    {comparison === 'worse' && ' ↓'}
                  </span>
                </div>
                {event.affectTxt && (
                  <div className="calendar-event__affect">{event.affectTxt}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {upcoming.length > 0 && (
        <div className="calendar-section">
          <div className="calendar-section__title">待公布</div>
          {upcoming.map((event, i) => (
            <div key={`${event.pubTime}-${event.title}-${i}`} className={`calendar-event ui-control star-${Math.min(event.star, 3)}`}>
              <div className="calendar-event__head">
                <span className="calendar-event__stars">{starIcons(event.star)}</span>
                <span className="calendar-event__time">{formatEventTime(event.pubTime)}</span>
                <span className="calendar-event__title">{event.title}</span>
              </div>
              <div className="calendar-event__values">
                <span>前值: <strong>{event.previous || '--'}</strong></span>
                <span>预期: <strong>{event.consensus || '--'}</strong></span>
                <span>实际: <strong className="pending">--</strong></span>
              </div>
              {event.affectTxt && (
                <div className="calendar-event__affect">{event.affectTxt}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </Reveal>
  );
}
