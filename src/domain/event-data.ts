import type { EventFact, EventSource } from "./types";

const LUMA_SOURCE_ID = "devday-luma-2026-10-24";
const ORGANIZER_SOURCE_ID = "devday-organizer-2026-10-24";
const PRIOR_NOTE_SOURCE_ID = "devday-prior-note-undated";

/** A sanitized, dated snapshot. It is deliberately returned as reviewable data. */
export function createDevDayEventData(): { sources: EventSource[]; facts: EventFact[] } {
  const sources: EventSource[] = [
    {
      id: LUMA_SOURCE_ID,
      label: "DevDay Berlin on Luma (24 Oct 2026 snapshot)",
      kind: "event-page",
      observedAt: "2026-10-24",
      note: "Public Luma listing snapshot reviewed on 24 Oct 2026. It records the listed event window and published Developer-track description; confirm the fields before planning.",
    },
    {
      id: ORGANIZER_SOURCE_ID,
      label: "Current organizer instructions (sanitized extract)",
      kind: "organizer-message",
      observedAt: "2026-10-24",
      note: "Sanitized extracts of the latest organizer instructions supplied on 24 Oct 2026. Private message text, sender details, personal information, and private links are omitted.",
    },
    {
      id: PRIOR_NOTE_SOURCE_ID,
      label: "Older preparation note (prior source)",
      kind: "prior-note",
      observedAt: "unknown",
      note: "Older preparation material. Its exact observation date is unavailable; retained only to expose the stale lunch-break assumption.",
    },
  ];

  const facts: EventFact[] = [
    {
      id: "luma-event-date",
      key: "eventDate",
      label: "Event date",
      value: "24 October 2026",
      detail: "Dated DevDay listing snapshot; the event date should be confirmed before generating a plan.",
      sourceId: LUMA_SOURCE_ID,
      status: "needs-review",
    },
    {
      id: "luma-time-zone",
      key: "timeZone",
      label: "Event time zone",
      value: "Europe/Berlin",
      detail: "The event schedule is stated in Berlin local time (CEST on 24 October 2026).",
      sourceId: LUMA_SOURCE_ID,
      status: "needs-review",
    },
    {
      id: "luma-event-start",
      key: "eventStart",
      label: "Listed event start",
      value: "10:00",
      detail: "The listing shows an event window of 10:00–18:00. It does not say whether 10:00 is doors, registration, or the working agenda.",
      sourceId: LUMA_SOURCE_ID,
      status: "needs-review",
    },
    {
      id: "luma-team-participation",
      key: "teamLimit",
      label: "Participation format on Luma",
      value: "Solo or team participation is allowed; the reviewed description does not state a numeric team limit.",
      detail: "The Developer-track description permits solo or team entry. The organizer instruction below gives the current numeric limit.",
      sourceId: LUMA_SOURCE_ID,
      status: "needs-review",
    },
    {
      id: "organizer-event-date",
      key: "eventDate",
      label: "Organizer event date",
      value: "24 October 2026",
      detail: "Current organizer instructions for DevDay Berlin, 24 October 2026.",
      sourceId: ORGANIZER_SOURCE_ID,
      status: "needs-review",
    },
    {
      id: "organizer-time-zone",
      key: "timeZone",
      label: "Organizer time zone",
      value: "Europe/Berlin",
      detail: "Times in the current organizer instructions refer to Berlin local time.",
      sourceId: ORGANIZER_SOURCE_ID,
      status: "needs-review",
    },
    {
      id: "organizer-agenda-start",
      key: "agendaStart",
      label: "Current agenda start",
      value: "11:00",
      detail: "The current organizer instruction starts the agenda at 11:00. It does not explain the earlier 10:00 listing time.",
      sourceId: ORGANIZER_SOURCE_ID,
      status: "needs-review",
    },
    {
      id: "organizer-food-arrival",
      key: "foodArrival",
      label: "Food arrival",
      value: "13:00",
      detail: "Food arrives at 13:00. This is a point reminder and does not establish a break or its duration.",
      sourceId: ORGANIZER_SOURCE_ID,
      status: "needs-review",
    },
    {
      id: "organizer-submission-deadline",
      key: "submissionDeadline",
      label: "Hard submission cutoff",
      value: "15:45",
      detail: "The pitch must be submitted by 15:45. The submission link and upload constraints are not included in this extract.",
      sourceId: ORGANIZER_SOURCE_ID,
      status: "needs-review",
    },
    {
      id: "organizer-video-duration",
      key: "videoDuration",
      label: "Video duration wording",
      value: "2 minutes",
      detail: "The instruction calls for a “2-minute video”; it does not say whether that is exact or a maximum.",
      sourceId: ORGANIZER_SOURCE_ID,
      status: "needs-review",
    },
    {
      id: "organizer-deliverable",
      key: "deliverableRule",
      label: "What to demonstrate",
      value: "Show a demo of existing working behavior; do not submit a pitch, concept, or slides. A real workflow, automation, or exploration is acceptable.",
      detail: "This is a sanitized summary of the current instruction. It does not imply judging criteria or a guaranteed result.",
      sourceId: ORGANIZER_SOURCE_ID,
      status: "needs-review",
    },
    {
      id: "organizer-demo-start",
      key: "demoStart",
      label: "Developer demos begin",
      value: "16:00",
      detail: "The current schedule lists demos at 16:00; selection is not guaranteed. This is after the submission cutoff.",
      sourceId: ORGANIZER_SOURCE_ID,
      status: "needs-review",
    },
    {
      id: "organizer-team-limit",
      key: "teamLimit",
      label: "Team-size limit",
      value: "1–5 people; solo is allowed. Larger teams require an organizer exception.",
      detail: "Current organizer instruction. The product survey supports up to five members.",
      sourceId: ORGANIZER_SOURCE_ID,
      status: "needs-review",
    },
    {
      id: "prior-note-lunch-break",
      key: "scheduledBreak",
      label: "Older lunch interval",
      value: "13:00–14:00",
      detail: "An older preparation note described a one-hour lunch interval. The latest organizer instruction only says food arrives at 13:00; it does not establish a mandatory break.",
      sourceId: PRIOR_NOTE_SOURCE_ID,
      status: "superseded",
    },
  ];

  return { sources, facts };
}
