import type { ChoreDefinition } from './types';
import { builtInChoreCatalogEntry, HOUSEHOLD_CARE_IDS } from './catalog.ts';
import { PERSONAL_CHORE_CATALOG, personalChoreRecipe } from './personal-catalog.ts';

export const choreCategoryOrder = ['部屋・玄関', '浴室・トイレ', 'キッチン', '洗濯・寝具', '窓・ベランダ', '家電・設備', '点検・衛生'] as const;
type Category = typeof choreCategoryOrder[number];
export type PresentedChore = Pick<ChoreDefinition, 'category' | 'archived'>
  & Partial<Pick<ChoreDefinition, 'id' | 'personalRecipeId' | 'applianceId' | 'applianceCareSource'>>;

// Presentation only: category changes must not rewrite signed shared facts or private settings.
const personalCategories = new Map<string, Category>();
const presentationOrder = PERSONAL_CHORE_CATALOG.map(recipe => recipe.id).filter(id => id !== 'liflow-catalog-6.081');
presentationOrder.splice(presentationOrder.indexOf('liflow-catalog-6.006') + 1, 0, 'liflow-catalog-6.081');
const presentationRanks = new Map(presentationOrder.map((id, index) => [id, index]));
const categoryRecipes: readonly (readonly [Category, readonly number[]])[] = [
  ['部屋・玄関', [1, 6, 25, 26, 81]], ['浴室・トイレ', [2, 3, 4, 54, 55, 56]],
  ['キッチン', [5, 14, 24]], ['洗濯・寝具', [7, 8, 15, 16, 17, 18, 19, 20, 21, 22, 23, 27, 28]],
  ['窓・ベランダ', [10, 11, 57]],
  ['家電・設備', [12, 13, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 58]],
  ['点検・衛生', [9, 59, 60, 61]],
];
for (const [category, numbers] of categoryRecipes) for (const number of numbers) personalCategories.set(`liflow-catalog-6.${String(number).padStart(3, '0')}`, category);
const legacyCategories: readonly Category[] = [
  'キッチン', '家電・設備', '浴室・トイレ', '浴室・トイレ', '浴室・トイレ', '部屋・玄関', '窓・ベランダ', '部屋・玄関', '窓・ベランダ',
  '洗濯・寝具', '洗濯・寝具', ...Array<Category>(16).fill('家電・設備'), ...Array<Category>(9).fill('点検・衛生'),
];
const legacyCategoriesById = new Map(HOUSEHOLD_CARE_IDS.map((id, index) => [id, legacyCategories[index]]));
const aliases: Readonly<Record<string, Category>> = {
  水回り: '浴室・トイレ', キッチン: 'キッチン', 居室: '部屋・玄関', 玄関: '部屋・玄関', 屋外: '窓・ベランダ',
  寝室: '洗濯・寝具', 洗濯: '洗濯・寝具', 家電: '家電・設備', 家電と換気設備: '家電・設備', '家電・設備のお手入れ': '家電・設備',
};

export function presentedChoreRecipe(chore: PresentedChore) {
  const exact = personalChoreRecipe(chore.personalRecipeId ?? chore.id ?? '');
  if (exact) return exact;
  const id = /(?:^|\.)(liflow-catalog-6\.\d{3})$/u.exec(chore.id ?? '')?.[1];
  return id ? personalChoreRecipe(id) : undefined;
}
export function choreDisplayCategory(chore: PresentedChore): string {
  if (chore.applianceId || chore.applianceCareSource) return '家電・設備';
  const recipe = presentedChoreRecipe(chore);
  if (recipe) return personalCategories.get(recipe.splitParentId ?? recipe.id) ?? chore.category;
  const builtIn = builtInChoreCatalogEntry(chore.id ?? '');
  return (builtIn ? legacyCategoriesById.get(builtIn.id) : undefined) ?? aliases[chore.category] ?? chore.category;
}
export function comparePresentedChoreOrder(a: PresentedChore, b: PresentedChore) {
  return (presentationRanks.get(presentedChoreRecipe(a)?.id ?? '') ?? Number.MAX_SAFE_INTEGER)
    - (presentationRanks.get(presentedChoreRecipe(b)?.id ?? '') ?? Number.MAX_SAFE_INTEGER);
}

/** Use explicit recipe links only. Missing/archived parents never hide a surviving child. */
export function choreFamilies<T extends PresentedChore>(chores: readonly T[]): { chore: T; children: T[] }[] {
  const parents = new Map<string, T | null>();
  for (const chore of chores) {
    const recipe = presentedChoreRecipe(chore);
    if (recipe) parents.set(recipe.id, parents.has(recipe.id) ? null : chore);
  }
  const children = new Map<T, T[]>(); const roots: T[] = [];
  for (const chore of chores) {
    const parentId = presentedChoreRecipe(chore)?.splitParentId;
    const parent = parentId ? parents.get(parentId) : undefined;
    if (parent && parent !== chore) { const rows = children.get(parent) ?? []; rows.push(chore); children.set(parent, rows); }
    else roots.push(chore);
  }
  return roots.map(chore => ({ chore, children: children.get(chore) ?? [] }));
}
