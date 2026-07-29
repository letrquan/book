import { createContext, useContext, useEffect } from 'react';

export type TranscriptLayoutChange = () => void;
export type TranscriptHistoryRequest = 'page' | 'all';
export type TranscriptHistoryLoader = (request: TranscriptHistoryRequest) => boolean;

interface TranscriptHistoryRegistry {
  register: (loader: TranscriptHistoryLoader) => () => void;
}

export const TranscriptLayoutContext = createContext<TranscriptLayoutChange | null>(null);
export const TranscriptHistoryContext = createContext<TranscriptHistoryRegistry | null>(null);

export function useTranscriptLayoutChange(): TranscriptLayoutChange | null {
  return useContext(TranscriptLayoutContext);
}

export function useTranscriptHistoryLoader(loader: TranscriptHistoryLoader): void {
  const registry = useContext(TranscriptHistoryContext);
  useEffect(() => registry?.register(loader), [loader, registry]);
}
