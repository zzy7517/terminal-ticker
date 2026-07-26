import { describe, expect, it } from 'vitest';
import { createOriginStore } from '../../stores/originStore';
import type { OriginDraft } from '../../types';
import { createOriginComposerIntent } from './originComposerIntent';

function originDraft(overrides: Partial<OriginDraft> = {}): OriginDraft {
  return {
    materializationId: 'draft-1',
    config: {
      runtime: 'pi',
      provider: null,
      model: null,
      reasoningEffort: null,
    },
    message: '$think then $codebase-design',
    images: [],
    skillNames: ['think', 'codebase-design'],
    phase: 'editing',
    ...overrides,
  };
}

describe('Origin composer intent', () => {
  it('removes selected skills whose references were deleted from the message', () => {
    const store = createOriginStore();
    store.setState({ selection: { kind: 'draft', draft: originDraft() } });
    const composer = createOriginComposerIntent(store);

    const slashQuery = composer.changeMessage('Keep $codebase-design only', 26);

    expect(slashQuery).toBeNull();
    expect(store.getState().selection).toMatchObject({
      kind: 'draft',
      draft: {
        message: 'Keep $codebase-design only',
        skillNames: ['codebase-design'],
      },
    });
  });

  it('does not attach late image results after the active Origin changes', async () => {
    const store = createOriginStore();
    store.setState({
      selection: { kind: 'session', sessionId: 'session-a' },
      composerBySessionId: {
        'session-a': {
          message: 'A',
          images: [{ data: 'existing-a', mimeType: 'image/png' }],
          skillNames: [],
        },
        'session-b': { message: 'B', images: [], skillNames: [] },
      },
    });
    let finishProcessing!: (image: { data: string; mimeType: string }) => void;
    const processing = new Promise<{ data: string; mimeType: string }>((resolve) => {
      finishProcessing = resolve;
    });
    const composer = createOriginComposerIntent(store, async () => processing);

    const attaching = composer.addImages([{ type: 'image/png' } as File]);
    store.setState({ selection: { kind: 'session', sessionId: 'session-b' } });
    finishProcessing({ data: 'late-a', mimeType: 'image/png' });
    await attaching;

    expect(store.getState().composerBySessionId).toMatchObject({
      'session-a': { images: [{ data: 'existing-a', mimeType: 'image/png' }] },
      'session-b': { images: [] },
    });
  });

  it('caps image batches and concurrent additions at ten', async () => {
    const store = createOriginStore();
    store.setState({ selection: { kind: 'draft', draft: originDraft() } });
    const composer = createOriginComposerIntent(store, async (file) => ({
      data: (file as File & { name: string }).name,
      mimeType: 'image/png',
    }));
    const files = (prefix: string) => Array.from({ length: 7 }, (_, index) => ({
      type: 'image/png',
      name: `${prefix}-${index}`,
    } as File));

    await Promise.all([composer.addImages(files('a')), composer.addImages(files('b'))]);

    const selection = store.getState().selection;
    expect(selection?.kind === 'draft' ? selection.draft.images : []).toHaveLength(10);
  });

  it('selects a skill as one edit intent', () => {
    const store = createOriginStore();
    store.setState({
      selection: {
        kind: 'draft',
        draft: originDraft({
          message: '$think Use /codebase please',
          skillNames: ['think'],
        }),
      },
    });
    const composer = createOriginComposerIntent(store);

    const caret = composer.chooseSkill({ start: 11, end: 20, query: 'codebase' }, 'codebase-design');

    expect(caret).toBe(28);
    expect(store.getState().selection).toMatchObject({
      kind: 'draft',
      draft: {
        message: '$think Use $codebase-design please',
        skillNames: ['think', 'codebase-design'],
      },
    });
  });
});
