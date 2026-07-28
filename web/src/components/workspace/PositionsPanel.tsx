import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, Inbox, NotebookPen, Receipt, X } from 'lucide-react';
import type { ExchangeOrder, ExchangePosition, Lesson } from '../../types';
import { useMarketStore } from '../../stores/marketStore';
import { cancelExchangeOrder, listLessons } from '../../api';
import { useReveal } from '../../utils/reveal';
import './PositionsPanel.css';

const EXCHANGE_LABELS: Record<string, string> = {
  'bitget-demo': 'Bitget Demo',
};

const LESSON_LIMIT = 20;

function signed(value: number, digits = 2): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function pnlTone(value: number): string {
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'flat';
}

function groupByExchange<T extends { exchange: string }>(rows: T[]): [string, T[]][] {
  const grouped: Record<string, T[]> = {};
  for (const row of rows) (grouped[row.exchange] ??= []).push(row);
  return Object.entries(grouped);
}

export function PositionsPanel() {
  const state = useMarketStore((s) => s.state);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const positions = state?.exchangePositions ?? [];
  const orders = state?.exchangeOrders ?? [];

  const refreshLessons = useCallback(async () => {
    setLoading(true);
    try {
      setLessons(await listLessons(undefined, 50));
      setError(null);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : '无法加载 lessons');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshLessons();
  }, [refreshLessons]);

  const handleCancel = async (exchange: string, orderId: string, symbol: string) => {
    setCancelling(orderId);
    try {
      await cancelExchangeOrder(exchange, orderId, symbol);
      setError(null);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : '撤单失败');
    } finally {
      setCancelling(null);
    }
  };

  const totalUnrealized = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const totalNotional = positions.reduce((sum, p) => sum + Math.abs(p.size * p.markPrice), 0);

  return (
    <div className="positions-panel">
      <section className="positions-summary">
        <Stat
          label="持仓"
          value={String(positions.length)}
          hint={totalNotional > 0 ? `名义 ${totalNotional.toFixed(0)}` : '无敞口'}
          tone={positions.length ? undefined : 'muted'}
          index={0}
        />
        <Stat
          label="挂单"
          value={String(orders.length)}
          hint={orders.length ? '等待成交' : '无活跃订单'}
          tone={orders.length ? undefined : 'muted'}
          index={1}
        />
        <Stat
          label="未实现盈亏"
          value={positions.length ? signed(totalUnrealized) : '—'}
          hint={positions.length ? '按当前标记价计' : '无持仓'}
          tone={positions.length ? pnlTone(totalUnrealized) : 'muted'}
          index={2}
        />
        <Stat
          label="Lessons"
          value={loading ? '—' : String(lessons.length)}
          hint={loading ? '加载中' : '来自已平仓交易'}
          tone={lessons.length && !loading ? undefined : 'muted'}
          index={3}
        />
      </section>

      {error ? (
        <div className="positions-error" role="alert">
          <CircleAlert size={15} />
          <span>{error}</span>
          <button
            aria-label="关闭提示"
            className="positions-error__dismiss"
            onClick={() => setError(null)}
            type="button"
          >
            <X size={14} />
          </button>
        </div>
      ) : null}

      <PositionsSection positions={positions} />
      <OrdersSection
        cancelling={cancelling}
        onCancel={handleCancel}
        orders={orders}
      />
      <LessonsSection lessons={lessons} loading={loading} />
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
  index,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: string;
  index: number;
}) {
  const ref = useReveal<HTMLDivElement>(index);
  return (
    <div className="ui-surface positions-stat" data-reveal ref={ref}>
      <span className="positions-stat__label">{label}</span>
      <span className={`positions-stat__value${tone ? ` ${tone}` : ''}`}>{value}</span>
      <span className="positions-stat__hint">{hint}</span>
    </div>
  );
}

function Section({
  title,
  count,
  index,
  children,
}: {
  title: string;
  count?: string;
  index: number;
  children: React.ReactNode;
}) {
  const ref = useReveal<HTMLElement>(index);
  return (
    <section className="ui-surface positions-section" data-reveal ref={ref}>
      <header className="positions-section__head">
        <h2 className="positions-section__title">{title}</h2>
        {count ? <span className="positions-section__count">{count}</span> : null}
      </header>
      {children}
    </section>
  );
}

function PositionsSection({ positions }: { positions: ExchangePosition[] }) {
  return (
    <Section
      count={positions.length ? `${positions.length} 个标的` : undefined}
      index={4}
      title="实时持仓"
    >
      {positions.length === 0 ? (
        <div className="empty-state sm">
          <Inbox size={18} />
          <span>当前没有持仓。开仓后会实时出现在这里。</span>
        </div>
      ) : (
        groupByExchange(positions).map(([exchange, rows]) => (
          <div className="positions-venue" key={exchange}>
            <div className="positions-venue__label">
              {EXCHANGE_LABELS[exchange] ?? exchange}
            </div>
            <div className="positions-table" role="table">
              <div className="positions-row positions-row--position positions-row--head" role="row">
                <span role="columnheader">标的</span>
                <span role="columnheader">方向</span>
                <span className="positions-cell--num" role="columnheader">数量</span>
                <span className="positions-cell--num" role="columnheader">开仓</span>
                <span className="positions-cell--num" role="columnheader">标记</span>
                <span className="positions-cell--num" role="columnheader">盈亏</span>
              </div>
              {rows.map((p) => (
                <div
                  className="positions-row positions-row--position"
                  key={`${p.exchange}:${p.symbol}:${p.side}`}
                  role="row"
                >
                  <span className="positions-cell--sym" role="cell">{p.symbol}</span>
                  <span role="cell">
                    <span className={`positions-side ${p.side === 'long' ? 'long' : 'short'}`}>
                      {p.side === 'long' ? '多' : '空'}
                    </span>
                  </span>
                  <span className="positions-cell--num" role="cell">{p.size}</span>
                  <span className="positions-cell--num" role="cell">{p.entryPrice.toFixed(2)}</span>
                  <span className="positions-cell--num" role="cell">{p.markPrice.toFixed(2)}</span>
                  <span
                    className={`positions-cell--num positions-pnl ${pnlTone(p.unrealizedPnl)}`}
                    role="cell"
                  >
                    {signed(p.unrealizedPnl)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </Section>
  );
}

function OrdersSection({
  orders,
  cancelling,
  onCancel,
}: {
  orders: ExchangeOrder[];
  cancelling: string | null;
  onCancel: (exchange: string, orderId: string, symbol: string) => void;
}) {
  return (
    <Section
      count={orders.length ? `${orders.length} 笔` : undefined}
      index={5}
      title="活跃订单"
    >
      {orders.length === 0 ? (
        <div className="empty-state sm">
          <Receipt size={18} />
          <span>没有等待成交的订单。</span>
        </div>
      ) : (
        groupByExchange(orders).map(([exchange, rows]) => (
          <div className="positions-venue" key={exchange}>
            <div className="positions-venue__label">
              {EXCHANGE_LABELS[exchange] ?? exchange}
            </div>
            <div className="positions-table" role="table">
              <div className="positions-row positions-row--order positions-row--head" role="row">
                <span role="columnheader">标的</span>
                <span role="columnheader">方向</span>
                <span className="positions-cell--num" role="columnheader">数量</span>
                <span className="positions-cell--num" role="columnheader">价格</span>
                <span className="positions-cell--num" role="columnheader">已成</span>
                <span className="positions-cell--action" role="columnheader">操作</span>
              </div>
              {rows.map((o) => (
                <div
                  className="positions-row positions-row--order"
                  key={`${o.exchange}:${o.orderId}`}
                  role="row"
                >
                  <span className="positions-cell--sym" role="cell">{o.symbol}</span>
                  <span role="cell">
                    <span className={`positions-side ${o.side === 'buy' ? 'long' : 'short'}`}>
                      {o.side}
                    </span>
                  </span>
                  <span className="positions-cell--num" role="cell">{o.size}</span>
                  <span className="positions-cell--num" role="cell">
                    {o.price?.toFixed(2) ?? '市价'}
                  </span>
                  <span className="positions-cell--num" role="cell">{o.filledSize}</span>
                  <span className="positions-cell--action" role="cell">
                    <button
                      className="shell-button danger sm"
                      disabled={cancelling === o.orderId}
                      onClick={() => onCancel(o.exchange, o.orderId, o.symbol)}
                      type="button"
                    >
                      {cancelling === o.orderId ? '撤销中' : '撤单'}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </Section>
  );
}

function LessonsSection({ lessons, loading }: { lessons: Lesson[]; loading: boolean }) {
  return (
    <Section
      count={!loading && lessons.length ? `最近 ${Math.min(lessons.length, LESSON_LIMIT)} 条` : undefined}
      index={6}
      title="交易复盘"
    >
      {loading ? (
        <div aria-label="正在加载复盘记录" className="positions-skeleton" role="status">
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton" />
        </div>
      ) : lessons.length === 0 ? (
        <div className="empty-state sm">
          <NotebookPen size={18} />
          <span>还没有复盘记录。平仓后系统会自动沉淀一条。</span>
        </div>
      ) : (
        <div className="positions-lessons">
          {lessons.slice(0, LESSON_LIMIT).map((lesson) => (
            <article className="positions-lesson" key={lesson.id}>
              <div className="positions-lesson__meta">
                <span className="positions-lesson__instrument">{lesson.instrumentKey}</span>
                <span className="positions-lesson__category">{lesson.category || 'general'}</span>
              </div>
              <p className="positions-lesson__text">{lesson.text}</p>
            </article>
          ))}
        </div>
      )}
    </Section>
  );
}
