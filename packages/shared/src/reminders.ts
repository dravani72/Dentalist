/**
 * Appointment reminder text. Reminders travel over SMS and email, so they carry date, time and
 * place only: no procedure names, provider specialty, or clinical detail (architecture plan,
 * Scheduling). The first name is the patient's preferred name; nothing else identifying.
 */
export interface ReminderInput {
  preferredFirstName: string;
  practiceName: string;
  locationAddress: string;
  start: Date;
  timeZone: string;
}

export function appointmentReminderText(r: ReminderInput): string {
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: r.timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(r.start);
  return `Hi ${r.preferredFirstName}, this is a reminder of your appointment at ${r.practiceName}, ${r.locationAddress}, on ${when}. Reply C to confirm or call us to reschedule.`;
}
