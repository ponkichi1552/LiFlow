const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Firebase JS 13.1.0 / Firestore 4.19.0 can pass Auth's network error to
// TransactionRunner's gRPC classifier, poisoning its queue (upstream #9499).
// Normalize only that failed credential fetch. No token, user, request, or
// successful result is fabricated, and Firestore keeps its normal retry budget.
const target = 'dist/common-_FXym2z8.rn.js';
const originalHash = '082b80c30fc3195081e2ace9949ae46ea9e9c3f684289ff5972bb93824ec5270';
const before = 'throw "FirebaseError" === e.name ? (e.code === z.UNAUTHENTICATED';
const after = '/* LiFlow: keep Auth network failures in the Firestore error domain. */\n' +
  '            if ("FirebaseError" === e?.name && e.code === "auth/network-request-failed") {\n' +
  '                e = new K(z.UNAVAILABLE, "Fetching auth token failed: network request failed.");\n' +
  '            }\n            ' + before;

function patchAuthNetwork(source) {
  const original = source.split(after).join(before);
  if (createHash('sha256').update(original).digest('hex') !== originalHash
    || original.split(before).length !== 3) {
    throw new Error('Firestore transport changed; review the Auth network error fix before building.');
  }
  return original.split(before).join(after);
}

function apply(root = path.join(__dirname, '../node_modules')) {
  const directory = path.join(root, '@firebase/firestore');
  if (JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version !== '4.19.0') {
    throw new Error('Firestore version changed; check whether the Auth network error fix is still needed.');
  }
  const filename = path.join(directory, target);
  const source = fs.readFileSync(filename, 'utf8');
  const patched = patchAuthNetwork(source);
  if (patched !== source) fs.writeFileSync(filename, patched);
}
if (require.main === module) apply();
module.exports = { apply, patchAuthNetwork, target };
