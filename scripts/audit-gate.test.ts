import { describe, expect, it, vi } from 'vitest';
import { auditGate, classifyAudit, type AuditRun } from './audit-gate.js';

const clean: AuditRun = {
  status: 0,
  stdout: JSON.stringify({ metadata: { vulnerabilities: { high: 0, critical: 0 } } }),
  stderr: '',
};
const findings: AuditRun = {
  status: 1,
  stdout: JSON.stringify({
    metadata: { vulnerabilities: { high: 1, critical: 0 } },
    vulnerabilities: { lodash: { severity: 'high' }, minimist: { severity: 'low' } },
  }),
  stderr: '',
};
const registry503: AuditRun = {
  status: 1,
  stdout: JSON.stringify({
    error: {
      code: 'EAUDIT',
      summary: 'audit endpoint returned an error',
      detail: '503 Service Unavailable',
    },
  }),
  stderr: '',
};
const retired400: AuditRun = {
  status: 1,
  stdout: JSON.stringify({
    error: { code: 'E400', summary: 'This endpoint is being retired', detail: '400 Bad Request' },
  }),
  stderr: '',
};

describe('classifyAudit', () => {
  it('passes a clean report', () => {
    expect(classifyAudit(clean)).toEqual({ kind: 'ok' });
  });

  it('fails a high finding, naming it', () => {
    const outcome = classifyAudit(findings);
    expect(outcome.kind).toBe('findings');
    expect(outcome).toMatchObject({ message: expect.stringContaining('lodash (high)') });
  });

  it('calls a registry 5xx transient', () => {
    expect(classifyAudit(registry503).kind).toBe('transient');
    expect(
      classifyAudit({ status: 1, stdout: '', stderr: 'npm warn audit 503 Service Unavailable' })
        .kind,
    ).toBe('transient');
  });

  it('does not read a port or an address as an HTTP status', () => {
    expect(
      classifyAudit({ status: 1, stdout: '', stderr: 'connect ETIMEDOUT 104.16.1.35:443' }).kind,
    ).toBe('transient');
  });

  it('retries a 429 and a 408', () => {
    for (const code of ['429 Too Many Requests', '408 Request Timeout']) {
      expect(classifyAudit({ status: 1, stdout: '', stderr: code }).kind).toBe('transient');
    }
  });

  it('reads the report error, not unrelated stderr warnings', () => {
    expect(
      classifyAudit({
        ...registry503,
        stderr: 'npm warn 404 Not Found - GET https://registry.npmjs.org/optional-thing',
      }).kind,
    ).toBe('transient');
  });

  it('calls a connection error transient', () => {
    expect(classifyAudit({ status: 1, stdout: '', stderr: 'request failed: ETIMEDOUT' }).kind).toBe(
      'transient',
    );
  });

  it('does not retry a 400 from a retired endpoint, or an invalid package tree', () => {
    expect(classifyAudit(retired400).kind).toBe('fatal');
    expect(classifyAudit({ status: 1, stdout: '', stderr: 'Invalid package tree' }).kind).toBe(
      'fatal',
    );
  });

  it('fails a nonzero exit with no report and no known cause', () => {
    expect(classifyAudit({ status: 2, stdout: '', stderr: '' }).kind).toBe('fatal');
  });

  it('lets a finding win over an error in the same report', () => {
    const both = {
      ...findings,
      stdout: JSON.stringify({ ...JSON.parse(findings.stdout), error: {} }),
    };
    expect(classifyAudit(both).kind).toBe('findings');
  });
});

describe('auditGate', () => {
  const opts = (runs: AuditRun[]) => {
    const run = vi.fn(async () => runs.shift() ?? clean);
    const sleep = vi.fn(async (_ms: number) => {});
    return { run, sleep, log: () => {}, delaysMs: [10_000, 30_000] };
  };

  it('passes on success without sleeping', async () => {
    const o = opts([clean]);
    expect(await auditGate([], o)).toBe(0);
    expect(o.sleep).not.toHaveBeenCalled();
  });

  it('fails a finding at once, with no retry', async () => {
    const o = opts([findings, clean]);
    expect(await auditGate(['--omit=dev'], o)).toBe(1);
    expect(o.run).toHaveBeenCalledTimes(1);
    expect(o.run).toHaveBeenCalledWith(['--omit=dev']);
    expect(o.sleep).not.toHaveBeenCalled();
  });

  it('retries a registry error with a growing backoff, then passes', async () => {
    const o = opts([registry503, registry503, clean]);
    expect(await auditGate([], o)).toBe(0);
    expect(o.run).toHaveBeenCalledTimes(3);
    expect(o.sleep.mock.calls.map(([ms]) => ms)).toEqual([10_000, 30_000]);
  });

  it('fails after three registry errors', async () => {
    const o = opts([registry503, registry503, registry503, clean]);
    expect(await auditGate([], o)).toBe(1);
    expect(o.run).toHaveBeenCalledTimes(3);
  });

  it('fails a retired-endpoint 400 at once', async () => {
    const o = opts([retired400, clean]);
    expect(await auditGate([], o)).toBe(1);
    expect(o.run).toHaveBeenCalledTimes(1);
  });
});
