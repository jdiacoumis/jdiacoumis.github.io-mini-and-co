// Parent-facing scheduled jobs (Phase 2A: trial follow-up offers).
// Each job: { name, run: async (env, { now }) => result } — idempotent.
export const jobs = [];
