import { officialDomainsForManufacturer } from './official-domains.mjs';

export const UPLOADED_PRODUCT_CATEGORIES = ['air_conditioner', 'air_purifier', 'dehumidifier', 'dishwasher', 'dryer', 'electric_kettle', 'fan',
  'freezer', 'humidifier', 'microwave_oven', 'refrigerator', 'rice_cooker', 'television', 'vacuum_cleaner', 'washing_machine', 'other_appliance'];

export const UPLOADED_PRODUCT_SCHEMA = {
  type: 'object',
  properties: {
    manufacturer: { type: ['string', 'null'] },
    productName: { type: ['string', 'null'] },
    modelNumbers: { type: 'array', items: { type: 'string' } },
    category: { type: ['string', 'null'], enum: [...UPLOADED_PRODUCT_CATEGORIES, null] },
  },
  required: ['manufacturer', 'productName', 'modelNumbers', 'category'],
  additionalProperties: false,
};

const field = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 120 && !/[\u0000-\u001f\u007f]/u.test(value);
const normalized = value => value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, '');
const makerKey = value => officialDomainsForManufacturer(value)[0] ?? normalized(value);

/** No user hints or filenames can stand in for a product actually read from the PDF. */
export function productFromUploadedManual(value, expected) {
  if (!value || !field(value.manufacturer) || !field(value.productName) || !Array.isArray(value.modelNumbers)
    || value.modelNumbers.length > 20 || !value.modelNumbers.every(field)) return null;
  if (value.category != null && !UPLOADED_PRODUCT_CATEGORIES.includes(value.category)) return null;
  const models = [...new Map(value.modelNumbers.map(model => [normalized(model), model.trim()])).entries()]
    .sort(([left], [right]) => left.localeCompare(right)).map(([, model]) => model);
  const product = { manufacturer: value.manufacturer.trim(), productName: value.productName.trim(), modelNumber: models.length ? models.join(' / ') : null,
    ...(value.category ? { category: value.category } : {}) };
  if (expected?.manufacturer !== undefined) {
    if (![expected.manufacturer, expected.productName].every(field) || makerKey(expected.manufacturer) !== makerKey(product.manufacturer)) return null;
    if (expected.modelNumber == null) {
      if (normalized(expected.productName) !== normalized(product.productName)) return null;
    } else if (!field(expected.modelNumber) || !expected.modelNumber.split(' / ').map(normalized)
      .every(model => models.some(actual => normalized(actual) === model))) return null;
    // Reanalysis must not rename or re-identify an already saved appliance.
    return { manufacturer: expected.manufacturer, productName: expected.productName, modelNumber: expected.modelNumber ?? null,
      ...(expected.category || product.category ? { category: expected.category ?? product.category } : {}) };
  }
  return product.modelNumber === null || field(product.modelNumber) ? product : null;
}
