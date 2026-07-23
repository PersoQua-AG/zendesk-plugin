export async function pollJobToCompletion(jobId, options) {
    const sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const intervalMs = options.intervalMs ?? 1000;
    const maxAttempts = options.maxAttempts ?? 60;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const status = await options.fetchJobStatus(jobId);
        if (status.status === 'completed' || status.status === 'failed') {
            return status;
        }
        // Don't sleep after the final attempt — we're about to throw anyway.
        if (attempt < maxAttempts - 1) {
            await sleepFn(intervalMs);
        }
    }
    throw new Error(`Job ${jobId} did not complete within ${maxAttempts} polling attempts`);
}
