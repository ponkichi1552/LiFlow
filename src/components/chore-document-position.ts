type Chapter = { id: string; estimate: number };

/** The indicator represents the whole document, including chapters not mounted yet. */
export function createChoreDocumentPosition() {
  let chapters: readonly Chapter[] = [], startId = '', gap = 0, padding = 0, viewport = 0, offset = 0;
  let prefix = [0];
  const measured = new Map<string, number>();
  const rebuild = () => {
    prefix = [0];
    chapters.forEach((chapter, index) => prefix.push(prefix[prefix.length - 1] + (measured.get(chapter.id) ?? chapter.estimate) + (index < chapters.length - 1 ? gap : 0)));
  };
  const snapshot = () => {
    const total = padding + (prefix[prefix.length - 1] ?? 0);
    const start = Math.max(0, chapters.findIndex(chapter => chapter.id === startId));
    const position = (prefix[start] ?? 0) + offset;
    return {
      progress: total > viewport ? Math.max(0, Math.min(1, position / (total - viewport))) : 0,
      fraction: total > 0 ? Math.max(0, Math.min(1, viewport / total)) : 1,
    };
  };
  return {
    update(value: { chapters: readonly Chapter[]; startId: string; gap: number; padding: number }) {
      const oldOrigin = prefix[Math.max(0, chapters.findIndex(chapter => chapter.id === startId))] ?? 0;
      const prepended = startId && startId !== value.startId;
      chapters = value.chapters; startId = value.startId; gap = value.gap; padding = value.padding; rebuild();
      // The native list preserves the visible chapter when earlier chapters are prepended.
      // Account for the same offset before its next scroll event reaches JavaScript.
      if (prepended) offset = Math.max(0, offset + oldOrigin - (prefix[Math.max(0, chapters.findIndex(chapter => chapter.id === startId))] ?? 0));
      return snapshot();
    },
    jump(id: string) { startId = id; offset = 0; return snapshot(); },
    measure(id: string, height: number) {
      if (Number.isFinite(height) && height > 0 && measured.get(id) !== height) { measured.set(id, height); rebuild(); }
      return snapshot();
    },
    scroll(value: number, height: number) {
      offset = Math.max(0, value); viewport = Math.max(0, height); return snapshot();
    },
  };
}
