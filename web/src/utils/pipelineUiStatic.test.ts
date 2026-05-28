import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const componentPaths = [
  '../components/workspace/PipelineDashboard.tsx',
  '../components/workspace/EvolutionPanel.tsx',
  '../components/workspace/RegimeHUD.tsx',
  '../components/workspace/FeedStatusBar.tsx',
];

describe('pipeline UI styling guard', () => {
  it('does not reintroduce Tailwind utility classes into pipeline panels', () => {
    const forbidden = /\b(?:text|bg|border|px|py|w|h|gap|mt|mb|pt|space)-|\b(?:flex|grid|rounded|overflow-hidden|items-center|justify-between|font-medium|text-xs|text-sm)\b|\bhover:/;

    for (const relative of componentPaths) {
      const source = readFileSync(new URL(relative, import.meta.url), 'utf-8');
      expect(source, relative).not.toMatch(forbidden);
    }
  });
});
