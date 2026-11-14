import { applianceCategoryFromContent, applianceCategoryLabel } from './categories.ts';

interface ProductName {
  manufacturer: string;
  productName: string;
  modelNumber?: string;
}

export function appliancePrimaryName(product: { category?: string; productName?: string; displayName?: string;
  analysis?: { tasks?: readonly { name?: unknown }[] } }, fallback: string): string {
  const category = applianceCategoryFromContent(product);
  return category && category !== 'other_appliance' ? applianceCategoryLabel(category) ?? fallback : fallback;
}

/** Official product names sometimes already include the manufacturer. */
export function applianceDisplayName(product: ProductName, savedDisplayName?: string): string {
  const legacyName = `${product.manufacturer} ${product.productName}${product.modelNumber ? `（${product.modelNumber}）` : ''}`;
  // Format old generated names on read, without rewriting source records or custom labels.
  if (savedDisplayName !== undefined && savedDisplayName !== legacyName) return savedDisplayName;
  const manufacturer = product.manufacturer.trim();
  const name = product.productName.trim();
  const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').toLowerCase();
  const normalizedName = normalize(name);
  const normalizedManufacturer = normalize(manufacturer);
  const includesManufacturer = normalizedName === normalizedManufacturer
    || normalizedName.startsWith(`${normalizedManufacturer} `);
  const title = !manufacturer || includesManufacturer ? name : `${manufacturer} ${name}`;
  return `${title}${product.modelNumber ? `（${product.modelNumber}）` : ''}`;
}

/** Keep useful product details for custom labels without repeating the visible name. */
export function applianceSecondaryLabel(displayName: string, details: readonly (string | undefined)[]): string {
  const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
  let title = normalize(displayName);
  const seen = new Set<string>();
  return details.filter((detail): detail is string => {
    if (!detail?.trim()) return false;
    const value = normalize(detail);
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const included = /^[a-z0-9]/.test(value)
      ? new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'u').test(title)
      : title.includes(value);
    if (seen.has(value) || included) return false;
    seen.add(value); title += ` ${value}`; return true;
  }).join(' · ');
}
