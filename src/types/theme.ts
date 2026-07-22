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

export const DEFAULT_THEME: ThemeTokens = {
  brand: '#AFC19D',
  brandShimmer: '#C4D3B5',
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
  toolRail: '#6B7164',

  success: '#91B77C',
  error: '#D68174',
  warning: '#D1AA6C',
  merged: '#91B77C',

  promptBorder: '#AFC19D',
  planMode: '#C09CAD',
  autoAccept: '#91B77C',
  bashBorder: '#D1AA6C',

  modeDefault: '#AFC19D',
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

  usageMeter: '#AFC19D',
  usageMeterHigh: '#D1AA6C',
  usageMeterCritical: '#D68174',

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
  mdCodeBorder: '#4B4D45',
  mdCodeText: '#E7E1D4',
  mdCodeKeyword: '#C09CAD',
  mdCodeString: '#91B77C',
  mdCodeComment: '#938E84',
  mdCodeNumber: '#D1AA6C',
  mdCodeFunction: '#AFC19D',
  mdCodeLineNumber: '#6D6961',
  mdInlineCodeBg: '#2B2C27',
  mdInlineCodeText: '#D3A17E',
  mdHeading: '#E7E1D4',
  mdHeadingH1: '#AFC19D',
  mdHeadingH2: '#C4D3B5',
  mdBlockquoteBorder: '#6B7164',
  mdBlockquoteText: '#938E84',
  mdLink: '#AFC19D',
  mdListMarker: '#D3A17E',
  mdHr: '#4B4D45',
  mdTableBorder: '#4B4D45',
  mdThinkBg: '#20221D',
  mdThinkBorder: '#4B4D45',
  mdThinkText: '#938E84',
  mdTurnSeparator: '#6B7164',
  mdCheckboxChecked: '#91B77C',
  mdCheckboxUnchecked: '#6D6961',

  userBg: '#2A231F',
};
