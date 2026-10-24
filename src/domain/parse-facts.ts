import type { EventFact, EventSource, FactKey } from "./types";

const MAX_INPUT_LENGTH = 12_000;
const MAX_FACTS = 40;
const MAX_EXCERPT_LENGTH = 240;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const TIME_TOKEN = /\b(?:(?:2[0-3]|[01]?\d)[:.][0-5]\d|(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*[ap]\.?m\.?|noon|midnight)\b/gi;
const MONTHS: Record<string, string> = {
  jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03",
  apr: "04", april: "04", may: "05", jun: "06", june: "06", jul: "07", july: "07",
  aug: "08", august: "08", sep: "09", sept: "09", september: "09", oct: "10", october: "10",
  nov: "11", november: "11", dec: "12", december: "12",
};
const SMALL_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};

type TimeCandidate = { value: string; index: number; length: number };

/**
 * Extracts a small allowlist of event facts from pasted text. This is a bounded
 * pattern parser, not a general natural-language interpreter. Every result
 * remains unconfirmed and retains only normalized allowlisted event data.
 */
export function parsePastedInstructions(
  text: string,
  sourceLabel: string,
): { source: EventSource; facts: EventFact[] } {
  const originalText = typeof text === "string" ? text : "";
  const wasTruncated = originalText.length > MAX_INPUT_LENGTH;
  const input = originalText.replace(CONTROL_CHARACTERS, " ").slice(0, MAX_INPUT_LENGTH);
  const label = redactSensitive(normalizeLabel(typeof sourceLabel === "string" ? sourceLabel : "Pasted instructions"));
  const sourceId = `paste-${hash(`${label}\n${input}`)}`;
  const source: EventSource = {
    id: sourceId,
    label: label || "Pasted instructions",
    kind: sourceKind(label),
    observedAt: "unknown",
    note: `User-pasted text. Import date is not supplied; extracted facts need review.${wasTruncated ? ` Only the first ${MAX_INPUT_LENGTH.toLocaleString("en-US")} characters were analyzed.` : " Original pasted text and excerpts are discarded."}`,
  };

  const facts: EventFact[] = [];
  const seen = new Set<string>();
  const addFact = (key: FactKey, value: string, _detail: string) => {
    if (facts.length >= MAX_FACTS) return;
    const cleanValue = redactSensitive(value).trim().slice(0, MAX_EXCERPT_LENGTH);
    const cleanDetail = "Pattern match from pasted instructions; verify against the original source. Original text is not retained.";
    if (!cleanValue) return;
    const identity = `${key}\n${cleanValue}\n${cleanDetail}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const index = facts.filter((fact) => fact.key === key).length + 1;
    facts.push({
      id: `${sourceId}-${key}-${index}`,
      key,
      label: FACT_LABELS[key],
      value: cleanValue,
      detail: cleanDetail || "Pattern match from pasted text; confirm against the source.",
      sourceId,
      status: "needs-review",
    });
  };

  const sentences = splitSentences(input);
  for (const sentence of sentences) {
    if (facts.length >= MAX_FACTS) break;
    const excerpt = shortExcerpt(sentence);
    const times = findTimes(sentence);

    const date = findEventDate(sentence);
    if (date && !/^(?:sent|received|date):/i.test(sentence)) addFact("eventDate", date, excerpt);

    const zoneMatch = sentence.match(/\b(?:time\s*zone|timezone|all\s+times)\s*(?:is|are|:|=)?\s*(Europe\/[A-Za-z_]+(?:\/[A-Za-z_]+)?|UTC|GMT|CET|CEST)\b/i);
    const explicitZone = zoneMatch?.[1] ?? sentence.match(/\b(?:Europe\/Berlin|UTC|GMT|CET|CEST)\b/i)?.[0];
    if (explicitZone) addFact("timeZone", /^(?:CET|CEST|Europe\/Berlin)$/i.test(explicitZone) ? "Europe/Berlin" : explicitZone.toUpperCase(), excerpt);

    const eventStart = firstTimeAfter(sentence, /\b(?:event|doors?|registration)\s+(?:starts?|begins?|opens?)(?:\s+at)?\b/i)
      ?? firstTimeAfter(sentence, /\bstart\s+of\s+(?:the\s+)?(?:event|hackathon)\b/i);
    const listingRange = /\b(?:event|hackathon|time|when)\b/i.test(sentence)
      && /\d{1,2}[:.]\d{2}\s*[–—-]\s*\d{1,2}[:.]\d{2}/.test(sentence);
    if (eventStart) addFact("eventStart", eventStart.value, excerpt);
    else if (listingRange && times[0]) addFact("eventStart", times[0].value, excerpt);

    const agendaStart = firstTimeAfter(sentence, /\b(?:agenda|programme?|schedule)\s+(?:starts?|begins?|opens?)(?:\s+at)?\b/i);
    const agendaRow = times[0] && /^\s*(?:[•*–-]\s*)?\d{1,2}[:.]\d{2}\s*(?:[–—:-]\s*)?(?:start|kick[ -]?off|welcome|agenda begins)\b/i.test(sentence);
    if (agendaStart) addFact("agendaStart", agendaStart.value, excerpt);
    else if (agendaRow) addFact("agendaStart", times[0].value, excerpt);

    const foodTime = firstTimeAfter(sentence, /\b(?:food|catering|meal)\b[^.!?;]{0,40}\b(?:arriv\w*|served?|available|at)\b/i);
    if (foodTime) addFact("foodArrival", foodTime.value, excerpt);
    else if (times.length === 1 && /\b(?:food|catering)\b.*\barriv\w*/i.test(sentence)) addFact("foodArrival", times[0].value, excerpt);

    const breakPhrase = /\b(?:break|lunch\s+(?:break|interval|runs?|from|between|lasts?))\b/i.test(sentence);
    if (breakPhrase && times.length > 0) {
      const value = times.length >= 2
        ? `${times[0].value}–${times[1].value}`
        : `${times[0].value}–[end unknown]`;
      addFact("scheduledBreak", value, excerpt);
    }

    const demoTime = firstTimeAfter(sentence, /\b(?:live\s+)?demos?\s+(?:start|starts|begin|begins|at)\b/i)
      ?? firstTimeAfter(sentence, /\b(?:live\s+)?demo\s+(?:is\s+)?scheduled\s+for\b/i);
    if (demoTime) addFact("demoStart", demoTime.value, excerpt);

    // Agenda rows commonly put the timestamp before the deadline instruction.
    if (times.length === 1 && times[0].index < 5
      && /\b(?:submit(?:ting)?|submissions?|pitch|entr(?:y|ies))\b/i.test(sentence)
      && /\b(?:hard\s+deadline|deadline|cut\s*off|cutoff|due|closes?)\b/i.test(sentence)) {
      addFact("submissionDeadline", times[0].value, excerpt);
    }
    for (const deadlineTime of submissionDeadlineTimes(sentence, times)) {
      addFact("submissionDeadline", deadlineTime, excerpt);
    }

    for (const duration of videoDurations(sentence)) {
      addFact("videoDuration", duration, excerpt);
    }

    const deliverableSentence = /\b(?:what to show|deliverable|working demo|cool demo|no slides|video requirement)\b/i.test(sentence)
      || (/\b(?:submit|submission)\b/i.test(sentence) && /\b(?:video|pitch|demo)\b/i.test(sentence));
    if (deliverableSentence) {
      const requirements = [
        /\bvideo\b/i.test(sentence) ? "Video submission required" : "",
        /\bpitch\b/i.test(sentence) ? "Pitch required" : "",
        /\b(?:working|cool) demo\b/i.test(sentence) ? "Working demo required" : "",
        /\bno slides\b/i.test(sentence) ? "No slides" : "",
      ].filter(Boolean);
      if (requirements.length > 0) addFact("deliverableRule", requirements.join("; "), excerpt);
    }

    if (/\b(?:team|teams|team size|solo)\b/i.test(sentence)) {
      const range = sentence.match(/\b([1-5])\s*(?:[-–]|to)\s*([1-5])\s*(?:people|members|person|builders)?\b/i);
      const max = sentence.match(/\b(?:up\s+to|maximum\s+of|max\.?|limit\s+of)\s*(\d{1,2})\s*(?:people|members|person|builders)?\b/i);
      const solo = sentence.match(/\bsolo\s+(?:is\s+)?(?:allowed|fine|permitted)\b|\b(?:one|1)\s+person\s+(?:is\s+)?(?:allowed|permitted)\b/i);
      if (range) addFact("teamLimit", `${range[1]}–${range[2]} people`, excerpt);
      else if (max) addFact("teamLimit", `Up to ${max[1]} people`, excerpt);
      else if (solo) addFact("teamLimit", "Solo participation is allowed", excerpt);
    }
  }

  return { source, facts };
}

const FACT_LABELS: Record<FactKey, string> = {
  eventDate: "Event date",
  timeZone: "Time zone",
  eventStart: "Listed event start",
  agendaStart: "Agenda start",
  foodArrival: "Food arrival",
  scheduledBreak: "Scheduled break",
  submissionDeadline: "Submission deadline",
  deliverableRule: "Deliverable requirement",
  videoDuration: "Video duration",
  demoStart: "Demo start",
  teamLimit: "Team limit",
};

function sourceKind(label: string): EventSource["kind"] {
  if (/\b(?:prior|older)\s+(?:event\s+)?note\b/i.test(label)) return "prior-note";
  if (/\b(?:luma|event\s+page|listing)\b/i.test(label)) return "event-page";
  return "organizer-message";
}

function normalizeLabel(value: string): string {
  return redactSensitive(value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim()).slice(0, 100);
}

function splitSentences(value: string): string[] {
  return value
    .split(/[\n;]+/)
    .flatMap((line) => line.split(/[.!?](?=\s|$)/))
    .map((part) => part.trim())
    .filter(Boolean);
}

function shortExcerpt(value: string): string {
  const redacted = redactSensitive(value).replace(/\s+/g, " ").trim();
  return redacted.length > MAX_EXCERPT_LENGTH
    ? `${redacted.slice(0, MAX_EXCERPT_LENGTH - 1).trimEnd()}…`
    : redacted;
}

function redactSensitive(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email redacted]")
    .replace(/https?:\/\/[^\s<>()]+/gi, "[link redacted]")
    .replace(/\b(password|passcode|wi[ -]?fi|wifi)\s*[:=]\s*[^\s,;]+/gi, "$1: [redacted]");
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

function findTimes(value: string): TimeCandidate[] {
  const withoutEuropeanDates = value.replace(/\b\d{1,2}[./]\d{1,2}[./]\d{4}\b/g, (date) => " ".repeat(date.length));
  const candidates: TimeCandidate[] = [];
  for (const match of withoutEuropeanDates.matchAll(TIME_TOKEN)) {
    if (!match[0] || match.index === undefined) continue;
    const normalized = normalizeTime(match[0]);
    if (normalized) candidates.push({ value: normalized, index: match.index, length: match[0].length });
  }
  return candidates;
}

function normalizeTime(value: string): string | undefined {
  const token = value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/a\.?m\.?$/, "am")
    .replace(/p\.?m\.?$/, "pm")
    .replace(/\./g, ":");
  if (token === "noon") return "12:00";
  if (token === "midnight") return "00:00";
  const twelveHour = token.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (twelveHour) {
    let hour = Number(twelveHour[1]) % 12;
    if (twelveHour[3] === "pm") hour += 12;
    return `${String(hour).padStart(2, "0")}:${twelveHour[2] ?? "00"}`;
  }
  const twentyFourHour = token.match(/^(\d{1,2}):(\d{2})$/);
  if (!twentyFourHour) return undefined;
  const hour = Number(twentyFourHour[1]);
  const minute = Number(twentyFourHour[2]);
  return hour <= 23 && minute <= 59
    ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
    : undefined;
}

function firstTimeAfter(sentence: string, anchor: RegExp): TimeCandidate | undefined {
  const match = anchor.exec(sentence);
  if (!match || match.index === undefined) return undefined;
  const after = sentence.slice(match.index + match[0].length);
  const time = findTimes(after)[0];
  return time ? { ...time, index: match.index + match[0].length + time.index } : undefined;
}

function submissionDeadlineTimes(sentence: string, times: TimeCandidate[]): string[] {
  const result: string[] = [];
  const action = /\b(?:submit(?:ting)?|submissions?|pitch|entry)\b/i;
  const cue = /\b(?:deadline|cut\s*off|cutoff|due|by|before|until|closes?)\b/gi;
  for (const time of times) {
    const prefix = sentence.slice(0, time.index);
    const recentPrefix = prefix.slice(-100);
    if (!action.test(recentPrefix)) continue;
    cue.lastIndex = 0;
    let lastCueIndex = -1;
    let match: RegExpExecArray | null;
    while ((match = cue.exec(recentPrefix)) !== null) lastCueIndex = match.index + match[0].length;
    if (lastCueIndex < 0) continue;
    const afterCue = recentPrefix.slice(lastCueIndex);
    if (findTimes(afterCue).length > 0) continue;
    if (afterCue.length > 65) continue;
    if (!/\b(?:submit(?:ting)?|submissions?|pitch|entry)\b/i.test(recentPrefix.slice(Math.max(0, lastCueIndex - 75)))) continue;
    result.push(time.value);
  }
  return result;
}

function videoDurations(sentence: string): string[] {
  if (!/\bvideo\b/i.test(sentence)) return [];
  const result: string[] = [];
  const durationPattern = /\b(?:(exactly|maximum|max\.?|at\s+most|no\s+more\s+than|up\s+to)\s+)?(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)\s*[- ]?\s*(minutes?|mins?|seconds?|secs?)\b/gi;
  for (const match of sentence.matchAll(durationPattern)) {
    if (!match[2] || match.index === undefined) continue;
    const window = sentence.slice(Math.max(0, match.index - 36), Math.min(sentence.length, match.index + match[0].length + 36));
    if (!/\bvideo\b/i.test(window)) continue;
    const numeric = Number(match[2]) || SMALL_NUMBERS[match[2].toLowerCase()];
    if (!numeric) continue;
    const unit = /^sec/i.test(match[3]) ? "seconds" : "minutes";
    const amount = `${numeric} ${unit}`;
    const qualifier = match[1]?.toLowerCase().replace(/\s+/g, " ");
    if (/^(?:maximum|max\.?|at most|no more than|up to)$/.test(qualifier ?? "")) result.push(`Maximum ${amount}`);
    else if (qualifier === "exactly") result.push(`Exactly ${amount}`);
    else result.push(`${amount} (exact vs maximum not stated)`);
  }
  return result;
}

function findEventDate(sentence: string): string | undefined {
  const datePattern = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{4}|\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b/i;
  const match = sentence.match(datePattern);
  if (!match?.[1]) return undefined;
  return normalizeDate(match[1]);
}

function normalizeDate(value: string): string | undefined {
  let year: number;
  let month: number;
  let day: number;
  let match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
  } else if ((match = value.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/))) {
    day = Number(match[1]); month = Number(match[2]); year = Number(match[3]);
  } else if ((match = value.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/))) {
    day = Number(match[1]); month = Number(MONTHS[match[2].toLowerCase()]); year = Number(match[3]);
  } else if ((match = value.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/))) {
    month = Number(MONTHS[match[1].toLowerCase()]); day = Number(match[2]); year = Number(match[3]);
  } else {
    return undefined;
  }
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
