import type { ChoreDefinition } from '../../domain/chores/types';

const written = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const lines = (values?: readonly string[]) => values?.some(written) === true;

/** A schedule-only chore remains usable in plans and settings, without an empty library entry. */
export function hasChoreGuide(chore: Pick<ChoreDefinition, 'description' | 'instructions' | 'procedureSections' | 'tools' | 'cautions' | 'trivia'>) {
  return written(chore.description) || lines(chore.instructions) || lines(chore.tools) || lines(chore.cautions)
    || chore.procedureSections?.some(section => lines(section.steps)) === true
    || chore.trivia?.some(item => written(item.body)) === true;
}
