const mode = process.env.EXPO_PUBLIC_LIFLOW_UI_REVIEW;
export const uiReviewBuild = mode === '1';
export const uiReviewEnabled = uiReviewBuild || mode === 'menu' || (typeof __DEV__ !== 'undefined' && __DEV__);
