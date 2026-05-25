import { useCallback, useEffect, useMemo, useState } from 'react';
import './NewsPanel.css';
import type { NewsItem } from '../../types';
import { triggerNewsRefresh, refreshJin10Flash } from '../../api';

type NewsSource = 'all' | 'reuters' | 'jin10';

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
  jin10Available,
}: {
  items: NewsItem[];
  lastStatus?: string;
  lastError?: string | null;
  jin10Available?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [localItems, setLocalItems] = useState<LocalNewsItems | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [source, setSource] = useState<NewsSource>('all');
  const upstreamSignature = useMemo(() => newsItemsSignature(items), [items]);
  const displayItems = localItems?.items ?? items;

  // Filter items by source
  const filteredItems = useMemo(() => {
    if (source === 'all') return displayItems;
    return displayItems.filter((item) => item.source === source);
  }, [displayItems, source]);

  // Check if we have jin10 items
  const hasJin10Items = useMemo(
    () => displayItems.some((item) => item.source === 'jin10'),
    [displayItems],
  );

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
      // Refresh both Reuters and Jin10
      const [reutersResult, jin10Result] = await Promise.allSettled([
        triggerNewsRefresh(),
        jin10Available ? refreshJin10Flash() : Promise.resolve(null),
      ]);

      const reuters = reutersResult.status === 'fulfilled' ? reutersResult.value : null;
      const jin10 = jin10Result.status === 'fulfilled' ? jin10Result.value : null;

      if (reuters?.news) {
        setLocalItems({
          items: reuters.news,
          upstreamSignature,
        });
      }

      const parts: string[] = [];
      if (reuters) {
        if (reuters.error) parts.push(`Reuters: ${reuters.error}`);
        else if (reuters.inserted > 0) parts.push(`Reuters +${reuters.inserted}`);
        else parts.push('Reuters: no new items');
      }
      if (jin10 && typeof jin10 === 'object' && 'inserted' in jin10) {
        if (jin10.error) parts.push(`Jin10: ${jin10.error}`);
        else if (jin10.inserted > 0) parts.push(`Jin10 +${jin10.inserted}`);
        else parts.push('Jin10: no new items');
      }
      setFeedback(parts.join(' · ') || 'refreshed');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'refresh failed');
    } finally {
      setLoading(false);
    }
  }, [loading, upstreamSignature, jin10Available]);

  // Determine which source tabs to show
  const showSourceTabs = jin10Available || hasJin10Items;

  return (
    <div className="news-panel">
      <div className="news-panel__head">
        <span className="news-panel__title">News</span>
        <button
          className="shell-button sm"
          onClick={handleRefresh}
          disabled={loading}
          type="button"
        >
          {loading ? '刷新中…' : '立即刷新'}
        </button>
      </div>

      {showSourceTabs && (
        <div className="news-panel__sources">
          {(['all', 'reuters', 'jin10'] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={`news-source-tab${source === s ? ' active' : ''}`}
              onClick={() => setSource(s)}
            >
              {s === 'all' ? 'All' : s === 'reuters' ? 'Reuters' : 'Jin10 快讯'}
            </button>
          ))}
        </div>
      )}

      {feedback && <div className="news-panel__feedback">{feedback}</div>}
      {!feedback && lastStatus && lastStatus !== 'ok' && lastStatus !== 'not_modified' && (
        <div className="news-panel__feedback">{lastStatus}{lastError ? `: ${lastError}` : ''}</div>
      )}
      <div className="news-panel__list">
        {filteredItems.length === 0 && (
          <div className="empty-state sm">
            {source === 'jin10'
              ? '暂无 Jin10 快讯。确认已配置 Token 并启用快讯。'
              : '暂无新闻，点击"立即刷新"拉取。'}
          </div>
        )}
        {filteredItems.map((item) => (
          <a
            className="news-item"
            href={item.url.startsWith('jin10://') ? undefined : item.url}
            key={item.url}
            target="_blank"
            rel="noreferrer"
            title={item.title}
          >
            <div className="news-item__title">
              {item.source === 'jin10' && item.keywords.includes('important') && (
                <span className="news-item__badge important">重要</span>
              )}
              {source === 'all' && (
                <span className={`news-item__badge source ${item.source}`}>
                  {item.source === 'jin10' ? '金十' : 'Reuters'}
                </span>
              )}
              {item.title}
            </div>
            {item.summary && item.source !== 'jin10' && (
              <div className="news-item__summary">{item.summary}</div>
            )}
            <div className="news-item__meta">
              <span>{formatRelativeTime(item.publishedAt)}</span>
              {item.keywords.length > 0 && !item.keywords.includes('important') && (
                <span className="news-item__keywords">· {item.keywords.slice(0, 3).join(' · ')}</span>
              )}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
