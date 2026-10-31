process.env.NODE_ENV = 'production';
process.env.APPLIANCE_CARE_MODE = 'public';
await import('./index.mjs');
