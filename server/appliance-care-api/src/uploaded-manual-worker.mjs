import { parentPort, workerData } from 'node:worker_threads';
// No remote resources or PDF scripting is used. The worker receives bytes, not a URL or credentials.
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const task = getDocument({ data: new Uint8Array(workerData.bytes), isEvalSupported: false, enableXfa: false,
  useWasm: false, useWorkerFetch: false, disableFontFace: true, stopAtErrors: true, verbosity: 0 });
try {
  const document = await task.promise;
  if (document.numPages < 1 || document.numPages > workerData.maxPages) throw new Error('Page limit');
  parentPort.postMessage({ pages: document.numPages });
} catch { parentPort.postMessage({ rejected: true }); }
finally { await task.destroy(); }
