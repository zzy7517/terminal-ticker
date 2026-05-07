import { useCallback, useEffect, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import type { SocialFeedItem } from '../../types';
import { useMarketStore } from '../../stores/marketStore';
import { fetchRecentSocialFeed, triggerXFollowingRefresh } from '../../api';

const SOCIAL_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

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

export function SocialFeedPanel() {
  const enabled = useMarketStore((s) => s.state?.config.socialFeed?.enabled ?? false);
  const [items, setItems] = useState<SocialFeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null);

  const loadFeed = useCallback(async () => {
    setLoading(true);
    try {
      const feed = await fetchRecentSocialFeed(40);
      setItems(feed);
      setFeedback(null);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to load feed');
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshFeed = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setFeedback(null);
    try {
      const result = await triggerXFollowingRefresh(20);
      const feed = await fetchRecentSocialFeed(40);
      setItems(feed);
      setLastRefreshed(Date.now());
      if (result.status === 'ok') {
        setFeedback(result.inserted > 0 ? `${result.inserted} new items` : 'no new items');
      } else {
        setFeedback(`${result.status}: ${result.error ?? 'unknown'}`);
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  useEffect(() => {
    if (!enabled) return;
    void loadFeed();
  }, [enabled, loadFeed]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => void refreshFeed(), SOCIAL_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, refreshFeed]);

  if (!enabled) {
    return (
      <div className="social-tab-panel">
        <div className="social-tab-panel__empty">
          Social feed is disabled. Enable it in <strong>Settings → Social</strong>.
        </div>
      </div>
    );
  }

  return (
    <div className="social-tab-panel">
      <div className="social-tab-panel__head">
        <span className="social-tab-panel__title">X Following</span>
        <div className="social-tab-panel__actions">
          {lastRefreshed && (
            <span className="social-tab-panel__last-refresh">
              Last: {new Date(lastRefreshed).toLocaleTimeString()}
            </span>
          )}
          <button
            className="news-refresh-btn"
            onClick={() => void refreshFeed()}
            disabled={refreshing || loading}
            type="button"
          >
            {refreshing ? '刷新中…' : '立即刷新'}
          </button>
        </div>
      </div>
      {feedback && <div className="social-tab-panel__feedback">{feedback}</div>}
      {loading && items.length === 0 && (
        <div className="social-tab-panel__empty">
          <Loader2 className="spin" size={16} /> Loading feed…
        </div>
      )}
      <div className="social-tab-panel__list">
        {items.map((item) => (
          <a
            className="social-feed-item"
            href={item.url}
            key={`${item.source}:${item.externalId}`}
            target="_blank"
            rel="noreferrer"
          >
            <div className="social-feed-item__header">
              {item.author.profileImageUrl && (
                <img
                  className="social-feed-item__avatar"
                  src={item.author.profileImageUrl}
                  alt=""
                  loading="lazy"
                />
              )}
              <strong className="social-feed-item__handle">
                @{item.author.handle}
                {item.author.verified && <Sparkles size={12} className="social-feed-item__verified" />}
              </strong>
              <span className="social-feed-item__name">{item.author.name}</span>
              <time className="social-feed-item__time">{formatRelativeTime(item.createdAt)}</time>
            </div>
            <div className="social-feed-item__text">{item.text}</div>
          </a>
        ))}
        {!loading && items.length === 0 && (
          <div className="social-tab-panel__empty">暂无推文，点击"立即刷新"拉取。</div>
        )}
      </div>
    </div>
  );
}
