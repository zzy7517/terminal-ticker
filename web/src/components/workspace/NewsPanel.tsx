import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NewsDecision, NewsItem } from '../../types';
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

function indexDecisionsByUrl(
  decisions: NewsDecision[] | undefined,
): Map<string, NewsDecision[]> {
  const map = new Map<string, NewsDecision[]>();
  if (!decisions) return map;
  for (const d of decisions) {
    const arr = map.get(d.news_url) ?? [];
    arr.push(d);
    map.set(d.news_url, arr);
  }
  return map;
}

export function DecisionBadge({ decision }: { decision: NewsDecision }) {
  const stepLabels: Record<NewsDecision['step'], string> = {
    opened: '已下单',
    cooldown: '冷却中',
    low_confidence: '置信度低',
    entry_too_far: '价偏离',
    gated: '规则拦',
    llm_error: 'LLM 错',
    filter_miss: '未命中',
  };
  const symbol = decision.instrument_key.split(':').pop() ?? decision.instrument_key;
  const dir = decision.direction;
  const className = `news-decision-badge news-decision-badge--${decision.step}${
    dir === 'long' ? ' news-decision-badge--long'
      : dir === 'short' ? ' news-decision-badge--short' : ''
  }`;
  const tooltip = decision.reason || stepLabels[decision.step];
  return (
    <span className={className} title={tooltip}>
      {symbol} · {stepLabels[decision.step]}
      {decision.step === 'opened' && dir && (
        <span className="news-decision-badge__dir">
          {' '}{dir === 'long' ? '↑' : '↓'}
        </span>
      )}
    </span>
  );
}

export function NewsPanel({
  items,
  decisions,
  lastStatus,
  lastError,
}: {
  items: NewsItem[];
  decisions?: NewsDecision[];
  lastStatus?: string;
  lastError?: string | null;
}) {
  const [loading, setLoading] = useState(false);
  const [localItems, setLocalItems] = useState<LocalNewsItems | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const upstreamSignature = useMemo(() => newsItemsSignature(items), [items]);
  const displayItems = localItems?.items ?? items;
  const decisionIndex = useMemo(() => indexDecisionsByUrl(decisions), [decisions]);

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
        {displayItems.map((item) => {
          const itemDecisions = decisionIndex.get(item.url) ?? [];
          return (
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
              {itemDecisions.length > 0 && (
                <div className="news-item__decisions">
                  {itemDecisions.map((d) => (
                    <DecisionBadge key={d.id} decision={d} />
                  ))}
                </div>
              )}
            </a>
          );
        })}
      </div>
    </div>
  );
}
