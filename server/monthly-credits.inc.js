const SIGNUP_CREDIT_AMOUNT = 30;
const MONTHLY_CREDIT_AMOUNT = 15;
const MONTHLY_CREDIT_START_PERIOD = "2026-11";
const MONTHLY_CREDIT_SCHEMA = /* MONTHLY_CREDIT_SCHEMA */;

function creditPolicy() {
  return {
    signup_credits: SIGNUP_CREDIT_AMOUNT,
    monthly_credits: MONTHLY_CREDIT_AMOUNT,
    monthly_start: "2026-11-01T00:00:00.000Z",
    monthly_day: 1,
    timezone: "UTC"
  };
}

async function grantMonthlyCredits(db, scheduledTime) {
  const dueDate = new Date(scheduledTime);
  if (!Number.isFinite(dueDate.getTime())) throw new Error("Invalid credit grant schedule time.");
  const duePeriod = dueDate.toISOString().slice(0, 7);
  if (duePeriod < MONTHLY_CREDIT_START_PERIOD) return {periods: 0, grants: 0};
  if (!db) throw new Error("Monthly credit grants require the D1 database binding.");
  // Use the same additive schema as the migration, also supporting fresh local
  // databases. Never share mutable schema state between database bindings.
  await db.batch(MONTHLY_CREDIT_SCHEMA.split("--> statement-breakpoint").map(sql => db.prepare(sql.trim())));
  const completed = await db.prepare("SELECT period FROM sl_monthly_credit_runs WHERE period <= ?").bind(duePeriod).all();
  const done = new Set((completed.results || []).map(row => row.period));
  let periods = 0;
  let grants = 0;
  // A daily recovery check catches missed runs. Each month is still paid once,
  // on its first day; nobody needs to visit the website to receive it. Limit
  // catch-up per invocation, with any remaining months picked up the next day.
  for (let month = new Date("2026-11-01T00:00:00.000Z"); month <= dueDate && periods < 12; month.setUTCMonth(month.getUTCMonth() + 1)) {
    const period = month.toISOString().slice(0, 7);
    if (done.has(period)) continue;
    const createdAt = dueDate.toISOString();
    const [, count] = await db.batch([
      db.prepare(`INSERT INTO sl_monthly_credit_grants (user_id, period, amount, created_at)
        SELECT id, ?, ?, ? FROM sl_users
        WHERE julianday(created_at) <= julianday(?)
          AND NOT EXISTS (SELECT 1 FROM sl_monthly_credit_runs WHERE period = ?)
        ON CONFLICT(user_id, period) DO NOTHING`)
        .bind(period, MONTHLY_CREDIT_AMOUNT, createdAt, month.toISOString(), period),
      db.prepare("SELECT changes() AS grants").bind(),
      db.prepare("INSERT INTO sl_monthly_credit_runs (period, completed_at) VALUES (?, ?) ON CONFLICT(period) DO NOTHING").bind(period, createdAt)
    ]);
    grants += Number(count.results?.[0]?.grants || 0);
    periods++;
  }
  return {periods, grants};
}
