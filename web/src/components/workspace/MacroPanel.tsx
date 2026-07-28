import { useCallback, useEffect, useState } from 'react';
import {
  fetchMacroEventWindow,
  fetchMacroEvents,
  fetchMacroSnapshot,
  fetchMacroStatus,
  refreshMacro,
  type MacroCategory,
  type MacroEvent,
  type MacroEventWindow,
  type MacroSeriesStats,
  type MacroSnapshot,
  type MacroStatus,
} from '../../api';
import { Reveal } from '../Reveal';
import './MacroPanel.css';

const CATEGORY_LABELS: Record<MacroCategory, string> = {
  rates: '利率',
  inflation: '通胀',
  dollar: '美元与汇率',
  employment: '就业',
  energy: '能源',
  metals: '贵金属',
  risk: '风险与波动率',
};

const CATEGORY_ORDER: MacroCategory[] = [
  'rates',
  'inflation',
  'dollar',
  'risk',
  'energy',
  'metals',
  'employment',
];

const REFRESH_INTERVAL_MS = 60_000;
const WINDOW_DAYS = 90;

function fmtValue(value: number | null, unit: string | null): string {
  if (value === null) return '--';
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : abs >= 10 ? 2 : 3;
  return `${value.toFixed(digits)}${unit === '%' ? '%' : ''}`;
}

function fmtSigned(value: number | null): string {
  if (value === null) return '--';
  const digits = Math.abs(value) >= 10 ? 2 : 3;
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

/**
 * Age is rendered rather than hidden on purpose: a monthly FRED series is
 * legitimately weeks old, while a 5-minute Binance series being hours old means
 * the feed is broken. Only the reader can tell those apart.
 */
function fmtAge(ageMs: number | null): string {
  if (ageMs === null) return '--';
  const hours = ageMs / 3600_000;
  if (hours < 1) return `${Math.max(Math.round(ageMs / 60_000), 0)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function fmtEventTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  return `${d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${time}`;
}

function percentileClass(percentile: number | null): string {
  if (percentile === null) return '';
  if (percentile >= 90) return 'extreme-high';
  if (percentile <= 10) return 'extreme-low';
  return '';
}

export function MacroPanel() {
  const [snapshot, setSnapshot] = useState<MacroSnapshot | null>(null);
  const [status, setStatus] = useState<MacroStatus | null>(null);
  const [events, setEvents] = useState<MacroEvent[]>([]);
  const [eventWindow, setEventWindow] = useState<MacroEventWindow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [snap, stat, evts, win] = await Promise.all([
        fetchMacroSnapshot(WINDOW_DAYS),
        fetchMacroStatus(),
        fetchMacroEvents({ hoursBack: 12, hoursAhead: 72 }),
        fetchMacroEventWindow(),
      ]);
      setSnapshot(snap);
      setStatus(stat);
      setEvents(evts.events);
      setEventWindow(win);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setFeedback(null);
    try {
      await refreshMacro('all');
      await load();
      setFeedback('已强制刷新全部数据源');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '刷新失败');
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, load]);

  if (error) {
    return (
      <div className="macro-panel__empty">
        <span>宏观环境</span>
        <span>{error}</span>
      </div>
    );
  }

  if (!snapshot || !status) {
    return (
      <div className="macro-panel__empty">
        <span>宏观环境</span>
        <span>加载中…</span>
      </div>
    );
  }

  if (!status.enabled) {
    return (
      <div className="macro-panel__empty">
        <span>宏观环境</span>
        <span>宏观数据层未启用。</span>
        <code>[macro] enabled = true</code>
      </div>
    );
  }

  const byCategory = CATEGORY_ORDER.map((category) => ({
    category,
    rows: snapshot.series.filter((s) => s.category === category),
  })).filter((group) => group.rows.length > 0);

  const withData = snapshot.series.filter((s) => s.latest !== null).length;
  const errored = status.series.filter((s) => s.lastError);

  return (
    <div className="macro-panel">
      <div className="macro-panel__head">
        <span className="macro-panel__title">宏观环境</span>
        <span className="macro-panel__meta">
          {withData}/{snapshot.series.length} 序列有数据 · {WINDOW_DAYS} 日窗口
          {!status.fredConfigured && ' · FRED 未配 key'}
        </span>
        <button className="shell-button sm" type="button" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? '刷新中…' : '强制刷新'}
        </button>
      </div>

      {feedback && <div className="macro-panel__feedback">{feedback}</div>}

      {eventWindow && (
        <div
          className={
            'macro-window' +
            (eventWindow.unknown ? ' unknown' : eventWindow.inWindow ? ' active' : ' clear')
          }
        >
          <span className="macro-window__badge">
            {eventWindow.unknown ? '状态未知' : eventWindow.inWindow ? '静默窗口' : '窗口外'}
          </span>
          <span className="macro-window__text">
            {eventWindow.reason
              ?? (eventWindow.inWindow
                ? '处于数据发布窗口内。'
                : '当前不处于高影响数据发布窗口，开仓不受限制。')}
          </span>
          {eventWindow.blocked && <span className="macro-window__flag">开仓已拦截</span>}
        </div>
      )}

      <div className="macro-derived">
        <Derived label="2s10s 曲线" value={snapshot.derived.curveSteepness} unit="pp" hint="负值为倒挂" />
        <Derived label="10Y 实际利率" value={snapshot.derived.realYield10y} unit="pp" hint="名义 − 盈亏平衡通胀" />
        <Derived label="加密波动率溢价" value={snapshot.derived.cryptoVolPremium} unit="vol" hint="BTC DVOL − VIX" />
      </div>

      {byCategory.map((group, index) => (
        <Reveal className="macro-section ui-surface" index={index} key={group.category}>
          <div className="macro-section__title">{CATEGORY_LABELS[group.category]}</div>
          <div className="macro-table">
            <div className="macro-row macro-row--head">
              <span>指标</span>
              <span>最新</span>
              <span>变化</span>
              <span>窗口变化</span>
              <span>Z</span>
              <span>分位</span>
              <span>数据年龄</span>
            </div>
            {group.rows.map((row) => (
              <SeriesRow key={row.seriesId} row={row} />
            ))}
          </div>
        </Reveal>
      ))}

      <Reveal className="macro-section ui-surface" index={byCategory.length}>
        <div className="macro-section__title">
          财经日历
          <span className={'macro-badge' + (status.calendar.fresh ? ' ok' : ' warn')}>
            {status.calendar.fresh ? '数据新鲜' : '数据陈旧'}
          </span>
        </div>
        {events.length === 0 ? (
          <div className="macro-empty-row">
            {status.calendar.fresh ? '未来 72 小时内无已知事件。' : '日历副本已陈旧，「无事件」不可信。'}
          </div>
        ) : (
          <div className="macro-events">
            {events.map((event) => (
              <div className={`macro-event impact-${event.impact}`} key={event.key}>
                <span className="macro-event__time">{fmtEventTime(event.pubTimeMs)}</span>
                <span className="macro-event__title">
                  {event.title}
                  {event.star ? <span className="macro-event__stars">{'★'.repeat(Math.min(event.star, 5))}</span> : null}
                </span>
                <span className="macro-event__values">
                  前 {event.previous || '--'} / 预 {event.consensus || '--'} / 实 {event.actual || '--'}
                </span>
              </div>
            ))}
          </div>
        )}
      </Reveal>

      {errored.length > 0 && (
        <Reveal className="macro-section ui-surface" index={byCategory.length + 1}>
          <div className="macro-section__title">采集错误</div>
          <div className="macro-errors">
            {errored.map((s) => (
              <div className="macro-error" key={s.seriesId}>
                <span className="macro-error__id">{s.seriesId}</span>
                <span className="macro-error__msg">{s.lastError}</span>
              </div>
            ))}
          </div>
        </Reveal>
      )}
    </div>
  );
}

function SeriesRow({ row }: { row: MacroSeriesStats }) {
  const missing = row.latest === null;
  return (
    <div className={'macro-row' + (missing ? ' macro-row--missing' : '')}>
      <span className="macro-row__label">
        {row.label}
        <code>{row.seriesId}</code>
      </span>
      <span className="macro-row__value">{fmtValue(row.latest, row.unit)}</span>
      <span className={'macro-row__num' + (row.changeAbs !== null && row.changeAbs !== 0 ? (row.changeAbs > 0 ? ' up' : ' down') : '')}>
        {fmtSigned(row.changeAbs)}
      </span>
      <span className={'macro-row__num' + (row.windowChangeAbs !== null && row.windowChangeAbs !== 0 ? (row.windowChangeAbs > 0 ? ' up' : ' down') : '')}>
        {fmtSigned(row.windowChangeAbs)}
      </span>
      <span className="macro-row__num">{row.zScore === null ? '--' : row.zScore.toFixed(2)}</span>
      <span className={`macro-row__num ${percentileClass(row.percentile)}`}>
        {row.percentile === null ? '--' : `${row.percentile.toFixed(0)}%`}
      </span>
      <span className="macro-row__age">{missing ? '无数据' : fmtAge(row.ageMs)}</span>
    </div>
  );
}

function Derived({
  label,
  value,
  unit,
  hint,
}: {
  label: string;
  value: number | null;
  unit: string;
  hint: string;
}) {
  return (
    <div className="macro-derived__item ui-surface">
      <span className="macro-derived__label">{label}</span>
      <span className={'macro-derived__value' + (value === null ? ' missing' : value < 0 ? ' negative' : '')}>
        {value === null ? '--' : `${value >= 0 ? '+' : ''}${value.toFixed(2)} ${unit}`}
      </span>
      <span className="macro-derived__hint">{hint}</span>
    </div>
  );
}
