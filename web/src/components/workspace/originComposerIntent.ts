import type { StoreApi } from 'zustand';
import {
  containsSkillReference,
  insertSkillReference,
  skillSlashQuery,
  type SkillSlashQuery,
} from '../../chat/skillCompletion';
import type { OriginState } from '../../stores/originStore';
import type { ImageAttachment } from '../../types';
import { MAX_ORIGIN_IMAGES } from '../../chat/originImages';

interface ActiveOriginComposer {
  images: ImageAttachment[];
  message: string;
  selectionKey: string;
  skillNames: string[];
}

export interface OriginComposerIntent {
  addImages(files: FileList | File[]): Promise<void>;
  changeMessage(value: string, caret: number | null): SkillSlashQuery | null;
  chooseSkill(query: SkillSlashQuery, skillName: string): number | null;
  removeImage(index: number): void;
}

type ImageProcessor = (file: File) => Promise<ImageAttachment | null>;

export function createOriginComposerIntent(
  store: Pick<StoreApi<OriginState>, 'getState'>,
  processImage: ImageProcessor = async () => null,
): OriginComposerIntent {
  return {
    async addImages(files) {
      const target = activeOriginComposer(store.getState());
      if (!target) return;
      const availableAtStart = Math.max(0, MAX_ORIGIN_IMAGES - target.images.length);
      if (availableAtStart === 0) return;
      const images = (await Promise.all(
        Array.from(files)
          .filter((file) => file.type.startsWith('image/'))
          .slice(0, availableAtStart)
          .map((file) => processImage(file)),
      )).filter((image): image is ImageAttachment => Boolean(image));
      if (images.length === 0) return;
      const current = activeOriginComposer(store.getState());
      if (!current || current.selectionKey !== target.selectionKey) return;
      const availableNow = Math.max(0, MAX_ORIGIN_IMAGES - current.images.length);
      if (availableNow === 0) return;
      store.getState().setImages([...current.images, ...images.slice(0, availableNow)]);
    },
    changeMessage(value, caret) {
      const current = activeOriginComposer(store.getState());
      if (!current) return null;
      const skillNames = current.skillNames.filter((name) => containsSkillReference(value, name));
      const state = store.getState();
      state.setMessage(value);
      state.setSkillNames(skillNames);
      return skillSlashQuery(value, caret ?? value.length);
    },
    chooseSkill(query, skillName) {
      const current = activeOriginComposer(store.getState());
      if (!current) return null;
      const insertion = insertSkillReference(current.message, query, skillName);
      const state = store.getState();
      state.setMessage(insertion.value);
      state.setSkillNames([...new Set([...current.skillNames, skillName])]);
      return insertion.caret;
    },
    removeImage(index) {
      const current = activeOriginComposer(store.getState());
      if (!current || index < 0 || index >= current.images.length) return;
      store.getState().setImages(current.images.filter((_, imageIndex) => imageIndex !== index));
    },
  };
}

function activeOriginComposer(state: OriginState): ActiveOriginComposer | null {
  const selection = state.selection;
  if (!selection) return null;
  if (selection.kind === 'draft') {
    return {
      images: selection.draft.images,
      message: selection.draft.message,
      selectionKey: `draft:${selection.draft.materializationId}`,
      skillNames: selection.draft.skillNames,
    };
  }
  const composer = state.composerBySessionId[selection.sessionId];
  return {
    images: composer?.images ?? [],
    message: composer?.message ?? '',
    selectionKey: `session:${selection.sessionId}`,
    skillNames: composer?.skillNames ?? [],
  };
}
