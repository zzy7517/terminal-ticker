export interface Phase1Extraction {
  facts: string[];
  review: string | null;
}

export interface Stage1Output {
  sourceId: number;
  payload: Phase1Extraction;
}
