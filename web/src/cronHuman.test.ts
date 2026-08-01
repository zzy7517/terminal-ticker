import { describe, expect, it } from 'vitest';
import {
  CRON_PRESETS,
  CRON_PRESET_GROUPS,
  buildCronFromFields,
  cronToHuman,
  humanToCron,
  parseCronFields,
} from './cronHuman';

describe('cronToHuman', () => {
  it('renders daily times', () => {
    expect(cronToHuman('0 8 * * *')).toBe('每天 08:00');
    expect(cronToHuman('30 9 * * *')).toBe('每天 09:30');
  });

  it('renders weekday and weekend shorthands', () => {
    expect(cronToHuman('0 8 * * 1-5')).toBe('每个工作日 08:00');
    expect(cronToHuman('0 10 * * 0,6')).toBe('每个周末 10:00');
  });

  it('renders single and multiple weekdays', () => {
    expect(cronToHuman('0 9 * * 1')).toBe('每周一 09:00');
    expect(cronToHuman('0 9 * * 1,3')).toBe('每周 周一、周三 09:00');
  });

  it('renders minute and hour intervals', () => {
    expect(cronToHuman('*/15 * * * *')).toBe('每 15 分钟');
    expect(cronToHuman('0 */2 * * *')).toBe('每 2 小时');
    expect(cronToHuman('30 */4 * * *')).toBe('每 4 小时 30分');
  });

  it('renders hourly expressions', () => {
    expect(cronToHuman('0 * * * *')).toBe('每天 每小时整点');
    expect(cronToHuman('45 * * * *')).toBe('每天 每小时 45分');
  });

  it('renders comma-separated hours', () => {
    expect(cronToHuman('0 9,15 * * *')).toBe('每天 09:00, 15:00');
  });

  it('renders month + day-of-month schedules', () => {
    expect(cronToHuman('0 0 1 1 *')).toBe('1月1日 00:00');
  });

  it('appends timezone labels, mapping known zones', () => {
    expect(cronToHuman('0 8 * * *', 'Asia/Shanghai')).toBe('每天 08:00 (北京)');
    expect(cronToHuman('0 8 * * *', 'America/New_York')).toBe('每天 08:00 (美东)');
    expect(cronToHuman('0 8 * * *', 'Europe/Berlin')).toBe('每天 08:00 (Europe/Berlin)');
  });

  it('returns malformed expressions unchanged', () => {
    expect(cronToHuman('not a cron')).toBe('not a cron');
    expect(cronToHuman('0 8 * *')).toBe('0 8 * *');
  });
});

describe('humanToCron', () => {
  it('parses interval phrases', () => {
    expect(humanToCron('每5分钟')).toBe('*/5 * * * *');
    expect(humanToCron('每2小时')).toBe('0 */2 * * *');
    expect(humanToCron('每小时')).toBe('0 * * * *');
    expect(humanToCron('每小时整点')).toBe('0 * * * *');
  });

  it('parses daily phrases with times', () => {
    expect(humanToCron('每天 8:30')).toBe('30 8 * * *');
    expect(humanToCron('每天 08:00')).toBe('0 8 * * *');
    expect(humanToCron('每天8点')).toBe('0 8 * * *');
    // 全角冒号
    expect(humanToCron('每天 8：30')).toBe('30 8 * * *');
  });

  it('parses morning/afternoon/evening phrases', () => {
    expect(humanToCron('每天 早上 8点')).toBe('0 8 * * *');
    expect(humanToCron('每天 下午 3点')).toBe('0 15 * * *');
    expect(humanToCron('每天 晚上 9点')).toBe('0 21 * * *');
  });

  it('parses weekday phrases with and without 个', () => {
    expect(humanToCron('每工作日 9:30')).toBe('30 9 * * 1-5');
    expect(humanToCron('每个工作日 9:30')).toBe('30 9 * * 1-5');
    expect(humanToCron('每个工作日 下午 4点')).toBe('0 16 * * 1-5');
  });

  it('parses weekly phrases', () => {
    expect(humanToCron('每周一 9:00')).toBe('0 9 * * 1');
    expect(humanToCron('每周日 20点')).toBe('0 20 * * 0');
  });

  it('passes through raw five-field cron expressions', () => {
    expect(humanToCron('15 7 * * 2')).toBe('15 7 * * 2');
  });

  it('returns null for unparseable input', () => {
    expect(humanToCron('')).toBeNull();
    expect(humanToCron('随便什么')).toBeNull();
  });
});

describe('parseCronFields / buildCronFromFields', () => {
  it('round-trips a full expression', () => {
    const fields = parseCronFields('30 9 1 6 1-5');
    expect(fields).toEqual({ minute: '30', hour: '9', dayOfMonth: '1', month: '6', dayOfWeek: '1-5' });
    expect(buildCronFromFields(fields)).toBe('30 9 1 6 1-5');
  });

  it('fills missing fields with wildcards', () => {
    expect(parseCronFields('30 9')).toEqual({
      minute: '30', hour: '9', dayOfMonth: '*', month: '*', dayOfWeek: '*',
    });
  });
});

describe('presets', () => {
  it('every preset cron is a five-field expression its own humanizer can render', () => {
    const all = [
      ...CRON_PRESETS,
      ...CRON_PRESET_GROUPS.flatMap((group) => group.presets),
    ];
    for (const preset of all) {
      expect(preset.cron.trim().split(/\s+/)).toHaveLength(5);
      // 渲染结果不应原样返回（原样返回意味着 humanizer 解析失败）。
      expect(cronToHuman(preset.cron)).not.toBe(preset.cron);
    }
  });
});
