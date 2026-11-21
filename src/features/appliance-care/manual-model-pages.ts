export function manualModelPages(modelNumber: string | null, pages: unknown): number[] | undefined {
  if (!modelNumber || !Array.isArray(pages)) return;
  const valid = [...new Set(pages.filter(page => Number.isSafeInteger(page) && page > 0 && page <= 100))].sort((a, b) => a - b);
  if (valid.length) return valid;
}

/** Use 1-based PDF positions, even if the printed numbering starts at another page. */
export function manualModelPageLabel(model: string | null, pages: unknown): string | undefined {
  const valid = manualModelPages(model, pages);
  if (valid) return `型番の記載　PDF ${valid.join('、')}ページ`;
}
