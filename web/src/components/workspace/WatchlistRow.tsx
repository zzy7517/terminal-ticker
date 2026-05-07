import type { Instrument, Quote } from '../../types';
import { changeClass } from '../../utils';

export function WatchlistRow({
  instrument,
  quote,
  selected,
  onSelect,
}: {
  instrument: Instrument;
  quote: Quote | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={`watch-row ${selected ? 'selected' : ''}`} onClick={onSelect} type="button">
      <div className="watch-left">
        <span className="watch-label">{instrument.label}</span>
        <small className="watch-code">{instrument.symbol}</small>
      </div>
      <div className="watch-right">
        <span className="watch-price">{quote?.priceLabel ?? '-'}</span>
        <span className={`watch-change ${changeClass(quote)}`}>{quote?.percentLabel ?? '-'}</span>
      </div>
    </button>
  );
}
