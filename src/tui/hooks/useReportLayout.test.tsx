import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { Text } from 'ink';
import { useReportLayout } from './useReportLayout.js';

/** A surface whose only state is the shape it reports. */
function Surface({
  shape,
  onLayoutChange,
  editorFocused = false,
  onEditorFocusChange,
}: {
  shape: string;
  onLayoutChange?: () => void;
  editorFocused?: boolean;
  onEditorFocusChange?: (focused: boolean) => void;
}) {
  useReportLayout(shape, { onLayoutChange, editorFocused, onEditorFocusChange });
  return <Text>{shape}</Text>;
}

afterEach(cleanup);

describe('useReportLayout', () => {
  it('reports once on mount, once per change of shape, and once on unmount', () => {
    const onLayoutChange = vi.fn();
    const view = render(<Surface shape="a" onLayoutChange={onLayoutChange} />);
    expect(onLayoutChange).toHaveBeenCalledTimes(1);

    act(() => view.rerender(<Surface shape="b" onLayoutChange={onLayoutChange} />));
    expect(onLayoutChange).toHaveBeenCalledTimes(2);

    // A re-render that redraws the same shape is not a height change. The four
    // copies this replaced each reported from their own cleanup as well as from
    // their setup, so every change cost two measurements.
    act(() => view.rerender(<Surface shape="b" onLayoutChange={onLayoutChange} />));
    expect(onLayoutChange).toHaveBeenCalledTimes(2);

    act(() => view.rerender(<Surface shape="c" onLayoutChange={onLayoutChange} />));
    expect(onLayoutChange).toHaveBeenCalledTimes(3);

    act(() => view.unmount());
    expect(onLayoutChange).toHaveBeenCalledTimes(4);
  });

  it('does not re-report when the callback identity changes', () => {
    const onLayoutChange = vi.fn();
    const view = render(<Surface shape="a" onLayoutChange={onLayoutChange} />);
    expect(onLayoutChange).toHaveBeenCalledTimes(1);

    act(() => view.rerender(<Surface shape="a" onLayoutChange={vi.fn()} />));
    expect(onLayoutChange).toHaveBeenCalledTimes(1);
  });

  it('reports the editor focus and its release', () => {
    const onEditorFocusChange = vi.fn();
    const view = render(
      <Surface shape="open" editorFocused onEditorFocusChange={onEditorFocusChange} />,
    );
    expect(onEditorFocusChange).toHaveBeenLastCalledWith(true);

    // Leaving the editor hands the chords back, which is a shape change too.
    act(() => view.rerender(<Surface shape="closed" onEditorFocusChange={onEditorFocusChange} />));
    expect(onEditorFocusChange).toHaveBeenLastCalledWith(false);
  });
});
