/**
 * Theme token system matching Claude Code's color token architecture.
 * All values are Ink-compatible color strings (named colors, hex, rgb, ansi256, ansi:<name>).
 */
export interface ThemeTokens {
  /** Identity */
  brand: string;
  brandShimmer: string;

  /** Text */
  text: string;
  inverseText: string;
  inactive: string;
  subtle: string;
  suggestion: string;
  permission: string;
  remember: string;

  /** Shared TUI chrome */
  /**
   * Panel fill.
   *
   * Built-in components fill only *verbatim* content — a code block keeps
   * `mdCodeBackground`. Secondary content (expanded tool output, reasoning)
   * gets a left rail and nothing else, so no built-in currently renders this
   * token or `mdThinkBg`. Both stay in the contract for custom themes in
   * `.book/themes/*.json`.
   */
  surface: string;
  surfaceActive: string;
  border: string;
  selectionText: string;
  userAccent: string;
  assistantAccent: string;
  toolRail: string;

  /** Status */
  success: string;
  error: string;
  warning: string;
  merged: string;

  /** Mode borders */
  promptBorder: string;
  planMode: string;
  autoAccept: string;
  bashBorder: string;

  /** Permission mode colors (one per mode) */
  modeDefault: string;
  modePlan: string;
  modeAcceptEdits: string;
  modeAuto: string;
  modeDontAsk: string;
  modeBypass: string;

  /** Diff rendering */
  diffAdded: string;
  diffRemoved: string;
  diffAddedWord: string;
  diffRemovedWord: string;
  diffAddedDimmed: string;
  diffRemovedDimmed: string;

  /** Usage meter */
  usageMeter: string;
  usageMeterHigh: string;
  usageMeterCritical: string;

  /** Shimmer pairs for animated gradients */
  shimmerPair: [string, string];

  /** Subagent colors (8 named colors) */
  subagentColors: string[];

  /** Markdown rendering */
  mdCodeBackground: string;
  mdCodeBorder: string;
  mdCodeText: string;
  mdCodeKeyword: string;
  mdCodeString: string;
  mdCodeComment: string;
  mdCodeNumber: string;
  mdCodeFunction: string;
  mdCodeLineNumber: string;
  mdInlineCodeBg: string;
  mdInlineCodeText: string;
  mdHeading: string;
  mdHeadingH1: string;
  mdHeadingH2: string;
  mdBlockquoteBorder: string;
  mdBlockquoteText: string;
  mdLink: string;
  mdListMarker: string;
  mdHr: string;
  mdTableBorder: string;
  mdThinkBg: string;
  mdThinkBorder: string;
  mdThinkText: string;
  mdTurnSeparator: string;
  mdCheckboxChecked: string;
  mdCheckboxUnchecked: string;

  /** User message background */
  userBg: string;
}

/**
 * Warm editorial dark palette.
 *
 * Roles are kept visually distinct on purpose: sage belongs to the agent, clay
 * to product chrome, teal to references, and the amber/rust/green trio to
 * status. A token that reuses another role's hue makes the two indistinguishable
 * on screen, which is exactly what this palette exists to prevent.
 */
export const DEFAULT_THEME: ThemeTokens = {
  brand: '#D3A17E',
  brandShimmer: '#E5BB9B',

  text: '#E7E1D4',
  inverseText: '#171815',
  inactive: '#6D6961',
  subtle: '#938E84',
  suggestion: '#7E7A72',
  permission: '#D1AA6C',
  remember: '#C09CAD',

  surface: '#20221D',
  surfaceActive: '#30362B',
  border: '#4B4D45',
  selectionText: '#F3EEE4',
  userAccent: '#D3A17E',
  assistantAccent: '#AFC19D',
  toolRail: '#5C6156',

  success: '#91B77C',
  error: '#D68174',
  warning: '#D1AA6C',
  merged: '#7FA89C',

  promptBorder: '#8C9A86',
  planMode: '#C09CAD',
  autoAccept: '#91B77C',
  bashBorder: '#D1AA6C',

  // `default` is the quiet mode: desaturated so the sage of an agent turn never
  // reads as a permission-mode signal.
  modeDefault: '#8C9A86',
  modePlan: '#C09CAD',
  modeAcceptEdits: '#91B77C',
  modeAuto: '#7FA89C',
  modeDontAsk: '#D68174',
  modeBypass: '#D1AA6C',

  diffAdded: '#243326',
  diffRemoved: '#382624',
  diffAddedWord: '#36523A',
  diffRemovedWord: '#5B3430',
  diffAddedDimmed: '#1D2B20',
  diffRemovedDimmed: '#302120',

  usageMeter: '#7FA89C',
  usageMeterHigh: '#D1AA6C',
  usageMeterCritical: '#D68174',

  // The spinner is the agent speaking, so it keeps the sage identity.
  shimmerPair: ['#AFC19D', '#C4D3B5'],

  subagentColors: [
    '#D68174',
    '#7FA89C',
    '#91B77C',
    '#D1AA6C',
    '#C09CAD',
    '#D3A17E',
    '#B88FA4',
    '#AFC19D',
  ],

  mdCodeBackground: '#1B1D1A',
  mdCodeBorder: '#3A3C36',
  mdCodeText: '#E7E1D4',
  mdCodeKeyword: '#C09CAD',
  mdCodeString: '#91B77C',
  mdCodeComment: '#6D6961',
  mdCodeNumber: '#D1AA6C',
  mdCodeFunction: '#7FA89C',
  mdCodeLineNumber: '#5C6156',
  mdInlineCodeBg: '#2B2C27',
  mdInlineCodeText: '#D3A17E',
  // A three-step brightness ramp, all bold. Depth is legible only if these
  // differ from each other *and* from `text` — otherwise a heading is
  // indistinguishable from a bold run in body copy.
  mdHeadingH1: '#F7F3EA',
  mdHeadingH2: '#EFEADC',
  mdHeading: '#B4AE9F',
  mdBlockquoteBorder: '#5C6156',
  mdBlockquoteText: '#938E84',
  mdLink: '#7FA89C',
  mdListMarker: '#8C9A86',
  mdHr: '#3A3C36',
  mdTableBorder: '#3A3C36',
  mdThinkBg: '#1E201C',
  mdThinkBorder: '#3A3C36',
  mdThinkText: '#7E7A72',
  mdTurnSeparator: '#4B4D45',
  mdCheckboxChecked: '#91B77C',
  mdCheckboxUnchecked: '#6D6961',

  userBg: '#262220',
};
