import type { ReactNode } from 'react';
import { useReveal } from '../utils/reveal';

type RevealProps = {
  /** Staggers against siblings — published as `--reveal-index`. */
  index?: number;
  className?: string;
  children: ReactNode;
};

/**
 * A block that fades and lifts into place the first time it is scrolled into
 * view. Renders as the element itself rather than wrapping one, so dropping it
 * into an existing flex or grid parent does not disturb the layout.
 *
 * Reveals once and then stops observing — see utils/reveal.ts for why that
 * matters on panels backed by live data.
 */
export function Reveal({ index = 0, className, children }: RevealProps) {
  const ref = useReveal<HTMLDivElement>(index);
  return (
    <div className={className} data-reveal ref={ref}>
      {children}
    </div>
  );
}
