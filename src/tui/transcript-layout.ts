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
