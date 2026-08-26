/**
 * Soft word-boundary text wrapping utility.
 *
 * Unlike Ink's built-in wrap-ansi (which uses `hard: true` and breaks at any
 * character position), this wraps only at word boundaries (spaces). Words
 * longer than maxWidth are kept intact — Ink's hard wrap handles those as
 * a safety net.
 *
 * ANSI escape sequences are stripped before measuring width so that colored
 * text is not mismeasured.
 */

/**
 * Strip ANSI escape sequences from a string for accurate width measurement.
 */
export function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

/**
 * Unicode zero-width character ranges.
 * Characters in these ranges contribute 0 to terminal display width.
 */
const ZERO_WIDTH_RANGES: [number, number][] = [
  [0x0300, 0x036f], // Combining Diacritical Marks
  [0x0483, 0x0489], // Cyrillic combining marks
  [0x0591, 0x05bd], // Hebrew combining marks
  [0x05bf, 0x05bf],
  [0x05c1, 0x05c2],
  [0x05c4, 0x05c5],
  [0x05c7, 0x05c7],
  [0x0610, 0x061a], // Arabic combining marks
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x06df, 0x06e4],
  [0x06e7, 0x06e8],
  [0x06ea, 0x06ed],
  [0x0711, 0x0711],
  [0x0730, 0x074a],
  [0x07a6, 0x07b0],
  [0x0900, 0x0902], // Devanagari combining
  [0x093a, 0x093c],
  [0x0941, 0x0948],
  [0x094d, 0x094d],
  [0x0951, 0x0957],
  [0x0962, 0x0963],
  [0x0981, 0x0981],
  [0x09bc, 0x09bc],
  [0x09c1, 0x09c4],
  [0x09cd, 0x09cd],
  [0x09e2, 0x09e3],
  [0x0a01, 0x0a02],
  [0x0a3c, 0x0a3c],
  [0x0a41, 0x0a42],
  [0x0a47, 0x0a48],
  [0x0a4b, 0x0a4d],
  [0x0a70, 0x0a71],
  [0x0a81, 0x0a82],
  [0x0abc, 0x0abc],
  [0x0ac1, 0x0ac5],
  [0x0ac7, 0x0ac8],
  [0x0acd, 0x0acd],
  [0x0ae2, 0x0ae3],
  [0x0b01, 0x0b01],
  [0x0b3c, 0x0b3c],
  [0x0b3f, 0x0b3f],
  [0x0b41, 0x0b44],
  [0x0b4d, 0x0b4d],
  [0x0b56, 0x0b56],
  [0x0b62, 0x0b63],
  [0x0b82, 0x0b82],
  [0x0bc0, 0x0bc0],
  [0x0bcd, 0x0bcd],
  [0x0c00, 0x0c00],
  [0x0c3e, 0x0c40],
  [0x0c46, 0x0c48],
  [0x0c4a, 0x0c4d],
  [0x0c55, 0x0c56],
  [0x0c62, 0x0c63],
  [0x0c81, 0x0c81],
  [0x0cbc, 0x0cbc],
  [0x0ccc, 0x0ccd],
  [0x0ce2, 0x0ce3],
  [0x0d01, 0x0d01],
  [0x0d41, 0x0d44],
  [0x0d4d, 0x0d4d],
  [0x0d62, 0x0d63],
  [0x0dca, 0x0dca],
  [0x0dd2, 0x0dd4],
  [0x0dd6, 0x0dd6],
  [0x0e31, 0x0e31], // Thai
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x0eb1, 0x0eb1], // Lao
  [0x0eb4, 0x0eb9],
  [0x0ebb, 0x0ebc],
  [0x0ec8, 0x0ecd],
  [0x0f18, 0x0f19], // Tibetan
  [0x0f35, 0x0f35],
  [0x0f37, 0x0f37],
  [0x0f39, 0x0f39],
  [0x0f71, 0x0f7e],
  [0x0f80, 0x0f84],
  [0x0f86, 0x0f87],
  [0x0f90, 0x0f97],
  [0x0f99, 0x0fbc],
  [0x0fc6, 0x0fc6],
  [0x1031, 0x1031], // Myanmar
  [0x103b, 0x103c],
  [0x103d, 0x103e],
  [0x1056, 0x1057],
  [0x1058, 0x1059],
  [0x105e, 0x1060],
  [0x1062, 0x1064],
  [0x1067, 0x106d],
  [0x1071, 0x1074],
  [0x1082, 0x1082],
  [0x1085, 0x1086],
  [0x108d, 0x108d],
  [0x109d, 0x109d],
  [0x135d, 0x135f], // Ethiopic
  [0x1712, 0x1714], // Tagalog
  [0x1732, 0x1734], // Hanunoo
  [0x1752, 0x1753], // Buhid
  [0x1772, 0x1773], // Tagbanwa
  [0x17b4, 0x17b5], // Khmer
  [0x17b7, 0x17bd],
  [0x17c6, 0x17c6],
  [0x17c9, 0x17d3],
  [0x17dd, 0x17dd],
  [0x180b, 0x180d], // Mongolian
  [0x18a9, 0x18a9],
  [0x1920, 0x1922], // Limbu
  [0x1927, 0x1928],
  [0x1932, 0x1932],
  [0x1939, 0x193b],
  [0x1a17, 0x1a18], // Buginese
  [0x1a56, 0x1a56], // Tai Tham
  [0x1a58, 0x1a5e],
  [0x1a60, 0x1a60],
  [0x1a62, 0x1a62],
  [0x1a65, 0x1a6c],
  [0x1a73, 0x1a7c],
  [0x1a7f, 0x1a7f],
  [0x1ab0, 0x1abe], // Combining Diacritical Marks Extended
  [0x1b00, 0x1b03], // Balinese
  [0x1b34, 0x1b34],
  [0x1b36, 0x1b3a],
  [0x1b3c, 0x1b3c],
  [0x1b42, 0x1b42],
  [0x1b6b, 0x1b73],
  [0x1b80, 0x1b81], // Sundanese
  [0x1ba2, 0x1ba5],
  [0x1ba8, 0x1ba9],
  [0x1bab, 0x1bad],
  [0x1be6, 0x1be6],
  [0x1be8, 0x1be9],
  [0x1bed, 0x1bed],
  [0x1bef, 0x1bf1],
  [0x1c2c, 0x1c33], // Lepcha
  [0x1c36, 0x1c37],
  [0x1cd0, 0x1cd2], // Vedic Extensions
  [0x1cd4, 0x1ce0],
  [0x1ce2, 0x1ce8],
  [0x1ced, 0x1ced],
  [0x1cf4, 0x1cf4],
  [0x1cf8, 0x1cf9],
  [0x1dc0, 0x1df5], // Combining Diacritical Marks Supplement
  [0x1dfc, 0x1dff],
  [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x2028, 0x2029], // Line/Paragraph separator
  [0x202a, 0x202e], // Bidi control chars
  [0x2060, 0x2064], // Word joiner, invisible operators
  [0x2066, 0x206f], // Bidi override chars
  [0x20d0, 0x20f0], // Combining Diacritical Marks for Symbols
  [0x2cef, 0x2cf1], // Coptic combining
  [0x2d7f, 0x2d7f], // Tifinagh combining
  [0x2de0, 0x2dff], // Cyrillic Extended-A combining
  [0xa66f, 0xa672],
  [0xa674, 0xa67d],
  [0xa69e, 0xa69f],
  [0xa6f0, 0xa6f1], // Bamum
  [0xa802, 0xa802], // Syloti Nagri
  [0xa806, 0xa806],
  [0xa80b, 0xa80b],
  [0xa825, 0xa826],
  [0xa8c4, 0xa8c4], // Saurashtra
  [0xa8e0, 0xa8f1], // Devanagari Extended combining
  [0xa926, 0xa92d], // Kayah Li
  [0xa947, 0xa951], // Rejang
  [0xa980, 0xa982], // Javanese
  [0xa9b3, 0xa9b3],
  [0xa9b6, 0xa9b9],
  [0xa9bc, 0xa9bc],
  [0xa9e5, 0xa9e5],
  [0xaa29, 0xaa2e], // Cham
  [0xaa31, 0xaa32],
  [0xaa35, 0xaa36],
  [0xaa43, 0xaa43],
  [0xaa4c, 0xaa4c],
  [0xaa7c, 0xaa7c],
  [0xaab0, 0xaab0], // Tai Viet
  [0xaab2, 0xaab4],
  [0xaab7, 0xaab8],
  [0xaabe, 0xaabf],
  [0xaac1, 0xaac1],
  [0xaaec, 0xaaed], // Meetei Mayek
  [0xaaf6, 0xaaf6],
  [0xabe5, 0xabe5], // Meetei Mayek Ext
  [0xabe8, 0xabe8],
  [0xabed, 0xabed],
  [0xfb1e, 0xfb1e], // Hebrew presentation forms
  [0xfe00, 0xfe0f], // Variation selectors
  [0xfe20, 0xfe2f], // Combining Half Marks
  [0xfeff, 0xfeff], // BOM / ZWNBSP
  [0xfff9, 0xfffb], // Interlinear annotation anchors
  [0x101fd, 0x101fd], // Phaistos Disc
  [0x102e0, 0x102e0], // Coptic Epact Numbers
  [0x10376, 0x1037a], // Combining Old Permic
  [0x10a01, 0x10a03], // Kharoshthi
  [0x10a05, 0x10a06],
  [0x10a0c, 0x10a0f],
  [0x10a38, 0x10a3a],
  [0x10a3f, 0x10a3f],
  [0x10ae5, 0x10ae6], // Manichaean
  [0x11001, 0x11001], // Brahmi
  [0x11038, 0x11046],
  [0x1107f, 0x11081],
  [0x110b3, 0x110b6],
  [0x110b9, 0x110ba],
  [0x11100, 0x11102], // Chakma
  [0x11127, 0x1112b],
  [0x1112d, 0x11134],
  [0x11173, 0x11173],
  [0x11180, 0x11181], // Sharada
  [0x111b6, 0x111be],
  [0x111c9, 0x111cc],
  [0x1122f, 0x11231], // Khojki
  [0x11234, 0x11234],
  [0x11236, 0x11237],
  [0x112df, 0x112df], // Khudawadi
  [0x112e3, 0x112ea],
  [0x11300, 0x11301], // Grantha
  [0x1133c, 0x1133c],
  [0x11340, 0x11340],
  [0x11366, 0x1136c],
  [0x11370, 0x11374],
  [0x114b3, 0x114b8], // Tirhuta
  [0x114ba, 0x114ba],
  [0x114bf, 0x114c0],
  [0x114c2, 0x114c3],
  [0x115b2, 0x115b5], // Siddham
  [0x115bc, 0x115bd],
  [0x115bf, 0x115c0],
  [0x115dc, 0x115dd],
  [0x11633, 0x1163a], // Modi
  [0x1163d, 0x1163d],
  [0x1163f, 0x11640],
  [0x116ab, 0x116ab], // Takri
  [0x116ad, 0x116ad],
  [0x116b0, 0x116b5],
  [0x116b7, 0x116b7],
  [0x1171d, 0x1171f], // Ahom
  [0x11722, 0x11725],
  [0x11727, 0x1172b],
  [0x11a01, 0x11a06], // Zanabazar Square
  [0x11a09, 0x11a0a],
  [0x11a33, 0x11a38],
  [0x11a3b, 0x11a3e],
  [0x11a47, 0x11a47],
  [0x11a51, 0x11a56],
  [0x11a59, 0x11a5b],
  [0x11a8a, 0x11a96],
  [0x11a98, 0x11a99],
  [0x11c30, 0x11c36], // Bhaiksuki
  [0x11c38, 0x11c3d],
  [0x11c3f, 0x11c3f],
  [0x11c92, 0x11ca7], // Marchen
  [0x11caa, 0x11cb0],
  [0x11cb2, 0x11cb3],
  [0x11cb5, 0x11cb6],
  [0x11d31, 0x11d36], // Masaram Gondi
  [0x11d3a, 0x11d3a],
  [0x11d3c, 0x11d3d],
  [0x11d3f, 0x11d45],
  [0x11d47, 0x11d47],
  [0x16af0, 0x16af4], // Bassa Vah
  [0x16b30, 0x16b36], // Pahawh Hmong
  [0x16f8f, 0x16f92], // Miao
  [0x1bc9d, 0x1bc9e], // Duployan
  [0x1bca0, 0x1bca3],
  [0x1d167, 0x1d169], // Musical symbols combining
  [0x1d173, 0x1d182],
  [0x1d185, 0x1d18b],
  [0x1d1aa, 0x1d1ad],
  [0x1d242, 0x1d244], // Combining music symbols
  [0x1da00, 0x1da36], // SignWriting
  [0x1da3b, 0x1da6c],
  [0x1da75, 0x1da75],
  [0x1da84, 0x1da84],
  [0x1da9b, 0x1da9f],
  [0x1daa1, 0x1daaf],
  [0x1e000, 0x1e006], // Glagolitic supplement combining
  [0x1e008, 0x1e018],
  [0x1e01b, 0x1e021],
  [0x1e023, 0x1e024],
  [0x1e026, 0x1e02a],
  [0x1e8d0, 0x1e8d6], // Mende Kikakui
  [0x1e944, 0x1e94a], // Adlam
  [0xe0001, 0xe0001], // Language tags
  [0xe0020, 0xe007f], // Tag characters
  [0xe0100, 0xe01ef], // Variation Selectors Supplement
];

/**
 * Unicode wide-character ranges (2 columns in terminal).
 * Covers CJK, Hangul, fullwidth forms, and emoji/pictographs.
 */
const WIDE_RANGES: [number, number][] = [
  // CJK / Hangul / fullwidth forms
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0xa4cf], // CJK Radicals, Yi, Kangxi, etc.
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe6f], // CJK Compatibility Forms
  [0xff01, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth Signs
  [0x20000, 0x2fffd], // CJK Extension B+
  [0x30000, 0x3fffd], // CJK Extension G+
  // Emoji and pictographs (many terminals render these as 2-wide)
  [0x1f300, 0x1f5ff], // Misc Symbols and Pictographs
  [0x1f600, 0x1f64f], // Emoticons
  [0x1f680, 0x1f6ff], // Transport and Map Symbols
  [0x1f700, 0x1f77f], // Alchemical Symbols
  [0x1f780, 0x1f7ff], // Geometric Shapes Extended
  [0x1f800, 0x1f8ff], // Supplemental Arrows-C
  [0x1f900, 0x1f9ff], // Supplemental Symbols and Pictographs
  [0x1fa00, 0x1fa6f], // Chess Symbols
  [0x1fa70, 0x1faff], // Symbols and Pictographs Extended-A
  [0x2600, 0x26ff], // Misc symbols
  // Dingbats, emoji-presentation subset only. The block also holds
  // East-Asian *ambiguous* marks — U+2713 ✓, U+2717 ✗ and friends — which
  // terminals and Ink's own layout render one column wide. Measuring the whole
  // block as wide put our width math one column out from the renderer for the
  // check mark used on every successful tool row.
  [0x2705, 0x2705], // White heavy check mark
  [0x270a, 0x270b], // Raised fist, raised hand
  [0x2728, 0x2728], // Sparkles
  [0x274c, 0x274c], // Cross mark
  [0x274e, 0x274e], // Negative squared cross mark
  [0x2753, 0x2755], // Question and exclamation ornaments
  [0x2757, 0x2757], // Heavy exclamation mark
  [0x2795, 0x2797], // Heavy plus, minus, division
  [0x27b0, 0x27b0], // Curly loop
  [0x27bf, 0x27bf], // Double curly loop
  [0x2300, 0x23ff], // Misc Technical (many 2-wide symbols)
  [0x2b50, 0x2b55], // Star, circle
  [0x2b05, 0x2b07], // Direction arrows
  [0x2b1b, 0x2b1c], // Large squares
  [0x2934, 0x2935], // Curved arrows
  [0x25aa, 0x25ab], // Small squares
  [0x25fb, 0x25fe], // Medium squares
  [0x231a, 0x231b], // Watch, hourglass
  [0x2328, 0x2328], // Keyboard
  [0x23e9, 0x23f3], // Double triangles, hourglass
  [0x23f8, 0x23fa], // Power symbols
  [0x24c2, 0x24c2], // Circled M
  [0x25b6, 0x25b6], // Play
  [0x25c0, 0x25c0], // Reverse
  [0x3030, 0x3030], // Wavy dash
  [0x303d, 0x303d], // Part alternation mark
  [0x3297, 0x3297], // Circled ideograph
  [0x3299, 0x3299], // Circled ideograph secret
];

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged: [number, number][] = [];
  for (const [low, high] of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || low > previous[1] + 1) {
      merged.push([low, high]);
    } else {
      previous[1] = Math.max(previous[1], high);
    }
  }
  return merged;
}

const SORTED_ZERO_WIDTH_RANGES = mergeRanges(ZERO_WIDTH_RANGES);
const SORTED_WIDE_RANGES = mergeRanges(WIDE_RANGES);
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

/**
 * Check if a code point falls within any range in the given list.
 */
function inRanges(cp: number, ranges: [number, number][]): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const [rangeLow, rangeHigh] = ranges[middle]!;
    if (cp < rangeLow) {
      high = middle - 1;
    } else if (cp > rangeHigh) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

/**
 * Get the display width of a string (accounting for wide chars).
 *
 * - CJK, Hangul, fullwidth, and emoji characters → 2 columns
 * - Combining marks, zero-width chars, control chars → 0 columns
 * - Everything else → 1 column
 *
 * ANSI escape sequences are stripped before measurement.
 */
export function displayWidth(text: string): number {
  if (text.length === 0) return 0;
  // Fast path for the per-character calls from wrap/truncate loops.
  if (text.length === 1) {
    const code = text.charCodeAt(0);
    if (code >= 0x20 && code < 0x7f) return 1;
  }
  // Skip the regex replace when no ANSI escape can be present.
  const plain = text.indexOf('\u001B') === -1 ? text : stripAnsi(text);
  if (ASCII_PRINTABLE.test(plain)) return plain.length;

  let width = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    if (inRanges(cp, SORTED_ZERO_WIDTH_RANGES)) {
      // width += 0
    } else if (inRanges(cp, SORTED_WIDE_RANGES)) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/** Build a terminal divider that never underflows on tiny widths. */
export function makeDivider(width: number, padding = 0, char = '─'): string {
  return char.repeat(Math.max(5, Math.floor(width) - padding));
}

/** True when `text` fits within `maxWidth` terminal display columns. */
export function fitsDisplayWidth(text: string, maxWidth: number): boolean {
  return displayWidth(text) <= Math.max(0, maxWidth);
}

/**
 * Truncate a string by terminal display columns.
 *
 * ANSI SGR sequences are preserved without counting toward width. Wide and
 * zero-width Unicode characters use the same width model as `displayWidth`.
 */
export function truncateDisplay(text: string, maxWidth: number, suffix = '…'): string {
  const limit = Math.max(0, Math.floor(maxWidth));
  if (limit === 0) return '';
  if (fitsDisplayWidth(text, limit)) return text;

  const suffixWidth = displayWidth(suffix);
  const contentLimit = Math.max(0, limit - suffixWidth);
  if (contentLimit === 0) return suffixWidth <= limit ? suffix : '';

  let width = 0;
  let out = '';
  for (let i = 0; i < text.length;) {
    if (text.charCodeAt(i) === 0x1b) {
      const match = text.slice(i).match(/^\x1B\[[0-?]*[ -/]*[@-~]/);
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }

    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    const ch = String.fromCodePoint(cp);
    const chWidth = displayWidth(ch);
    if (width + chWidth > contentLimit) break;
    out += ch;
    width += chWidth;
    i += ch.length;
  }

  return out + suffix;
}

/** Clip ANSI-stripped text to a display-column budget without adding an ellipsis. */
export function sliceDisplayWidth(text: string, maxWidth: number): string {
  const limit = Math.max(0, Math.floor(maxWidth));
  const plain = stripAnsi(text);
  if (limit === 0) return '';
  if (displayWidth(plain) <= limit) return plain;

  let width = 0;
  let out = '';
  for (const ch of plain) {
    const chWidth = displayWidth(ch);
    if (width + chWidth > limit) break;
    out += ch;
    width += chWidth;
  }
  return out;
}

/**
 * Split text into chunks that each fit within `maxWidth` display columns.
 *
 * Breaks mid-word when needed. Wide characters (CJK/emoji) never split a
 * grapheme cluster produced by `for...of` (code-point safe). A single
 * character wider than `maxWidth` is still emitted alone so content is never
 * dropped. Combining marks stay attached to the preceding base when they are
 * zero-width and fit in the same iteration budget.
 */
export function hardWrap(text: string, maxWidth: number): string {
  if (maxWidth <= 0 || !text) return text;
  return text
    .split('\n')
    .map((line) => hardWrapLine(line, maxWidth).join('\n'))
    .join('\n');
}

/** Display-width-aware hard wrap for a single line (no embedded newlines). */
export function hardWrapLine(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0 || !text) return text ? [text] : [''];
  if (fitsDisplayWidth(text, maxWidth)) return [text];

  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;

  for (const ch of text) {
    const chWidth = displayWidth(ch);
    if (current && currentWidth + chWidth > maxWidth) {
      lines.push(current);
      current = ch;
      currentWidth = chWidth;
      continue;
    }
    current += ch;
    currentWidth += chWidth;
  }

  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

/**
 * Soft-wrap text at word boundaries to fit within `maxWidth` columns.
 *
 * Words longer than maxWidth are hard-wrapped by display width (CJK/emoji
 * safe). Multiple consecutive spaces are collapsed when wrapping. Paragraph
 * breaks (blank lines / double-newline) are preserved.
 *
 * @param text    The text to wrap
 * @param maxWidth Maximum columns per line
 * @returns Wrapped text with newlines inserted at word boundaries
 */
export function wordWrap(text: string, maxWidth: number): string {
  if (maxWidth <= 0 || !text) return text;

  const paragraphs = text.split('\n');
  const wrapped: string[] = [];

  for (const paragraph of paragraphs) {
    // Preserve blank lines (paragraph separators).
    if (paragraph.trim().length === 0) {
      wrapped.push('');
      continue;
    }

    const words = paragraph.split(' ');
    const lines: string[] = [];
    let current = '';
    let currentWidth = 0;

    const pushWordChunks = (word: string) => {
      const chunks = hardWrapLine(word, maxWidth);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        const chunkWidth = displayWidth(chunk);
        if (!current) {
          current = chunk;
          currentWidth = chunkWidth;
        } else if (currentWidth + 1 + chunkWidth <= maxWidth && i === 0) {
          // Only the first chunk of a hard-broken word can share a line with
          // previous content; continuation chunks always start a new line.
          current = `${current} ${chunk}`;
          currentWidth = currentWidth + 1 + chunkWidth;
        } else {
          lines.push(current);
          current = chunk;
          currentWidth = chunkWidth;
        }
      }
    };

    for (const word of words) {
      if (word === '') {
        // Consecutive spaces — add one space to current line if not empty.
        if (current) {
          current += ' ';
          currentWidth += 1;
        }
        continue;
      }

      const wordWidth = displayWidth(word);
      const candidateWidth = current ? currentWidth + 1 + wordWidth : wordWidth;

      if (wordWidth > maxWidth) {
        // Long token: flush current line, then hard-wrap the word.
        if (current) {
          lines.push(current);
          current = '';
          currentWidth = 0;
        }
        pushWordChunks(word);
      } else if (candidateWidth > maxWidth) {
        // This word would overflow — start a new line.
        if (current) {
          lines.push(current);
          current = word;
          currentWidth = wordWidth;
        } else {
          pushWordChunks(word);
        }
      } else {
        current = current ? `${current} ${word}` : word;
        currentWidth = candidateWidth;
      }
    }

    if (current) lines.push(current);
    wrapped.push(lines.join('\n'));
  }

  return wrapped.join('\n');
}

/**
 * Pad `text` to `width` display columns (not string length).
 * Truncates with ellipsis when text is wider than `width`.
 */
export function padDisplay(
  text: string,
  width: number,
  align: 'left' | 'right' | 'center' = 'left',
): string {
  const limit = Math.max(0, Math.floor(width));
  if (limit === 0) return '';
  const clipped = fitsDisplayWidth(text, limit) ? text : truncateDisplay(text, limit);
  const pad = Math.max(0, limit - displayWidth(clipped));
  if (pad === 0) return clipped;
  if (align === 'right') return `${' '.repeat(pad)}${clipped}`;
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    return `${' '.repeat(left)}${clipped}${' '.repeat(pad - left)}`;
  }
  return `${clipped}${' '.repeat(pad)}`;
}
