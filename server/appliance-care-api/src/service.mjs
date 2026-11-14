import { ManualFetchError, ManualNotFoundError, resolveOfficialManual } from './manual-resolver.mjs';
import { InvalidAiOutputError, analyzeOfficialManual } from './manual-analyzer.mjs';
import { ProductResolutionError, resolveProduct } from './product-resolver.mjs';

export async function analyzeApplianceCare(request, dependencies, onStage = () => {}) {
  onStage('product_verification');
  let product;
  try {
    product = await dependencies.resolveProduct(request);
  } catch (error) {
    if (error instanceof ProductResolutionError) return apiError('TEMPORARY_NETWORK_ERROR', '製品を確認できませんでした。通信状態を確認して再試行してください。');
    return apiError('TEMPORARY_NETWORK_ERROR', '製品検索に一時的に失敗しました。時間をおいて再試行してください。');
  }

  if (product.status === 'not_found') {
    return { status: 'not_found', code: 'PRODUCT_NOT_FOUND', message: '入力されたメーカー・製品名・型番をメーカー公式情報から確認できませんでした。入力内容を確認してください。' };
  }
  if (product.status === 'ambiguous') return { status: 'ambiguous', candidates: product.candidates };

  let manual;
  try {
    manual = await dependencies.resolveManual(product);
  } catch (error) {
    if (error instanceof ManualNotFoundError) return apiError('MANUAL_NOT_FOUND', 'メーカー公式の取扱説明書を特定できませんでした。');
    if (error instanceof ManualFetchError || isTemporaryFailure(error)) return apiError('TEMPORARY_NETWORK_ERROR', 'メーカー公式資料を一時的に取得できませんでした。時間をおいて再試行してください。');
    return apiError('TEMPORARY_NETWORK_ERROR', 'メーカー公式の説明書検索に失敗しました。時間をおいて再試行してください。');
  }

  onStage('official_manual_analysis');
  let analysis;
  let analyzedManual = manual;
  try {
    const manualCandidates = [manual, ...(Array.isArray(manual.fallbackCandidates) ? manual.fallbackCandidates : [])];
    let lastAnalysisError;
    for (const candidate of manualCandidates) {
      try {
        analysis = await dependencies.analyzeManual(product, candidate);
        analyzedManual = candidate;
        break;
      } catch (error) {
        if (error instanceof InvalidAiOutputError) throw error;
        lastAnalysisError = error;
      }
    }
    if (!analysis) throw lastAnalysisError ?? new Error('No usable official manual was analyzed');
  } catch (error) {
    if (error instanceof InvalidAiOutputError) return apiError('ANALYSIS_FAILED', '公式資料の解析結果を確認できませんでした。別の公式資料で再試行してください。');
    if (error instanceof ManualFetchError || isTemporaryFailure(error)) return apiError('TEMPORARY_NETWORK_ERROR', '公式資料を一時的に取得できませんでした。通信状態を確認して再試行してください。');
    return apiError('ANALYSIS_FAILED', '公式資料の解析に失敗しました。時間をおいて再試行してください。');
  }

  return {
    status: 'verified',
    product: {
      manufacturer: product.manufacturer,
      productName: product.productName,
      modelNumber: product.modelNumber,
      ...(request.category ? { category: request.category } : {}),
    },
    officialSources: {
      ...(product.officialProductUrl ? { productUrl: product.officialProductUrl } : {}),
      manualUrl: analyzedManual.url,
    },
    analysis,
  };
}

export function createDefaultDependencies({ ai, fetchImpl = fetch, now } = {}) {
  return {
    resolveProduct: (request) => resolveProduct(request, { ai }),
    resolveManual: (product) => resolveOfficialManual(product, { ai, fetchImpl }),
    analyzeManual: (product, manual) => analyzeOfficialManual(product, manual, { ai, fetchImpl, now }),
  };
}

export function validateApplianceCareRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = ['manufacturer', 'productName', 'modelNumber'];
  if (value.forceReanalysis !== undefined && typeof value.forceReanalysis !== 'boolean') return false;
  if (value.identifyFromManual !== undefined && value.identifyFromManual !== true) return false;
  if (value.identifyFromManual === true && (!value.manual || typeof value.manual !== 'object' || Array.isArray(value.manual))) return false;
  const noIdentity = value.identifyFromManual === true && fields.every(field => value[field] === undefined);
  for (const field of fields) {
    if (noIdentity) continue;
    if (typeof value[field] !== 'string') return false;
    const normalized = value[field].trim();
    if (normalized.length < 1 || normalized.length > 120 || /[\u0000-\u001f\u007f]/u.test(normalized)) return false;
  }
  if (value.category !== undefined
    && (typeof value.category !== 'string' || value.category.trim().length === 0 || value.category.length > 80)) return false;
  return true;
}

function apiError(code, message) {
  return { status: 'error', code, message };
}

function isTemporaryFailure(error) {
  return error?.code === 'TEMPORARY_NETWORK_ERROR';
}
