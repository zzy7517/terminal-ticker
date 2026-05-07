import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NewsItem } from '../../types';
import { triggerNewsRefresh } from '../../api';

function formatRelativeTime(iso: string): string {
  const publishedAt = new Date(iso).getTime();
  if (Number.isNaN(publishedAt)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - publishedAt) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

type LocalNewsItems = {
  items: NewsItem[];
  upstreamSignature: string;
};

function newsItemsSignature(items: NewsItem[]): string {
  return items.map((item) => `${item.url}|${item.publishedAtMs}|${item.title}`).join('\n');
}

export function NewsPanel({
  items,
  lastStatus,
  lastError,
}: {
  items: NewsItem[];
  lastStatus?: string;
  lastError?: string | null;
}) {
  const [loading, setLoading] = useState(false);
  const [localItems, setLocalItems] = useState<LocalNewsItems | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const upstreamSignature = useMemo(() => newsItemsSignature(items), [items]);
  const displayItems = localItems?.items ?? items;

  useEffect(() => {
    if (localItems && upstreamSignature !== localItems.upstreamSignature) {
      setLocalItems(null);
    }
  }, [localItems, upstreamSignature]);

  const handleRefresh = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setFeedback(null);
    try {
      const result = await triggerNewsRefresh();
      setLocalItems({
        items: result.news,
        upstreamSignature,
      });
      if (result.error) {
        setFeedback(`${result.status}: ${result.error}`);
      } else if (result.stale) {
        setFeedback('refresh timed out; showing cached items');
      } else if (result.inserted > 0) {
        setFeedback(`added ${result.inserted} new items`);
      } else {
        setFeedback('no new items');
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'refresh failed');
    } finally {
      setLoading(false);
    }
  }, [loading, upstreamSignature]);

  return (
    <div className="news-panel">
      <div className="news-panel__head">
        <span className="news-panel__title">Reuters</span>
        <button
          className="news-refresh-btn"
          onClick={handleRefresh}
          disabled={loading}
          type="button"
        >
          {loading ? '刷新中…' : '立即刷新'}
        </button>
      </div>
      {feedback && <div className="news-panel__feedback">{feedback}</div>}
      {!feedback && lastStatus && lastStatus !== 'ok' && lastStatus !== 'not_modified' && (
        <div className="news-panel__feedback">{lastStatus}{lastError ? `: ${lastError}` : ''}</div>
      )}
      <div className="news-panel__list">
        {displayItems.length === 0 && (
          <div className="news-panel__empty">暂无新闻，点击"立即刷新"拉取。</div>
        )}
        {displayItems.map((item) => (
          <a
            className="news-item"
            href={item.url}
            key={item.url}
            target="_blank"
            rel="noreferrer"
            title={item.title}
          >
            <div className="news-item__title">{item.title}</div>
            {item.summary && (
              <div className="news-item__summary">{item.summary}</div>
            )}
            <div className="news-item__meta">
              <span>{formatRelativeTime(item.publishedAt)}</span>
              {item.keywords.length > 0 && (
                <span className="news-item__keywords">· {item.keywords.slice(0, 3).join(' · ')}</span>
              )}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
