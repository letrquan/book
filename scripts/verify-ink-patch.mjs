import {
  assertInkVersionMatchesPatch,
  assertRendererPatchApplied,
  resolveInkPatch,
} from './ink-patch.mjs';

const patch = resolveInkPatch();
if (!patch) throw new Error('No ink renderer patch found in patches/');

assertInkVersionMatchesPatch(patch);
assertRendererPatchApplied(patch);
