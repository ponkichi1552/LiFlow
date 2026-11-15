/** The same Japanese word matching for names, calendar content and guide headings. */
export const normalizeSearchText = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ja')
  .replace(/[\u30a1-\u30f6]/g, character => String.fromCharCode(character.charCodeAt(0) - 0x60));

export const searchTerms = (value: string): readonly string[] => [...new Set(normalizeSearchText(value).trim().split(/\s+/).filter(Boolean))];
