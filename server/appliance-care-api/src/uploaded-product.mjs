import { officialDomainsForManufacturer } from './official-domains.mjs';
import { MAX_UPLOADED_MODELS, isManualIdentityText as field, isManualModelList } from './manual-upload-contract.mjs';

export const UPLOADED_PRODUCT_CATEGORIES = ['air_conditioner', 'air_purifier', 'dehumidifier', 'dishwasher', 'dryer', 'electric_kettle', 'fan',
  'freezer', 'humidifier', 'microwave_oven', 'refrigerator', 'rice_cooker', 'television', 'vacuum_cleaner', 'washing_machine', 'other_appliance'];

export const UPLOADED_PRODUCT_SCHEMA = {
  type: 'object',
  properties: {
    manufacturer: { type: ['string', 'null'] },
    productName: { type: ['string', 'null'] },
    modelNumbers: { type: 'array', items: { type: 'string' } },
    modelEvidence: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { modelNumber: { type: 'string' }, page: { type: 'integer' } }, required: ['modelNumber', 'page'] } },
    category: { type: ['string', 'null'], enum: [...UPLOADED_PRODUCT_CATEGORIES, null] },
  },
  required: ['manufacturer', 'productName', 'modelNumbers', 'modelEvidence', 'category'],
  additionalProperties: false,
};

const normalized = value => value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, '');
const makerKey = value => officialDomainsForManufacturer(value)[0] ?? normalized(value);

function pagesForModels(evidence, modelNumber, pageCount) {
  if (!modelNumber || !Array.isArray(evidence) || !Number.isSafeInteger(pageCount)) return {};
  const models = new Set(modelNumber.split(' / ').map(normalized));
  const firstPages = new Map();
  for (const entry of evidence) {
    if (!entry || !field(entry.modelNumber) || !Number.isSafeInteger(entry.page) || entry.page < 1 || entry.page > pageCount) continue;
    const model = normalized(entry.modelNumber);
    if (models.has(model)) firstPages.set(model, Math.min(entry.page, firstPages.get(model) ?? entry.page));
  }
  const modelPages = [...new Set(firstPages.values())].sort((a, b) => a - b);
  return modelPages.length ? { modelPages } : {};
}

/** No user hints or filenames can stand in for a product actually read from the PDF. */
export function productFromUploadedManual(value, expected, pageCount) {
  if (!value || !field(value.manufacturer) || !field(value.productName) || !Array.isArray(value.modelNumbers)
    || value.modelNumbers.length > MAX_UPLOADED_MODELS || !value.modelNumbers.every(field)) return null;
  if (value.category != null && !UPLOADED_PRODUCT_CATEGORIES.includes(value.category)) return null;
  const models = [...new Map(value.modelNumbers.map(model => [normalized(model), model.trim()])).entries()]
    .sort(([left], [right]) => left.localeCompare(right)).map(([, model]) => model);
  const product = { manufacturer: value.manufacturer.trim(), productName: value.productName.trim(), modelNumber: models.length ? models.join(' / ') : null,
    ...(value.category ? { category: value.category } : {}) };
  if (expected?.manufacturer !== undefined) {
    if (![expected.manufacturer, expected.productName].every(field) || makerKey(expected.manufacturer) !== makerKey(product.manufacturer)) return null;
    if (expected.modelNumber == null) {
      if (normalized(expected.productName) !== normalized(product.productName)) return null;
    } else if (!isManualModelList(expected.modelNumber) || !expected.modelNumber.split(' / ').map(normalized)
      .every(model => models.some(actual => normalized(actual) === model))) return null;
    // Reanalysis must not rename or re-identify an already saved appliance.
    return { manufacturer: expected.manufacturer, productName: expected.productName, modelNumber: expected.modelNumber ?? null,
      ...pagesForModels(value.modelEvidence, expected.modelNumber, pageCount),
      ...(expected.category || product.category ? { category: expected.category ?? product.category } : {}) };
  }
  return { ...product, ...pagesForModels(value.modelEvidence, product.modelNumber, pageCount) };
}
