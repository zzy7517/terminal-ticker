const DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

export interface CronPreset {
  label: string;
  cron: string;
}

export const CRON_PRESETS: CronPreset[] = [
  { label: '每个工作日 08:00', cron: '0 8 * * 1-5' },
  { label: '每个工作日 09:30', cron: '30 9 * * 1-5' },
  { label: '每个工作日 16:00', cron: '0 16 * * 1-5' },
  { label: '每天 00:00', cron: '0 0 * * *' },
  { label: '每天 08:00', cron: '0 8 * * *' },
  { label: '每天 12:00', cron: '0 12 * * *' },
  { label: '每天 20:00', cron: '0 20 * * *' },
  { label: '每小时整点', cron: '0 * * * *' },
  { label: '每 30 分钟', cron: '*/30 * * * *' },
  { label: '每 15 分钟', cron: '*/15 * * * *' },
  { label: '每 5 分钟', cron: '*/5 * * * *' },
  { label: '每周一 09:00', cron: '0 9 * * 1' },
];

const TZ_LABELS: Record<string, string> = {
  'Asia/Shanghai': '北京',
  'America/New_York': '美东',
  'Etc/UTC': 'UTC',
};

export function cronToHuman(expr: string, timezone?: string | null): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;

  const timeStr = formatTime(min, hour);
  const dowStr = formatDow(dow);
  const domStr = formatDom(dom);
  const monStr = formatMon(mon);

  let result: string;

  if (mon !== '*' && dom !== '*') {
    result = `${monStr}${domStr} ${timeStr}`;
  } else if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    const n = min.slice(2);
    result = `每 ${n} 分钟`;
  } else if (min !== '*' && hour.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
    const n = hour.slice(2);
    const m = min === '0' ? '' : ` ${min}分`;
    result = `每 ${n} 小时${m}`;
  } else if (dom === '*' && mon === '*') {
    if (dow === '*') result = `每天 ${timeStr}`;
    else result = `${dowStr} ${timeStr}`;
  } else {
    result = `${monStr}${domStr}${dowStr} ${timeStr}`;
  }

  if (timezone) {
    const label = TZ_LABELS[timezone] ?? timezone;
    result += ` (${label})`;
  }
  return result;
}

function formatTime(min: string, hour: string): string {
  if (hour === '*' && min === '0') return '每小时整点';
  if (hour === '*') return `每小时 ${min}分`;
  if (hour.includes(',')) {
    const hours = hour.split(',').map((h) => `${h.padStart(2, '0')}:${min.padStart(2, '0')}`);
    return hours.join(', ');
  }
  return `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
}

function formatDow(dow: string): string {
  if (dow === '*') return '';
  if (dow === '1-5' || dow === 'MON-FRI') return '每个工作日';
  if (dow === '0,6' || dow === 'SAT,SUN') return '每个周末';
  const days = dow.split(',').map((d) => {
    const n = Number(d);
    return Number.isFinite(n) && n >= 0 && n <= 6 ? `周${DAY_NAMES[n]}` : d;
  });
  if (days.length === 1) return `每${days[0]}`;
  return `每周 ${days.join('、')}`;
}

function formatDom(dom: string): string {
  if (dom === '*') return '';
  return `${dom}日`;
}

function formatMon(mon: string): string {
  if (mon === '*') return '';
  return `${mon}月`;
}

const HUMAN_PATTERNS: Array<{ re: RegExp; toCron: (...m: string[]) => string }> = [
  { re: /^每(\d+)分钟$/, toCron: (_, n) => `*/${n} * * * *` },
  { re: /^每(\d+)小时$/, toCron: (_, n) => `0 */${n} * * *` },
  { re: /^每小时(整点)?$/, toCron: () => '0 * * * *' },
  { re: /^每天\s*(\d{1,2})[:：：](\d{2})$/, toCron: (_, h, m) => `${Number(m)} ${Number(h)} * * *` },
  { re: /^每天\s*(\d{1,2})点$/, toCron: (_, h) => `0 ${Number(h)} * * *` },
  { re: /^每天\s*早上\s*(\d{1,2})点$/, toCron: (_, h) => `0 ${Number(h)} * * *` },
  { re: /^每天\s*下午\s*(\d{1,2})点$/, toCron: (_, h) => `0 ${Number(h) + 12} * * *` },
  { re: /^每天\s*晚上\s*(\d{1,2})点$/, toCron: (_, h) => `0 ${Number(h) + 12} * * *` },
  { re: /^每(个)?工作日\s*(\d{1,2})[:：：](\d{2})$/, toCron: (_, _g, h, m) => `${Number(m)} ${Number(h)} * * 1-5` },
  { re: /^每(个)?工作日\s*(\d{1,2})点$/, toCron: (_, _g, h) => `0 ${Number(h)} * * 1-5` },
  { re: /^每(个)?工作日\s*早上\s*(\d{1,2})点$/, toCron: (_, _g, h) => `0 ${Number(h)} * * 1-5` },
  { re: /^每(个)?工作日\s*下午\s*(\d{1,2})点$/, toCron: (_, _g, h) => `0 ${Number(h) + 12} * * 1-5` },
  { re: /^每周([一二三四五六日])\s*(\d{1,2})[:：：](\d{2})$/, toCron: (_, d, h, m) => `${Number(m)} ${Number(h)} * * ${dayToNum(d)}` },
  { re: /^每周([一二三四五六日])\s*(\d{1,2})点$/, toCron: (_, d, h) => `0 ${Number(h)} * * ${dayToNum(d)}` },
];

function dayToNum(d: string): number {
  const idx = DAY_NAMES.indexOf(d);
  return idx >= 0 ? idx : 0;
}

export function humanToCron(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(trimmed)) return trimmed;
  for (const { re, toCron } of HUMAN_PATTERNS) {
    const match = trimmed.match(re);
    if (match) return toCron(...match);
  }
  return null;
}

// ── Grouped presets ──────────────────────────────────────────────────────

export interface CronPresetWithTz extends CronPreset {
  suggestedTimezone?: string | null;
}

export interface CronPresetGroup {
  category: string;
  presets: CronPresetWithTz[];
}

export const CRON_PRESET_GROUPS: CronPresetGroup[] = [
  {
    category: '交易时段',
    presets: [
      { label: '美股盘前 08:00', cron: '0 8 * * 1-5', suggestedTimezone: 'America/New_York' },
      { label: '美股开盘 09:30', cron: '30 9 * * 1-5', suggestedTimezone: 'America/New_York' },
      { label: '美股收盘 16:00', cron: '0 16 * * 1-5', suggestedTimezone: 'America/New_York' },
      { label: 'A股开盘 09:30', cron: '30 9 * * 1-5', suggestedTimezone: 'Asia/Shanghai' },
      { label: 'A股收盘 15:00', cron: '0 15 * * 1-5', suggestedTimezone: 'Asia/Shanghai' },
    ],
  },
  {
    category: '固定间隔',
    presets: [
      { label: '每 15 分钟', cron: '*/15 * * * *' },
      { label: '每 30 分钟', cron: '*/30 * * * *' },
      { label: '每小时', cron: '0 * * * *' },
      { label: '每 2 小时', cron: '0 */2 * * *' },
      { label: '每 4 小时', cron: '0 */4 * * *' },
    ],
  },
  {
    category: '每日 / 每周',
    presets: [
      { label: '每天 08:00', cron: '0 8 * * *' },
      { label: '每天 22:00', cron: '0 22 * * *' },
      { label: '每个工作日 08:00', cron: '0 8 * * 1-5' },
      { label: '每个工作日 18:00', cron: '0 18 * * 1-5' },
      { label: '每周一 09:00', cron: '0 9 * * 1' },
    ],
  },
];

// ── Visual cron field helpers ────────────────────────────────────────────

export interface CronFields {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

export function parseCronFields(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  return {
    minute: parts[0] ?? '*',
    hour: parts[1] ?? '*',
    dayOfMonth: parts[2] ?? '*',
    month: parts[3] ?? '*',
    dayOfWeek: parts[4] ?? '*',
  };
}

export function buildCronFromFields(fields: CronFields): string {
  return `${fields.minute} ${fields.hour} ${fields.dayOfMonth} ${fields.month} ${fields.dayOfWeek}`;
}

export const TIMEZONE_OPTIONS: Array<{ value: string | null; label: string }> = [
  { value: null, label: '系统默认' },
  { value: 'Asia/Shanghai', label: '北京时间 (UTC+8)' },
  { value: 'America/New_York', label: '美东时间 (ET)' },
  { value: 'Etc/UTC', label: '格林威治时间 (UTC)' },
];
