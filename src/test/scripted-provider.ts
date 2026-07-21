export type ScriptedFetchStep =
  Response | ((input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>);

export interface ScriptedProvider {
  fetch: typeof fetch;
  requests: Array<{ input: RequestInfo | URL; init?: RequestInit }>;
}

type ScriptedFetchFactory = Exclude<ScriptedFetchStep, Response>;

export function sseResponse(events: string[], status = 200): Response {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status });
}

export function createScriptedProvider(...steps: ScriptedFetchStep[]): ScriptedProvider {
  const requests: ScriptedProvider['requests'] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const step = steps.shift();
    if (!step) throw new Error('Scripted provider has no response left');
    requests.push({ input, init });
    return typeof step === 'function' ? step(input, init) : step;
  };
  return { fetch, requests };
}

export function createRepeatingScriptedProvider(step: ScriptedFetchFactory): ScriptedProvider {
  const requests: ScriptedProvider['requests'] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    return step(input, init);
  };
  return { fetch, requests };
}
