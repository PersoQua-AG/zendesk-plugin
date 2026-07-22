import { describe, it, expect, vi } from 'vitest';
import { pollJobToCompletion, type JobStatus } from '../../src/client/job-poller.js';

describe('pollJobToCompletion', () => {
  it('polls until status is completed', async () => {
    const statuses: JobStatus[] = [
      { id: 'job-1', status: 'queued' },
      { id: 'job-1', status: 'working' },
      { id: 'job-1', status: 'completed', results: [{ id: 1, success: true }] },
    ];
    let call = 0;
    const fetchJobStatus = vi.fn(async () => statuses[call++]);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await pollJobToCompletion('job-1', { fetchJobStatus, sleep, intervalMs: 10 });

    expect(result.status).toBe('completed');
    expect(fetchJobStatus).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('resolves (not throws) when the job reports failed, so callers can inspect per-record errors', async () => {
    const failed: JobStatus = {
      id: 'job-2',
      status: 'failed',
      results: [{ id: 1, success: false, errors: ['RecordInvalid'] }],
    };
    const fetchJobStatus = vi.fn(async () => failed);
    const result = await pollJobToCompletion('job-2', { fetchJobStatus, sleep: async () => {} });
    expect(result.status).toBe('failed');
    expect(result.results?.[0].errors).toEqual(['RecordInvalid']);
  });

  it('throws if the job never completes within maxAttempts', async () => {
    const fetchJobStatus = vi.fn(async (): Promise<JobStatus> => ({ id: 'job-3', status: 'working' }));
    await expect(
      pollJobToCompletion('job-3', { fetchJobStatus, sleep: async () => {}, maxAttempts: 3, intervalMs: 1 }),
    ).rejects.toThrow(/did not complete/i);
    expect(fetchJobStatus).toHaveBeenCalledTimes(3);
  });
});
