export const MAX_QUEUED_INPUTS = 10;

export interface QueuedInput {
  id: string;
  sessionId: string;
  value: string;
  createdAt: number;
}

export function createQueuedInput(
  value: string,
  sessionId: string,
  existing?: Pick<QueuedInput, 'id' | 'createdAt'>,
): QueuedInput {
  return {
    id: existing?.id ?? crypto.randomUUID(),
    sessionId,
    value,
    createdAt: existing?.createdAt ?? Date.now(),
  };
}

export function enqueueQueuedInput(
  queue: readonly QueuedInput[],
  input: QueuedInput,
  capacity = MAX_QUEUED_INPUTS,
): { accepted: boolean; queue: QueuedInput[] } {
  if (queue.length >= capacity) return { accepted: false, queue: [...queue] };
  return { accepted: true, queue: [...queue, input] };
}

export function recallNewestQueuedInput(
  queue: readonly QueuedInput[],
  excludedId?: string,
): { queue: QueuedInput[]; recalled?: QueuedInput } {
  let index = -1;
  for (let candidate = queue.length - 1; candidate >= 0; candidate--) {
    if (queue[candidate].id !== excludedId) {
      index = candidate;
      break;
    }
  }
  if (index < 0) return { queue: [...queue] };
  return {
    queue: queue.filter((_, itemIndex) => itemIndex !== index),
    recalled: queue[index],
  };
}

export function restoreQueuedInputText(queue: readonly QueuedInput[], draft: string): string {
  return [...queue.map((item) => item.value), draft]
    .filter((value) => value.trim().length > 0)
    .join('\n\n');
}

export function shouldRequeueQueuedSend(result: {
  status: 'completed' | 'cancelled' | 'failed' | 'rejected';
  phase?: 'before-prepare' | 'prepare' | 'run';
  userMessagePersisted?: boolean;
}): boolean {
  return (
    result.status === 'rejected' ||
    result.status === 'cancelled' ||
    (result.status === 'failed' &&
      (result.phase === 'before-prepare' ||
        (result.phase === 'prepare' && result.userMessagePersisted === false)))
  );
}
