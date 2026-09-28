import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';

export type TranscriptLayoutChange = () => void;
export type TranscriptHistoryRequest = 'page' | 'all';
export type TranscriptHistoryLoader = (request: TranscriptHistoryRequest) => boolean;

interface TranscriptHistoryRegistry {
  register: (loader: TranscriptHistoryLoader) => () => void;
}

export interface TranscriptViewportSnapshot {
  scrollTop: number;
  viewportRows: number;
  followBottom: boolean;
}

export interface TranscriptViewportStore {
  subscribe: (listener: () => void) => () => void;
  getRevision: () => number;
  getSnapshot: () => TranscriptViewportSnapshot;
  /**
   * Keeps the rows in view where they are when a row above them changes height. The virtual
   * transcript sizes rows it has not mounted from an estimate; when one scrolls into its window it
   * reports its measured height, and if the whole row is above the first visible row, everything
   * under it would slide by the difference. `endRow` is the content row just past the row as it was
   * laid out, and `deltaRows` is its measured height minus the height it was laid out with.
   */
  anchorRowsAbove?: (endRow: number, deltaRows: number) => void;
}

export const TranscriptLayoutContext = createContext<TranscriptLayoutChange | null>(null);
export const TranscriptHistoryContext = createContext<TranscriptHistoryRegistry | null>(null);
export const TranscriptViewportContext = createContext<TranscriptViewportStore | null>(null);

export function useTranscriptLayoutChange(): TranscriptLayoutChange | null {
  return useContext(TranscriptLayoutContext);
}

export function useTranscriptHistoryLoader(loader: TranscriptHistoryLoader): void {
  const registry = useContext(TranscriptHistoryContext);
  useEffect(() => registry?.register(loader), [loader, registry]);
}

export function useTranscriptViewport(): TranscriptViewportSnapshot | null {
  const store = useContext(TranscriptViewportContext);
  useSyncExternalStore(
    store?.subscribe ?? subscribeNoop,
    store?.getRevision ?? getZeroRevision,
    getZeroRevision,
  );
  return store?.getSnapshot() ?? null;
}

function subscribeNoop(): () => void {
  return () => {};
}

function getZeroRevision(): number {
  return 0;
}
