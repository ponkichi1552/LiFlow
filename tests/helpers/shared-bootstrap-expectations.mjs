import catalogue from '../../src/domain/chores/personal-catalog-data.json' with { type: 'json' };

// The adopted catalogue specification independently checks this generated data.
// A fresh shared group starts with its available recipes disabled, plus policy, settings and owner facts.
export const expectedSharedRecipeIds = catalogue.recipes
  .filter(recipe => recipe.availability === 'available' && recipe.modes.balanced.kind !== 'collection')
  .map(recipe => recipe.id);
export const expectedSharedChoreCount = expectedSharedRecipeIds.length;
export const expectedSharedBootstrapFactCount = expectedSharedChoreCount + 3;
