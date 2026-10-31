import { applianceManufacturerIdentity } from './official-url.ts';

export function applianceProductIdentity(manufacturer: string, model: string): string {
  const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  return JSON.stringify([applianceManufacturerIdentity(manufacturer) ?? normalize(manufacturer), normalize(model)]);
}
