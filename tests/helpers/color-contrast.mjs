/** Palette accessibility checks deliberately avoid pinning particular product colors. */
export function contrastRatio(a, b) {
  function luminance(value) {
    const [r, g, blue] = value.slice(1).match(/../g).map(x => parseInt(x, 16) / 255)
      .map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
    return .2126 * r + .7152 * g + .0722 * blue;
  }
  const [bright, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (bright + .05) / (dark + .05);
}
