import type { Instrument, Quote } from '../../types';
import { changeClass } from '../../utils/marketDisplay';
import './QuoteDetail.css';

function formatNum(value: number | null | undefined, digits = 2): string {
  if (value == null || Number.isNaN(value)) return '—';
  return value.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function dayRangePosition(quote: Quote): number | null {
  const { price, dayHigh, dayLow } = quote;
  if (price == null || dayHigh == null || dayLow == null) return null;
  if (dayHigh <= dayLow) return 0.5;
  return Math.min(1, Math.max(0, (price - dayLow) / (dayHigh - dayLow)));
}

export function QuoteDetail({
  instrument,
  quote,
}: {
  instrument: Instrument | null;
  quote: Quote | undefined;
}) {
  if (!instrument) {
    return (
      <div className="quote-detail quote-detail--empty">
        <h2 className="quote-detail__empty-title">选择一个标的</h2>
        <p className="quote-detail__empty-body">
          从左侧列表点选后，这里会显示现价、涨跌和当日区间。数据来自当前行情快照。
        </p>
      </div>
    );
  }

  const tone = changeClass(quote);
  const rangePos = quote ? dayRangePosition(quote) : null;

  return (
    <article className="quote-detail">
      <header className="quote-detail__head">
        <div>
          <h2 className="quote-detail__name">{instrument.label}</h2>
          <p className="quote-detail__symbol">
            {instrument.symbol}
            {quote?.exchange ? ` · ${quote.exchange}` : ''}
            {quote?.currency ? ` · ${quote.currency}` : ''}
          </p>
        </div>
        {quote?.stale ? <span className="quote-detail__stale">数据陈旧</span> : null}
      </header>

      <div className="quote-detail__price-block">
        <div className="quote-detail__price">{quote?.priceLabel ?? '—'}</div>
        <div className={`quote-detail__change ${tone}`}>
          <span>{quote?.changeLabel ?? '—'}</span>
          <span>{quote?.percentLabel ?? '—'}</span>
        </div>
        {quote?.ageLabel ? (
          <div className="quote-detail__age">更新 {quote.ageLabel}</div>
        ) : null}
      </div>

      {rangePos != null && quote ? (
        <section className="quote-detail__range" aria-label="当日价格区间">
          <div className="quote-detail__range-labels">
            <span>日低 {formatNum(quote.dayLow)}</span>
            <span>日高 {formatNum(quote.dayHigh)}</span>
          </div>
          <div className="quote-detail__range-track">
            <span
              className={`quote-detail__range-marker ${tone}`}
              style={{ left: `${rangePos * 100}%` }}
            />
          </div>
          <p className="quote-detail__range-hint">当日高低区间（非历史走势图）</p>
        </section>
      ) : null}

      <section className="quote-detail__stats" aria-label="关键数据">
        <Stat label="昨收" value={formatNum(quote?.previousClose ?? null)} />
        <Stat label="日高" value={formatNum(quote?.dayHigh ?? null)} />
        <Stat label="日低" value={formatNum(quote?.dayLow ?? null)} />
        <Stat label="成交量" value={quote?.volumeLabel || '—'} />
      </section>

      {quote?.lastError ? (
        <p className="quote-detail__error" role="status">{quote.lastError}</p>
      ) : null}
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="quote-detail__stat">
      <span className="quote-detail__stat-label">{label}</span>
      <span className="quote-detail__stat-value">{value}</span>
    </div>
  );
}
