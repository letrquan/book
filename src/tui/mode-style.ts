import type { PermissionMode } from '../types.js';

export type ModeColorToken =
  'modeDefault' | 'modeAuto' | 'modePlan' | 'modeAcceptEdits' | 'modeDontAsk' | 'modeBypass';

export const MODE_COLOR_TOKENS: Record<PermissionMode, ModeColorToken> = {
  default: 'modeDefault',
  auto: 'modeAuto',
  plan: 'modePlan',
  'accept-edits': 'modeAcceptEdits',
  dontAsk: 'modeDontAsk',
  bypassPermissions: 'modeBypass',
};

export function modeColorToken(mode: PermissionMode): ModeColorToken {
  return MODE_COLOR_TOKENS[mode];
}

export function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'accept-edits':
      return 'accept edits';
    case 'dontAsk':
      return "don't ask";
    case 'bypassPermissions':
      return 'bypass';
    default:
      return mode;
  }
}
