// Owner-operations scheduled jobs (Phase 2C: reminders the day before,
// overdue-instalment nudges). Each job: { name, run: async (env, { now }) =>
// result } — idempotent (use notify.sendTemplate dedupe keys).
export const jobs = [];
