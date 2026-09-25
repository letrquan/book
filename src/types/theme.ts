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

/**
 * Folio: ink on dark paper, with one gilt accent.
 *
 * Where the Apple palette gives every role its own system hue, Folio leans on
 * value and weight. Text is a warm ivory, secondary text steps down through
 * warm greys, and a single gold, like the gilt title on a spine, marks the few
 * places you act or look first: the prompt glyph, your own turns, headings,
 * list markers and the spinner. Status colours are muted versions of the usual
 * trio (sage, brick, burnt orange). They still read at a glance, but they no
 * longer shout over the prose around them.
 */
export const FOLIO_THEME: ThemeTokens = {
  brand: '#D9B36C',
  brandShimmer: '#F2D9A0',

  text: '#E8E3D9',
  inverseText: '#15140F',
  inactive: '#6F6A61',
  subtle: '#A09A8F',
  suggestion: '#8F897E',
  permission: '#E5894F',
  remember: '#B8A1D9',

  surface: '#1D1C1A',
  surfaceActive: '#2B2926',
  border: '#3B3834',
  selectionText: '#F6F1E7',
  userAccent: '#D9B36C',
  assistantAccent: '#D9B36C',
  toolRail: '#4D4943',

  success: '#93B97F',
  error: '#E0675C',
  warning: '#E5894F',
  merged: '#8EBBB5',

  // The composer border is a hairline, not a signal. Its accent lives on the
  // prompt glyph (`userAccent`).
  promptBorder: '#4D4943',
  planMode: '#B8A1D9',
  autoAccept: '#93B97F',
  bashBorder: '#E5894F',

  modeDefault: '#A09A8F',
  modePlan: '#B8A1D9',
  modeAcceptEdits: '#93B97F',
  modeAuto: '#8EBBB5',
  modeDontAsk: '#E0675C',
  modeBypass: '#E5894F',

  diffAdded: '#1F2E20',
  diffRemoved: '#3A2220',
  diffAddedWord: '#2F4D2F',
  diffRemovedWord: '#5E302B',
  diffAddedDimmed: '#18231A',
  diffRemovedDimmed: '#2A1A18',

  usageMeter: '#8EBBB5',
  usageMeterHigh: '#E5894F',
  usageMeterCritical: '#E0675C',

  shimmerPair: ['#D9B36C', '#F2D9A0'],

  subagentColors: [
    '#E0675C',
    '#E5894F',
    '#D9B36C',
    '#93B97F',
    '#8EBBB5',
    '#8FAFD6',
    '#B8A1D9',
    '#D59AB4',
  ],

  mdCodeBackground: '#191816',
  mdCodeBorder: '#3B3834',
  mdCodeText: '#E8E3D9',
  mdCodeKeyword: '#C4A3D6',
  mdCodeString: '#A7C48B',
  mdCodeComment: '#6F6A61',
  mdCodeNumber: '#E3A774',
  mdCodeFunction: '#8FB4D9',
  mdCodeLineNumber: '#55514A',
  mdInlineCodeBg: '#2B2926',
  mdInlineCodeText: '#9FC3BE',
  // Gilt for the two headings an answer actually uses, ivory-grey below them.
  mdHeadingH1: '#F2D9A0',
  mdHeadingH2: '#D9B36C',
  mdHeading: '#BDB6AA',
  mdBlockquoteBorder: '#5A554D',
  mdBlockquoteText: '#A09A8F',
  mdLink: '#9FC3BE',
  mdListMarker: '#D9B36C',
  mdHr: '#3B3834',
  mdTableBorder: '#5A554D',
  mdThinkBg: '#191816',
  mdThinkBorder: '#3B3834',
  mdThinkText: '#8F897E',
  mdTurnSeparator: '#3B3834',
  mdCheckboxChecked: '#93B97F',
  mdCheckboxUnchecked: '#6F6A61',

  userBg: '#24221E',
};

/**
 * Rubric: two-colour printing, the way manuscripts were rubricated.
 *
 * The body is set in ink (Folio's warm ivory and greys). One cinnabar red is
 * reserved for the marks a reader navigates by: the pilcrow that opens each of
 * your turns and the composer, the section sign before a heading, list
 * markers, and the drop cap on an empty page. The agent speaks in ink, spinner
 * included, so red never reads as an alarm. Because red is the accent, errors
 * move to a rose that stays distinct from it, and warnings to amber.
 */
export const RUBRIC_THEME: ThemeTokens = {
  ...FOLIO_THEME,
  brand: '#E4573D',
  brandShimmer: '#F28A6E',
  userAccent: '#E4573D',
  // The agent's own voice is ink, not rubric.
  assistantAccent: '#F0EBE1',
  shimmerPair: ['#F0EBE1', '#A09A8F'],

  error: '#EF6F95',
  warning: '#E3A84E',
  permission: '#E3A84E',
  bashBorder: '#E3A84E',
  modeBypass: '#E3A84E',
  modeDontAsk: '#EF6F95',
  usageMeterHigh: '#E3A84E',
  usageMeterCritical: '#EF6F95',

  mdHeadingH1: '#F6F1E7',
  mdHeadingH2: '#EFE9DE',
  mdHeading: '#BDB6AA',
  mdListMarker: '#E4573D',

  subagentColors: [
    '#E4573D',
    '#E3A84E',
    '#D9B36C',
    '#93B97F',
    '#8EBBB5',
    '#8FAFD6',
    '#B8A1D9',
    '#EF6F95',
  ],
};
