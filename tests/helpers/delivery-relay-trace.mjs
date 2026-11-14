import * as firestore from 'firebase/firestore';
import * as base64 from 'base64-js';
import * as hashUtils from '@noble/hashes/utils.js';
import * as deliveryArchive from '../../src/features/sharing/delivery-archive.ts';
import * as cloudContract from '../../src/features/sharing/cloud-contract.ts';
import * as operations from '../../src/features/sharing/operations.ts';
import * as crypto from '../../src/features/sharing/crypto.ts';
import { loadNativeModule } from './native-module.mjs';

/** Counts business SDK operations against the real emulator, never credentials or document contents. */
export function tracedDeliveryRelay(context, deviceId, archive) {
  const counts = { queries: 0, queryDocuments: 0, documentReads: 0, transactions: 0, writes: 0, ciphertextCharsWritten: 0, listeners: 0 };
  const sdk = { ...firestore,
    getDocsFromServer: async target => { counts.queries++; const value = await firestore.getDocsFromServer(target); counts.queryDocuments += value.size; return value; },
    getDocFromServer: async target => { counts.documentReads++; return firestore.getDocFromServer(target); },
    setDoc: async (target, data, ...options) => {
      counts.writes++; if (typeof data.data === 'string') counts.ciphertextCharsWritten += data.data.length;
      return firestore.setDoc(target, data, ...options);
    },
    runTransaction: (database, work, ...options) => {
      counts.transactions++;
      return firestore.runTransaction(database, transaction => work({
        get: target => { counts.documentReads++; return transaction.get(target); },
        set: (...args) => { counts.writes++; return transaction.set(...args); },
        update: (...args) => { counts.writes++; return transaction.update(...args); },
        delete: (...args) => { counts.writes++; return transaction.delete(...args); },
      }), ...options);
    },
    onSnapshot: (...args) => { counts.listeners++; return firestore.onSnapshot(...args); },
  };
  const module = loadNativeModule('src/platform/sharing/firestore-delivery.ts', {
    'firebase/firestore': sdk, 'base64-js': base64, '@noble/hashes/utils.js': hashUtils,
    '../../features/sharing/delivery-archive.ts': deliveryArchive,
    '../../features/sharing/cloud-contract.ts': cloudContract,
    '../../features/sharing/operations.ts': operations, '../../features/sharing/crypto.ts': crypto,
  });
  return { relay: module.createSharingDeliveryRelay(context, deviceId, archive), counts };
}
