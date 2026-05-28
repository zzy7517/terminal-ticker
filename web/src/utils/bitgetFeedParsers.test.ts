import { describe, expect, it } from 'vitest';
import { parseFundingSnapshot } from '../../../tradex/data_feeds/funding_history';
import { parseLongShortRatioData } from '../../../tradex/data_feeds/long_short_ratio';
import { parseOpenInterest } from '../../../tradex/data_feeds/oi_delta';

const target = {
  instrumentKey: 'USDT-FUTURES:BTCUSDT',
  symbol: 'BTCUSDT',
  productType: 'USDT-FUTURES',
};

describe('Bitget feed parsers', () => {
  it('parses current funding-rate array responses', () => {
    const parsed = parseFundingSnapshot({
      code: '00000',
      data: [{
        symbol: 'BTCUSDT',
        fundingRate: '0.000097',
        nextUpdate: '1779955200000',
      }],
    }, target, '2026-05-28T00:00:00.000Z');

    expect(parsed).toEqual({
      instrumentKey: 'USDT-FUTURES:BTCUSDT',
      rate: 0.000097,
      nextFundingTime: '1779955200000',
      timestamp: '2026-05-28T00:00:00.000Z',
    });
  });

  it('parses current account long/short response field names', () => {
    const parsed = parseLongShortRatioData({
      code: '00000',
      data: [{
        longAccountRatio: '0.6512',
        shortAccountRatio: '0.3488',
        longShortAccountRatio: '1.8669',
        ts: '1779940500000',
      }],
    }, target);

    expect(parsed?.instrumentKey).toBe('USDT-FUTURES:BTCUSDT');
    expect(parsed?.ratio).toBe(1.8669);
    expect(parsed?.longPct).toBeCloseTo(65.12);
    expect(parsed?.shortPct).toBeCloseTo(34.88);
  });

  it('parses current open-interest list response shape', () => {
    const oi = parseOpenInterest({
      code: '00000',
      data: {
        openInterestList: [{ symbol: 'BTCUSDT', size: '32324.8038' }],
        ts: '1779949706151',
      },
    });

    expect(oi).toBe(32324.8038);
  });

  it('rejects missing or invalid numeric values', () => {
    expect(parseFundingSnapshot({ data: [{ fundingRate: 'not-a-number' }] }, target)).toBeNull();
    expect(parseLongShortRatioData({ data: [{ longShortAccountRatio: '' }] }, target)).toBeNull();
    expect(parseOpenInterest({ data: { openInterestList: [{ size: '0' }] } })).toBeNull();
  });
});
