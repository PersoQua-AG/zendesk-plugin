export interface JobStatus {
  id: string;
  status: 'queued' | 'working' | 'completed' | 'failed';
  results?: Array<{ id?: number; success: boolean; errors?: string[] }>;
}

export interface JobPollerOptions {
  fetchJobStatus: (jobId: string) => Promise<JobStatus>;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  maxAttempts?: number;
}

export async function pollJobToCompletion(jobId: string, options: JobPollerOptions): Promise<JobStatus> {
  const sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const intervalMs = options.intervalMs ?? 1000;
  const maxAttempts = options.maxAttempts ?? 60;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await options.fetchJobStatus(jobId);
    if (status.status === 'completed' || status.status === 'failed') {
      return status;
    }
    await sleepFn(intervalMs);
  }
  throw new Error(`Job ${jobId} did not complete within ${maxAttempts} polling attempts`);
}
