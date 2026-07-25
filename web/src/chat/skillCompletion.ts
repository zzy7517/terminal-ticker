import type { AgentSkillSummary } from '../types';

export interface SkillSlashQuery {
  start: number;
  end: number;
  query: string;
}

/** Finds the slash token touching the caret, including the token tail after it. */
export function skillSlashQuery(value: string, caret: number): SkillSlashQuery | null {
  const safeCaret = Math.max(0, Math.min(caret, value.length));
  const before = value.slice(0, safeCaret);
  const match = before.match(/(?:^|\s)\/([A-Za-z0-9_-]*)$/);
  if (!match) return null;
  const slashOffset = match[0].lastIndexOf('/');
  const start = safeCaret - match[0].length + slashOffset;
  const tail = value.slice(safeCaret).match(/^[A-Za-z0-9_-]*/)?.[0] ?? '';
  return { start, end: safeCaret + tail.length, query: match[1] ?? '' };
}

export function matchingSkills(skills: AgentSkillSummary[], query: string): AgentSkillSummary[] {
  const needle = query.trim().toLowerCase();
  return skills
    .map((skill) => ({ skill, score: scoreSkill(skill, needle) }))
    .filter((candidate) => candidate.score < Number.POSITIVE_INFINITY)
    .sort((left, right) => left.score - right.score || left.skill.name.localeCompare(right.skill.name))
    .map((candidate) => candidate.skill);
}

export function insertSkillReference(value: string, query: SkillSlashQuery, skillName: string): {
  value: string;
  caret: number;
} {
  const reference = `$${skillName}`;
  const suffix = value.slice(query.end);
  const separator = /^\s/.test(suffix) ? '' : ' ';
  const next = `${value.slice(0, query.start)}${reference}${separator}${suffix}`;
  return {
    value: next,
    caret: query.start + reference.length + 1,
  };
}

export function containsSkillReference(value: string, skillName: string): boolean {
  const escaped = skillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)\\$${escaped}(?=\\s|$)`).test(value);
}

function scoreSkill(skill: AgentSkillSummary, query: string): number {
  if (!query) return 0;
  const name = skill.name.toLowerCase();
  const displayName = skill.displayName.toLowerCase();
  const description = skill.description.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 10 + name.length - query.length;
  if (displayName.startsWith(query)) return 30 + displayName.length - query.length;
  const nameIndex = name.indexOf(query);
  if (nameIndex >= 0) return 50 + nameIndex;
  const displayIndex = displayName.indexOf(query);
  if (displayIndex >= 0) return 70 + displayIndex;
  if (isSubsequence(query, name)) return 100 + name.length;
  const descriptionIndex = description.indexOf(query);
  return descriptionIndex >= 0 ? 200 + descriptionIndex : Number.POSITIVE_INFINITY;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length > 0 && index === needle.length;
}
