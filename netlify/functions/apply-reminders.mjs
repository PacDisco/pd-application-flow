// Hourly: application-fee reminders to families who finished the full
// application but haven't paid (see _lib/reminders.mjs). Does nothing until
// reminders are switched on in the dashboard (Fee, interview & text).
import { publishedSchema } from "./_lib/db.mjs";
import { runReminders } from "./_lib/reminders.mjs";

export const config = { schedule: "@hourly" };

export default async () => {
  try {
    const { schema } = await publishedSchema({ fresh: true });
    const out = await runReminders({ schema });
    console.log("[apply-reminders]", JSON.stringify(out));
  } catch (err) {
    console.error("[apply-reminders] failed:", err.message);
  }
};
