/**
 * What a session does with another session's message when it arrives (#620 PR 5): accept it onto
 * the delivery queue, hold it for the user, or refuse it. Pure; the messaging runtime
 * (`session-messaging.ts`) applies it on arrival, again at delivery, and to every held message
 * when the permission mode changes.
 *
 * The `messaging.inbound` setting decides first. Without one, mode parity decides (Claude Code's
 * table, with Book's D5 classes): a message whose sender asserts this session's permission class
 * is accepted, one asserting the other class is held (`mode-mismatch`), and one asserting none is
 * held by a bypass-class session (`no-mode-asserted`) and accepted by a prompting one. A mode
 * nobody knows, on either side, is held (`mode-unknown`): the policy fails closed.
 *
 * A delivered message's turn is pinned to its class ({@link peerTurnClass}): the permission gate
 * runs a bypass-class mode as `default` for the whole run of a prompting-class peer turn, so
 * switching the mode mid-turn cannot let the peer's request run unasked.
 */

import type { AcceptedPeerMessage, PeerPermissionClass } from '../types/messaging.js';
import type { PermissionMode } from '../types/runtime.js';
import { ENVELOPE_TAG, permissionClassOf } from './envelope.js';

/** `messaging.inbound`, from loosest to strictest. */
export const INBOUND_SETTINGS = ['accept', 'hold', 'refuse'] as const;
export type InboundSetting = (typeof INBOUND_SETTINGS)[number];

/**
 * How strict each setting is. Unset sits between `accept` and `hold`: it means the parity policy
 * decides, which `accept` would loosen, so a workspace layer can only ever add `hold` or `refuse`.
 */
const STRICTNESS: Record<InboundSetting | 'unset', number> = {
  accept: 0,
  unset: 1,
  hold: 2,
  refuse: 3,
};

/** The modes Book has. Any other string is a mode the policy cannot place. */
const PERMISSION_MODES: ReadonlySet<string> = new Set<PermissionMode>([
  'default',
  'auto',
  'plan',
  'accept-edits',
  'dontAsk',
  'bypassPermissions',
]);

/** Why a message is held: the two parity causes, an unplaceable mode, or `inbound: hold`. */
export type HoldCause = 'mode-mismatch' | 'no-mode-asserted' | 'mode-unknown' | 'policy';

export type ReceiveVerdict =
  { action: 'accept' } | { action: 'hold'; cause: HoldCause } | { action: 'refuse' };

/** The class a sender asserted, `unknown` for a value no class has, or undefined for none. */
export type AssertedMode = PeerPermissionClass | 'unknown' | undefined;

/** A held message the user may approve: one the parity rules held, not the setting. */
export function isParityHold(cause: HoldCause): boolean {
  return cause !== 'policy';
}

/** A setting value as the policy reads it: unset stays unset, and anything invalid is `hold`. */
export function normalizeInboundSetting(value: unknown): InboundSetting | undefined {
  if (value === undefined) return undefined;
  return (INBOUND_SETTINGS as readonly unknown[]).includes(value)
    ? (value as InboundSetting)
    : 'hold';
}

/** The receiver's class (D5), or undefined for a mode the policy cannot place. */
export function receiverClassOf(mode: string | undefined): PeerPermissionClass | undefined {
  return mode !== undefined && PERMISSION_MODES.has(mode) ? permissionClassOf(mode) : undefined;
}

// The envelope's opening tag, up to its first line break, and the `from-mode` attribute in it.
const OPENING_TAG = new RegExp(`^<${ENVELOPE_TAG}((?: [a-z-]+="[^"\\n]*")*)>\\n`);
const FROM_MODE = / from-mode="([^"]*)"/;

/**
 * The class a message's sender asserted. A well-formed envelope says it outright. A message that
 * did not round-trip has no attributed sender, but an opening tag claiming a `from-mode` no class
 * has is still read as `unknown`, so the policy holds it rather than treat it as a claim of none.
 */
export function assertedModeOf(
  message: Pick<AcceptedPeerMessage, 'content' | 'envelope'>,
): AssertedMode {
  if (message.envelope) return message.envelope.attributes.fromMode;
  const claimed = FROM_MODE.exec(OPENING_TAG.exec(message.content)?.[1] ?? '')?.[1];
  if (claimed === undefined) return undefined;
  return claimed === 'bypass' || claimed === 'prompting' ? undefined : 'unknown';
}

/** The verdict on one message, now. */
export function evaluateReceivePolicy(input: {
  inbound?: InboundSetting;
  receiverMode: string | undefined;
  senderMode: AssertedMode;
}): ReceiveVerdict {
  if (input.inbound === 'refuse') return { action: 'refuse' };
  if (input.inbound === 'hold') return { action: 'hold', cause: 'policy' };
  if (input.inbound === 'accept') return { action: 'accept' };
  const receiver = receiverClassOf(input.receiverMode);
  if (receiver === undefined || input.senderMode === 'unknown') {
    return { action: 'hold', cause: 'mode-unknown' };
  }
  if (input.senderMode === undefined) {
    return receiver === 'bypass'
      ? { action: 'hold', cause: 'no-mode-asserted' }
      : { action: 'accept' };
  }
  return input.senderMode === receiver
    ? { action: 'accept' }
    : { action: 'hold', cause: 'mode-mismatch' };
}

/**
 * The class a `peer-message` turn runs in: `bypass` only when this session is in the bypass class
 * and every message the turn delivers asserted it too. A message the user approved across the
 * classes, or one that asserted nothing, makes the turn `prompting`: approving a delivery is not
 * approving the peer's request unasked.
 */
export function peerTurnClass(
  receiverMode: string,
  senders: readonly AssertedMode[],
): PeerPermissionClass {
  return receiverClassOf(receiverMode) === 'bypass' &&
    senders.every((sender) => sender === 'bypass')
    ? 'bypass'
    : 'prompting';
}

/**
 * The mode the permission gate applies during a peer turn: the stricter of the turn's class and
 * the session's mode now. A prompting-class turn runs a bypass-class mode as `default`, so every
 * call `default` asks about still asks; any other mode, a stricter one included, applies as it is.
 */
export function peerTurnGateMode(
  mode: PermissionMode,
  turnClass: PeerPermissionClass | undefined,
): PermissionMode {
  return turnClass === 'prompting' && permissionClassOf(mode) === 'bypass' ? 'default' : mode;
}

/** One settings layer's say on `messaging.inbound`, as the layer file has it. */
export interface InboundLayer {
  label: 'user' | 'project' | 'local' | 'flag';
  path: string;
  /** The user's own file and `--settings` decide; the workspace layers may only tighten. */
  trusted: boolean;
  /** The raw value, undefined when the layer does not set it. */
  value: unknown;
}

export interface InboundResolution {
  /** The effective setting, or undefined when none is set and the parity policy decides. */
  value?: InboundSetting;
  /** The layer the effective value came from. */
  source?: { label: InboundLayer['label']; path: string };
  /** A workspace layer made the result stricter than the trusted layers had it. */
  tightened: boolean;
  /** Set when the deciding value was not one of the three and was read as `hold`. */
  invalid?: true;
  /** Workspace values that would have loosened the result, and were ignored. */
  ignored: Array<{ label: InboundLayer['label']; path: string; value: unknown }>;
}

/**
 * `messaging.inbound` over the settings layers, in the order they are read (user, project, local,
 * `--settings`): the last trusted layer that sets it decides, then each workspace layer may only
 * make it stricter. Pure, and the one function the loader applies and `book doctor` reports, so
 * the enforced rule and the reported one cannot drift apart.
 */
export function resolveInboundSetting(layers: readonly InboundLayer[]): InboundResolution {
  let value: InboundSetting | undefined;
  let source: InboundResolution['source'];
  let invalid = false;
  for (const layer of layers) {
    if (!layer.trusted || layer.value === undefined) continue;
    value = normalizeInboundSetting(layer.value);
    source = { label: layer.label, path: layer.path };
    invalid = value !== layer.value;
  }
  let tightened = false;
  const workspace = layers.filter((layer) => !layer.trusted && layer.value !== undefined);
  for (const layer of workspace) {
    const candidate = normalizeInboundSetting(layer.value)!;
    if (STRICTNESS[candidate] <= STRICTNESS[value ?? 'unset']) continue;
    value = candidate;
    source = { label: layer.label, path: layer.path };
    invalid = candidate !== layer.value;
    tightened = true;
  }
  const ignored = workspace
    .filter(
      (layer) => STRICTNESS[normalizeInboundSetting(layer.value)!] < STRICTNESS[value ?? 'unset'],
    )
    .map((layer) => ({ label: layer.label, path: layer.path, value: layer.value }));
  return {
    ...(value !== undefined ? { value } : {}),
    ...(source !== undefined ? { source } : {}),
    tightened,
    ...(invalid ? { invalid: true as const } : {}),
    ignored,
  };
}
