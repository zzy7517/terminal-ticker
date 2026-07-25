import { describe, expect, it } from 'vitest';
import type { AgentSkillSummary } from '../types';
import {
  containsSkillReference,
  insertSkillReference,
  matchingSkills,
  skillSlashQuery,
} from './skillCompletion';

const skills: AgentSkillSummary[] = [
  { name: 'improve-codebase-architecture', displayName: 'Improve Codebase Architecture', description: 'Scan modules' },
  { name: 'codebase-design', displayName: 'Codebase Design', description: 'Shared vocabulary for deep modules' },
  { name: 'think', displayName: 'Think', description: 'Plan before coding' },
];

describe('skill completion', () => {
  it('finds a slash query at the caret and ranks canonical name matches first', () => {
    expect(skillSlashQuery('Please /codebase now', 16)).toEqual({ start: 7, end: 16, query: 'codebase' });
    expect(matchingSkills(skills, 'codebase').map((skill) => skill.name)).toEqual([
      'codebase-design',
      'improve-codebase-architecture',
    ]);
  });

  it('replaces the whole slash token with a canonical dollar reference', () => {
    const query = skillSlashQuery('Use /codebase-design please', 13);
    expect(query).toEqual({ start: 4, end: 20, query: 'codebase' });
    expect(insertSkillReference('Use /codebase-design please', query!, 'codebase-design')).toEqual({
      value: 'Use $codebase-design please',
      caret: 21,
    });
  });

  it('recognises only complete selected skill references', () => {
    expect(containsSkillReference('$think plan it', 'think')).toBe(true);
    expect(containsSkillReference('$thinking plan it', 'think')).toBe(false);
  });

  it('keeps every matching skill available for keyboard scrolling', () => {
    const manySkills = Array.from({ length: 12 }, (_, index): AgentSkillSummary => ({
      name: `skill-${String(index).padStart(2, '0')}`,
      displayName: `Skill ${index}`,
      description: `Skill number ${index}`,
    }));

    expect(matchingSkills(manySkills, '')).toHaveLength(12);
    expect(matchingSkills(manySkills, '')[11]?.name).toBe('skill-11');
  });
});
