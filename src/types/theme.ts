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
  /**
   * Retained for custom theme files that still set it; inline code renders
   * with `mdInlineCodeText` alone and never paints a background.
   */
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
 * Apple-inspired default palette: near-black neutral surfaces, bright grey
 * text, and one blue action accent. Every other hue is a system colour that
 * appears only when a state needs attention, so ordinary chrome never competes
 * with the work.
 *
 * Roles stay distinct: blue is the user and the composer (the things you act
 * on), cyan is the agent speaking, indigo is product chrome, teal carries
 * references, and the orange/red/green trio is status.
 */
export const DEFAULT_THEME: ThemeTokens = {
  brand: '#5E5CE6',
  brandShimmer: '#8E8CFF',

  text: '#F5F5F7',
  inverseText: '#111113',
  inactive: '#6E6E73',
  subtle: '#98989D',
  suggestion: '#8E8E93',
  permission: '#FF9F0A',
  remember: '#BF5AF2',

  surface: '#1C1C1E',
  surfaceActive: '#2C2C2E',
  border: '#3A3A3C',
  selectionText: '#FFFFFF',
  userAccent: '#0A84FF',
  assistantAccent: '#64D2FF',
  toolRail: '#636366',

  success: '#30D158',
  error: '#FF453A',
  warning: '#FF9F0A',
  merged: '#66D4CF',

  promptBorder: '#0A84FF',
  planMode: '#BF5AF2',
  autoAccept: '#30D158',
  bashBorder: '#FF9F0A',

  // `default` is the quiet mode: neutral grey, so an ordinary session carries
  // no permission-mode signal at all.
  modeDefault: '#98989D',
  modePlan: '#BF5AF2',
  modeAcceptEdits: '#30D158',
  modeAuto: '#66D4CF',
  modeDontAsk: '#FF453A',
  modeBypass: '#FF9F0A',

  diffAdded: '#173A28',
  diffRemoved: '#3A1E22',
  diffAddedWord: '#24633D',
  diffRemovedWord: '#6B2932',
  diffAddedDimmed: '#122B1E',
  diffRemovedDimmed: '#2B181C',

  usageMeter: '#66D4CF',
  usageMeterHigh: '#FF9F0A',
  usageMeterCritical: '#FF453A',

  // The spinner is the agent speaking, so it keeps the cyan identity.
  shimmerPair: ['#64D2FF', '#A5E3FF'],

  subagentColors: [
    '#FF453A',
    '#FF9F0A',
    '#FFD60A',
    '#30D158',
    '#64D2FF',
    '#0A84FF',
    '#BF5AF2',
    '#5E5CE6',
  ],

  mdCodeBackground: '#161618',
  mdCodeBorder: '#3A3A3C',
  mdCodeText: '#F5F5F7',
  mdCodeKeyword: '#BF5AF2',
  mdCodeString: '#30D158',
  mdCodeComment: '#6E6E73',
  mdCodeNumber: '#FF9F0A',
  mdCodeFunction: '#64D2FF',
  mdCodeLineNumber: '#636366',
  mdInlineCodeBg: '#2C2C2E',
  mdInlineCodeText: '#66D4CF',
  // A three-step brightness ramp, all bold. Depth is legible only if these
  // differ from each other *and* from `text` — otherwise a heading is
  // indistinguishable from a bold run in body copy.
  mdHeadingH1: '#FFFFFF',
  mdHeadingH2: '#E5E5EA',
  mdHeading: '#AEAEB2',
  mdBlockquoteBorder: '#636366',
  mdBlockquoteText: '#98989D',
  mdLink: '#66D4CF',
  mdListMarker: '#0A84FF',
  mdHr: '#3A3C36',
  mdTableBorder: '#3A3C36',
  mdThinkBg: '#161618',
  mdThinkBorder: '#3A3C36',
  mdThinkText: '#8E8E93',
  mdTurnSeparator: '#3A3A3C',
  mdCheckboxChecked: '#30D158',
  mdCheckboxUnchecked: '#6E6E73',

  userBg: '#202022',
};
