import { useCallback, useRef } from 'react';

/**
 * Scroll-entry reveals, driven by one shared IntersectionObserver.
 *
 * Two deliberate properties:
 *
 * 1. **One observer for the whole app.** Allocating an observer per element
 *    is the common shape and the expensive one; a single instance keeps the
 *    cost flat no matter how many sections opt in.
 *
 * 2. **Each element reveals exactly once.** On first intersection the node is
 *    marked and immediately unobserved. This matters here more than on a
 *    marketing page: panels re-render on every market tick, and an observer
 *    that kept firing would replay the entry animation under live data.
 *
 * Attach to a container, not to rows that remount as data arrives — a node
 * that React replaces is a new node, and a new node animates in again.
 *
 * The visual definition lives in `styles/base.css` under `[data-reveal]`;
 * `prefers-reduced-motion` is honoured there.
 */

let sharedObserver: IntersectionObserver | null = null;

function getObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  sharedObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        (entry.target as HTMLElement).dataset.revealed = 'true';
        sharedObserver?.unobserve(entry.target);
      }
    },
    // Fire a little before the element is fully in view, so the motion
    // resolves as it arrives rather than after it has already landed.
    { rootMargin: '0px 0px -6% 0px', threshold: 0.01 },
  );
  return sharedObserver;
}

/**
 * Returns a ref to place on the element that should reveal.
 *
 * `index` staggers siblings: it is published as `--reveal-index` and the
 * stylesheet turns it into a transition delay.
 */
export function useReveal<T extends HTMLElement>(index = 0) {
  const indexRef = useRef(index);
  indexRef.current = index;

  return useCallback((node: T | null) => {
    if (!node) return;
    node.style.setProperty('--reveal-index', String(indexRef.current));

    const observer = getObserver();
    if (!observer) {
      // No IntersectionObserver (older browser, test environment): show the
      // content rather than leaving it stranded at opacity 0.
      node.dataset.revealed = 'true';
      return;
    }

    observer.observe(node);
    return () => observer.unobserve(node);
  }, []);
}
