/**
 * Day-change spark glyph — visual affordance for RH-style lists.
 * Not historical tick data: the slope encodes today's changePercent only.
 */
export function ChangeSpark({
  changePercent,
  className,
}: {
  changePercent: number | null | undefined;
  className?: string;
}) {
  const pct = changePercent ?? 0;
  const up = pct > 0;
  const flat = pct === 0 || changePercent == null;
  const amp = Math.min(Math.abs(pct) / 8, 1);

  const yStart = flat ? 14 : up ? 22 - amp * 4 : 6 + amp * 4;
  const yMid1 = flat ? 13 : up ? 18 - amp * 6 : 10 + amp * 5;
  const yMid2 = flat ? 15 : up ? 12 - amp * 4 : 16 + amp * 6;
  const yEnd = flat ? 14 : up ? 6 : 22;

  const d = `M 0 ${yStart.toFixed(1)} C 18 ${yMid1.toFixed(1)}, 36 ${yMid2.toFixed(1)}, 56 ${yEnd.toFixed(1)}`;
  const tone = flat ? 'neutral' : up ? 'up' : 'down';

  return (
    <svg
      aria-hidden="true"
      className={`change-spark change-spark--${tone}${className ? ` ${className}` : ''}`}
      fill="none"
      height="28"
      viewBox="0 0 56 28"
      width="56"
    >
      <path d={d} stroke="currentColor" strokeLinecap="round" strokeWidth="1.75" />
    </svg>
  );
}
