import { isEmailTimestamp } from "../../shared/emailTimestamp";
import type { Card } from "../../shared/types";

export function EmailTimestamp({ card }: { card: Card }) {
  const dates = card.emailDates?.filter((email) => isEmailTimestamp(email.receivedAt)) ?? [];
  if (!dates.length) return null;
  const format = new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });
  return <div className="email-timestamp">{dates.map((email) => (
    <div key={email.threadId}>
      {dates.length > 1 ? `${email.subject ?? "Email"}: ` : "Email received "}
      <time dateTime={email.receivedAt}>{format.format(new Date(email.receivedAt))}</time>
    </div>
  ))}</div>;
}
