export const TRANSCRIPT_SCROLL_IDLE_MS = 150;

let activeUntil = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

export function markTranscriptScrollActivity(now = Date.now()): void {
  activeUntil = Math.max(activeUntil, now + TRANSCRIPT_SCROLL_IDLE_MS);
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (Date.now() >= activeUntil) activeUntil = 0;
  }, TRANSCRIPT_SCROLL_IDLE_MS);
}

export function isTranscriptScrollActive(now = Date.now()): boolean {
  return activeUntil > now;
}
