// Hourly: automatic tuition instalments, 3-day notices, retries, "balance
// later" reminders, deposit reminders and expired holds (_lib/payments.mjs).
// Automatic charging can be switched off in the dashboard (Fee, interview &
// text → Payments); one family can be paused from the Applications tab.
import { publishedSchema } from "./_lib/db.mjs";
import { runPayments } from "./_lib/payments.mjs";

export const config = { schedule: "@hourly" };

export default async () => {
  try {
    const { schema } = await publishedSchema({ fresh: true });
    const out = await runPayments({ schema });
    console.log("[enrol-payments]", JSON.stringify(out));
  } catch (err) {
    console.error("[enrol-payments] failed:", err.message);
  }
};
