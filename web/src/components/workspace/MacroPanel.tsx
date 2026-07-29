import { useCallback, useEffect, useMemo, useState } from 'react';
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
import './MacroPanel.css';

const CATEGORY_LABELS: Record<MacroCategory, string> = {
  rates: '利率',
  inflation: '通胀',
  dollar: '美元',
  employment: '就业',
  energy: '能源',
  metals: '贵金属',
  risk: '风险',
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

type MacroTab = 'overview' | MacroCategory | 'calendar';

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

export function MacroPanel() {
  const [snapshot, setSnapshot] = useState<MacroSnapshot | null>(null);
  const [status, setStatus] = useState<MacroStatus | null>(null);
  const [events, setEvents] = useState<MacroEvent[]>([]);
  const [eventWindow, setEventWindow] = useState<MacroEventWindow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [tab, setTab] = useState<MacroTab>('overview');

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

  const availableCategories = useMemo(() => {
    if (!snapshot) return [] as MacroCategory[];
    return CATEGORY_ORDER.filter((category) =>
      snapshot.series.some((s) => s.category === category),
    );
  }, [snapshot]);

  useEffect(() => {
    if (tab === 'overview' || tab === 'calendar') return;
    if (!availableCategories.includes(tab)) setTab('overview');
  }, [tab, availableCategories]);

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

  const withData = snapshot.series.filter((s) => s.latest !== null).length;
  const errored = status.series.filter((s) => s.lastError);
  const activeRows =
    tab !== 'overview' && tab !== 'calendar'
      ? snapshot.series.filter((s) => s.category === tab)
      : [];

  const tabs: { id: MacroTab; label: string }[] = [
    { id: 'overview', label: '概览' },
    ...availableCategories.map((id) => ({ id, label: CATEGORY_LABELS[id] })),
    { id: 'calendar', label: '日历' },
  ];

  return (
    <div className="macro-panel">
      <div className="macro-panel__toolbar">
        <p className="macro-panel__meta">
          {withData}/{snapshot.series.length} 个序列有数据 · {WINDOW_DAYS} 日窗口
          {!status.fredConfigured && ' · FRED 未配置'}
        </p>
        <button className="shell-button sm" type="button" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? '刷新中…' : '强制刷新'}
        </button>
      </div>

      <div className="macro-tabs" role="tablist" aria-label="宏观分区">
        {tabs.map((item) => (
          <button
            aria-selected={tab === item.id}
            className={'macro-tab' + (tab === item.id ? ' active' : '')}
            key={item.id}
            onClick={() => setTab(item.id)}
            role="tab"
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>

      {feedback ? <div className="macro-panel__feedback">{feedback}</div> : null}

      <div className="macro-panel__body" role="tabpanel">
        {tab === 'overview' ? (
          <OverviewTab
            derived={snapshot.derived}
            errored={errored}
            eventWindow={eventWindow}
            onOpenCalendar={() => setTab('calendar')}
          />
        ) : null}

        {tab !== 'overview' && tab !== 'calendar' ? (
          <CategoryTab category={tab} rows={activeRows} />
        ) : null}

        {tab === 'calendar' ? (
          <CalendarTab
            events={events}
            fresh={status.calendar.fresh}
          />
        ) : null}
      </div>
    </div>
  );
}

function OverviewTab({
  derived,
  eventWindow,
  errored,
  onOpenCalendar,
}: {
  derived: MacroSnapshot['derived'];
  eventWindow: MacroEventWindow | null;
  errored: MacroStatus['series'];
  onOpenCalendar: () => void;
}) {
  return (
    <div className="macro-overview">
      {eventWindow ? (
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
          {eventWindow.blocked ? <span className="macro-window__flag">开仓已拦截</span> : null}
        </div>
      ) : null}

      <div className="macro-derived">
        <Derived label="2s10s 曲线" value={derived.curveSteepness} unit="pp" hint="负值为倒挂" />
        <Derived label="10Y 实际利率" value={derived.realYield10y} unit="pp" hint="名义 − 盈亏平衡通胀" />
        <Derived label="加密波动率溢价" value={derived.cryptoVolPremium} unit="vol" hint="BTC DVOL − VIX" />
      </div>

      <div className="macro-overview__hints">
        <button className="macro-overview__link" type="button" onClick={onOpenCalendar}>
          查看财经日历
        </button>
        {errored.length > 0 ? (
          <span className="macro-overview__errors">{errored.length} 个序列采集失败</span>
        ) : null}
      </div>

      {errored.length > 0 ? (
        <section className="macro-section">
          <h2 className="macro-section__title">采集错误</h2>
          <div className="macro-errors">
            {errored.map((s) => (
              <div className="macro-error" key={s.seriesId}>
                <span className="macro-error__id">{s.seriesId}</span>
                <span className="macro-error__msg">{s.lastError}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function CategoryTab({
  category,
  rows,
}: {
  category: MacroCategory;
  rows: MacroSeriesStats[];
}) {
  return (
    <section className="macro-section">
      <h2 className="macro-section__title">{CATEGORY_LABELS[category]}</h2>
      {rows.length === 0 ? (
        <div className="macro-empty-row">这个分类暂时没有序列。</div>
      ) : (
        <div className="macro-tile-grid">
          {rows.map((row) => (
            <SeriesTile key={row.seriesId} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}

function CalendarTab({
  events,
  fresh,
}: {
  events: MacroEvent[];
  fresh: boolean;
}) {
  return (
    <section className="macro-section">
      <h2 className="macro-section__title">
        财经日历
        <span className={'macro-badge' + (fresh ? ' ok' : ' warn')}>
          {fresh ? '数据新鲜' : '数据陈旧'}
        </span>
      </h2>
      {events.length === 0 ? (
        <div className="macro-empty-row">
          {fresh ? '未来 72 小时内无已知事件。' : '日历副本已陈旧，「无事件」不可信。'}
        </div>
      ) : (
        <div className="macro-events">
          {events.map((event) => (
            <div className={`macro-event impact-${event.impact}`} key={event.key}>
              <span className="macro-event__time">{fmtEventTime(event.pubTimeMs)}</span>
              <span className="macro-event__title">
                {event.title}
                {event.star ? <span className="macro-event__stars">{'★'.repeat(Math.min(event.star, 5))}</span> : null}
                {event.provider ? (
                  <span className="macro-event__provider">{event.provider === 'forexfactory' ? 'FF' : event.provider}</span>
                ) : null}
              </span>
              <span className="macro-event__values">
                前 {event.previous || '--'} / 预 {event.consensus || '--'} / 实 {event.actual || '--'}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SeriesTile({ row }: { row: MacroSeriesStats }) {
  const missing = row.latest === null;
  const changeTone =
    row.changeAbs === null || row.changeAbs === 0 ? 'flat' : row.changeAbs > 0 ? 'up' : 'down';
  const hot =
    row.percentile !== null && (row.percentile >= 90 || row.percentile <= 10);

  return (
    <article className={'macro-tile' + (missing ? ' macro-tile--missing' : '')}>
      <div>
        <div className="macro-tile__label">{row.label}</div>
        <div className="macro-tile__id">{row.seriesId}</div>
      </div>
      <div className="macro-tile__value">{fmtValue(row.latest, row.unit)}</div>
      <div className={`macro-tile__change ${changeTone}`}>
        {fmtSigned(row.changeAbs)}
        {row.windowChangeAbs !== null ? ` · 窗 ${fmtSigned(row.windowChangeAbs)}` : ''}
      </div>
      <div className="macro-tile__meta">
        <span>Z {row.zScore === null ? '--' : row.zScore.toFixed(2)}</span>
        <span className={hot ? 'hot' : undefined}>
          分位 {row.percentile === null ? '--' : `${row.percentile.toFixed(0)}%`}
        </span>
        <span>{missing ? '无数据' : fmtAge(row.ageMs)}</span>
      </div>
    </article>
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
        {value === null ? '--' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}`}
        {value !== null ? <span className="macro-derived__unit">{unit}</span> : null}
      </span>
      <span className="macro-derived__hint">{hint}</span>
    </div>
  );
}
