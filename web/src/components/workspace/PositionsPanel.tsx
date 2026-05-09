import { useCallback, useEffect, useState } from 'react';
import type { ExchangeOrder, ExchangePosition, Lesson } from '../../types';
import { useMarketStore } from '../../stores/marketStore';
import { cancelExchangeOrder, listLessons } from '../../api';

const EXCHANGE_LABELS: Record<string, string> = {
  hyperliquid: 'Hyperliquid',
  'bitget-demo': 'Bitget Demo',
};

export function PositionsPanel() {
  const state = useMarketStore((s) => s.state);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const positions = state?.exchangePositions ?? [];
  const orders = state?.exchangeOrders ?? [];

  const refreshLessons = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const l = await listLessons(undefined, 50);
      setLessons(l);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'load failed');
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
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'cancel failed');
    } finally {
      setCancelling(null);
    }
  };

  const totalUnrealized = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const groupedPositions: Record<string, ExchangePosition[]> = {};
  for (const p of positions) {
    (groupedPositions[p.exchange] ??= []).push(p);
  }
  const groupedOrders: Record<string, ExchangeOrder[]> = {};
  for (const o of orders) {
    (groupedOrders[o.exchange] ??= []).push(o);
  }

  return (
    <div className="agent-main-panel" style={{ gap: 16, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 16 }}>
          <div><strong>持仓</strong> {positions.length}</div>
          <div><strong>挂单</strong> {orders.length}</div>
          <div>
            <strong>未实现盈亏</strong>{' '}
            <span style={{ color: totalUnrealized >= 0 ? '#26a69a' : '#ef5350' }}>
              {totalUnrealized >= 0 ? '+' : ''}{totalUnrealized.toFixed(2)}
            </span>
          </div>
          <div><strong>Lessons</strong> {lessons.length}</div>
        </div>
      </div>

      {error && <div style={{ color: '#e06c75' }}>{error}</div>}

      <section>
        <h3 style={{ margin: '4px 0' }}>实时持仓</h3>
        {positions.length === 0 && <div style={{ opacity: 0.6, padding: 6 }}>无持仓</div>}
        {Object.entries(groupedPositions).map(([exchange, items]) => (
          <div key={exchange} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>
              {EXCHANGE_LABELS[exchange] ?? exchange}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>标的</th>
                  <th style={{ textAlign: 'left' }}>方向</th>
                  <th style={{ textAlign: 'right' }}>数量</th>
                  <th style={{ textAlign: 'right' }}>开仓均价</th>
                  <th style={{ textAlign: 'right' }}>标记价</th>
                  <th style={{ textAlign: 'right' }}>未实现盈亏</th>
                  <th style={{ textAlign: 'right' }}>杠杆</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={`${p.exchange}:${p.symbol}:${p.side}`}>
                    <td>{p.symbol}</td>
                    <td style={{ color: p.side === 'long' ? '#26a69a' : '#ef5350' }}>
                      {p.side === 'long' ? '多' : '空'}
                    </td>
                    <td style={{ textAlign: 'right' }}>{p.size}</td>
                    <td style={{ textAlign: 'right' }}>{p.entryPrice.toFixed(2)}</td>
                    <td style={{ textAlign: 'right' }}>{p.markPrice.toFixed(2)}</td>
                    <td style={{
                      textAlign: 'right',
                      color: p.unrealizedPnl >= 0 ? '#26a69a' : '#ef5350',
                    }}>
                      {p.unrealizedPnl >= 0 ? '+' : ''}{p.unrealizedPnl.toFixed(2)}
                    </td>
                    <td style={{ textAlign: 'right' }}>{p.leverage != null ? `${p.leverage}x` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      <section>
        <h3 style={{ margin: '4px 0' }}>活跃订单</h3>
        {orders.length === 0 && <div style={{ opacity: 0.6, padding: 6 }}>无挂单</div>}
        {Object.entries(groupedOrders).map(([exchange, items]) => (
          <div key={exchange} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>
              {EXCHANGE_LABELS[exchange] ?? exchange}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>标的</th>
                  <th style={{ textAlign: 'left' }}>方向</th>
                  <th style={{ textAlign: 'left' }}>类型</th>
                  <th style={{ textAlign: 'right' }}>数量</th>
                  <th style={{ textAlign: 'right' }}>价格</th>
                  <th style={{ textAlign: 'right' }}>已成交</th>
                  <th style={{ textAlign: 'left' }}>状态</th>
                  <th style={{ textAlign: 'center' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={`${o.exchange}:${o.orderId}`}>
                    <td>{o.symbol}</td>
                    <td style={{ color: o.side === 'buy' ? '#26a69a' : '#ef5350' }}>
                      {o.side}
                    </td>
                    <td>{o.orderType}</td>
                    <td style={{ textAlign: 'right' }}>{o.size}</td>
                    <td style={{ textAlign: 'right' }}>{o.price?.toFixed(2) ?? 'market'}</td>
                    <td style={{ textAlign: 'right' }}>{o.filledSize}</td>
                    <td>{o.status}</td>
                    <td style={{ textAlign: 'center' }}>
                      <button
                        type="button"
                        className="shell-button danger sm"
                        disabled={cancelling === o.orderId}
                        onClick={() => void handleCancel(o.exchange, o.orderId, o.symbol)}
                      >
                        {cancelling === o.orderId ? '撤销中…' : '撤单'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      <section>
        <h3 style={{ margin: '4px 0' }}>Recent Lessons</h3>
        {loading && <div style={{ opacity: 0.6 }}>加载中…</div>}
        {!loading && lessons.length === 0 && <div style={{ opacity: 0.6 }}>尚未生成 lesson。交易关闭后由 memory 系统自动生成。</div>}
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {lessons.slice(0, 20).map((l) => (
            <li key={l.id}>
              <span style={{ opacity: 0.6 }}>{l.instrumentKey}</span> · [{l.category || 'general'}] {l.text}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
