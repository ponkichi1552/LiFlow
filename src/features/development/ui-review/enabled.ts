export const uiReviewBuild = process.env.EXPO_PUBLIC_LIFLOW_UI_REVIEW === '1';
export const uiReviewEnabled = uiReviewBuild || (typeof __DEV__ !== 'undefined' && __DEV__);
