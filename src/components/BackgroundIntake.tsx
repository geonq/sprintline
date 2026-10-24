import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { EventFact, EventSource, FactKey } from "../domain/types";

export interface BackgroundIntakeProps {
  sources: EventSource[];
  facts: EventFact[];
  onAddSource: (input: string) => boolean | Promise<boolean>;
  onContinue: (selectedFactIds: string[], manualFacts: ManualScheduleFactInput[]) => void;
  onBack: () => void;
  message?: string;
}

export interface ManualScheduleFactInput {
  key: "eventDate" | "timeZone" | "eventStart" | "submissionDeadline";
  value: string;
}

type ScheduleFieldId = "eventDate" | "timeZone" | "workStart" | "submissionDeadline";
type ScheduleValues = Record<ScheduleFieldId, string>;

const SCHEDULE_FIELDS: { id: ScheduleFieldId; label: string; type: "date" | "text" | "time" }[] = [
  { id: "eventDate", label: "Event date", type: "date" },
  { id: "timeZone", label: "Time zone", type: "text" },
  { id: "workStart", label: "Start time", type: "time" },
  { id: "submissionDeadline", label: "Submission cutoff", type: "time" },
];

const FACT_ORDER: FactKey[] = [
  "eventDate",
  "timeZone",
  "eventStart",
  "agendaStart",
  "foodArrival",
  "scheduledBreak",
  "demoStart",
  "submissionDeadline",
  "videoDuration",
  "deliverableRule",
  "teamLimit",
];

const REQUIRED_FACT_KEYS: FactKey[] = [
  "eventDate",
  "timeZone",
  "agendaStart",
  "eventStart",
  "submissionDeadline",
];

function sourceType(kind: EventSource["kind"]): string {
  if (kind === "organizer-message") return "Organizer update";
  return "Event page";
}

function sourceTypeFor(source: EventSource): string {
  if (source.label === "Entered by team") return "Team-entered value";
  if (source.kind === "prior-note") return "Earlier note";
  return sourceType(source.kind);
}

function sourceDate(value: string): string {
  if (!value.includes("T")) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Europe/Berlin",
      }).format(date);
}

function statusLabel(status: EventFact["status"]): string {
  if (status === "confirmed") return "Confirmed";
  if (status === "superseded") return "Archived";
  return "Needs confirmation";
}

function initialSelections(facts: EventFact[]): Record<string, string> {
  const grouped = new Map<FactKey, EventFact[]>();
  facts.forEach((fact) => grouped.set(fact.key, [...(grouped.get(fact.key) ?? []), fact]));
  const selected: Record<string, string> = {};
  grouped.forEach((group, key) => {
    const confirmed = group.filter((fact) => fact.status === "confirmed");
    if (confirmed.length === 1) selected[key] = confirmed[0].id;
    else {
      const active = group.filter((fact) => fact.status !== "superseded");
      if (active.length === 1) selected[key] = active[0].id;
      else if (active.length > 1 && (key === "eventDate" || key === "timeZone" || key === "submissionDeadline" || key === "eventStart" || key === "agendaStart")) {
        const field = key === "eventStart" || key === "agendaStart" ? "workStart" : key;
        const value = inputValueForFact(field, active[0].value);
        if (value && active.every((fact) => inputValueForFact(field, fact.value) === value)) {
          selected[key] = active[0].id;
        }
      }
    }
  });
  return selected;
}

function scheduleFact(facts: EventFact[], selections: Record<string, string>, field: ScheduleFieldId): EventFact | undefined {
  const keys: FactKey[] = field === "workStart" ? ["eventStart", "agendaStart"] : [field];
  const active = facts.filter((fact) => keys.includes(fact.key) && fact.status !== "superseded");
  // The organizer agenda supplies the working start; preserve the listing as
  // a separate visible fact rather than turning it into a schedule default.
  if (field === "workStart") {
    const agenda = active.find((fact) => fact.key === "agendaStart" && selections[fact.key] === fact.id);
    if (agenda) return agenda;
  }
  return active.find((fact) => selections[fact.key] === fact.id)
    ?? (active.length === 1 ? active[0] : undefined);
}

function inputValueForFact(field: ScheduleFieldId, value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (field === "eventDate") return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : "";
  if (field === "workStart" || field === "submissionDeadline") {
    const match = trimmed.match(/^(\d{1,2}):([0-5]\d)$/);
    return match ? `${match[1].padStart(2, "0")}:${match[2]}` : "";
  }
  return trimmed;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTimeZone(value: string): boolean {
  if (!value.trim()) return false;
  const zone = /^(?:CET|CEST)$/i.test(value.trim()) ? "Europe/Berlin" : value.trim();
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export default function BackgroundIntake({
  sources,
  facts,
  onAddSource,
  onContinue,
  onBack,
  message,
}: BackgroundIntakeProps) {
  const [sourceValue, setSourceValue] = useState("");
  const [sourceMessage, setSourceMessage] = useState("");
  const [isAddingSource, setIsAddingSource] = useState(false);
  const factSignature = facts.map((fact) => `${fact.id}:${fact.status}:${fact.value}`).join("|");
  const defaults = useMemo(() => initialSelections(facts), [factSignature]);
  const initialScheduleValues = useMemo<ScheduleValues>(() => ({
    eventDate: inputValueForFact("eventDate", scheduleFact(facts, defaults, "eventDate")?.value),
    timeZone: inputValueForFact("timeZone", scheduleFact(facts, defaults, "timeZone")?.value),
    workStart: inputValueForFact("workStart", scheduleFact(facts, defaults, "workStart")?.value),
    submissionDeadline: inputValueForFact("submissionDeadline", scheduleFact(facts, defaults, "submissionDeadline")?.value),
  }), [factSignature, defaults]);
  const [selectedByKey, setSelectedByKey] = useState<Record<string, string>>(defaults);
  const [scheduleValues, setScheduleValues] = useState<ScheduleValues>(initialScheduleValues);

  useEffect(() => {
    setSelectedByKey(defaults);
    setScheduleValues(initialScheduleValues);
  }, [defaults, initialScheduleValues]);

  const groups = useMemo(() => {
    const grouped = new Map<FactKey, EventFact[]>();
    facts.forEach((fact) => grouped.set(fact.key, [...(grouped.get(fact.key) ?? []), fact]));
    return [...grouped.entries()].sort(([left], [right]) => FACT_ORDER.indexOf(left) - FACT_ORDER.indexOf(right));
  }, [facts]);
  const requiredGroups = groups.filter(([key]) => REQUIRED_FACT_KEYS.includes(key));
  const conflictGroups = requiredGroups.filter(([key, group]) =>
    REQUIRED_FACT_KEYS.includes(key) && new Set(group.filter((fact) => fact.status !== "superseded").map((fact) =>
      inputValueForFact(key === "eventStart" || key === "agendaStart" ? "workStart" : key as ScheduleFieldId, fact.value),
    )).size > 1,
  );
  const factsReady = Boolean(
    validDate(scheduleValues.eventDate) &&
    validTimeZone(scheduleValues.timeZone) &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleValues.workStart) &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleValues.submissionDeadline),
  );
  const sourceById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);
  function selectFact(key: FactKey, factId: string) {
    setSelectedByKey((current) => {
      const next = { ...current, [key]: factId };
      if (key === "eventStart") delete next.agendaStart;
      if (key === "agendaStart") delete next.eventStart;
      return next;
    });
    const fact = facts.find((item) => item.id === factId);
    if (!fact) return;
    const field: ScheduleFieldId | undefined = key === "eventDate" || key === "timeZone" || key === "submissionDeadline"
      ? key
      : key === "eventStart" || key === "agendaStart" ? "workStart" : undefined;
    if (field) setScheduleValues((current) => ({ ...current, [field]: inputValueForFact(field, fact.value) }));
  }

  function fieldSourceLabel(field: ScheduleFieldId): string {
    const sourceFact = scheduleFact(facts, selectedByKey, field);
    if (sourceFact && scheduleValues[field] === inputValueForFact(field, sourceFact.value)) {
      return sourceById.get(sourceFact.sourceId)?.label ?? "Source unavailable";
    }
    return scheduleValues[field].trim() ? "Entered by team" : "";
  }

  function continueIntake() {
    if (!factsReady) return;
    const selectedFactIds = groups.flatMap(([key]) => {
      const fact = facts.find((item) => item.id === selectedByKey[key] && item.status !== "superseded");
      if (!fact) return [];
      const field: ScheduleFieldId | undefined = key === "eventDate" || key === "timeZone" || key === "submissionDeadline"
        ? key
        : key === "eventStart" || key === "agendaStart" ? "workStart" : undefined;
      if (!field) return [fact.id];
      if (field === "workStart" && scheduleFact(facts, selectedByKey, field)?.id !== fact.id) return [];
      return scheduleValues[field] === inputValueForFact(field, fact.value) ? [fact.id] : [];
    });
    const manualKeys: Record<ScheduleFieldId, ManualScheduleFactInput["key"]> = {
      eventDate: "eventDate",
      timeZone: "timeZone",
      workStart: "eventStart",
      submissionDeadline: "submissionDeadline",
    };
    const manualFacts = SCHEDULE_FIELDS.flatMap(({ id }) => {
      const value = scheduleValues[id].trim();
      const sourceFact = scheduleFact(facts, selectedByKey, id);
      return value && (!sourceFact || value !== inputValueForFact(id, sourceFact.value))
        ? [{ key: manualKeys[id], value }]
        : [];
    });
    onContinue(selectedFactIds, manualFacts);
  }
  async function addSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = sourceValue.trim();
    if (!value) {
      setSourceMessage("Add an event link or paste the relevant organizer wording.");
      return;
    }
    setIsAddingSource(true);
    try {
      if (await onAddSource(value)) {
        setSourceValue("");
        setSourceMessage("Event details added for review.");
      } else {
        setSourceMessage("No schedule details added. Check the message above.");
      }
    } catch {
      setSourceMessage("The event source could not be read. Try another link or paste the instructions.");
    } finally {
      setIsAddingSource(false);
    }
  }

  return (
    <section className="flow-panel background-intake" aria-labelledby="background-intake-title">
      <header className="flow-heading">
        <div className="flow-heading__copy">
          <p className="step-kicker">Setup · 1 of 3</p>
          <h1 id="background-intake-title">Event details</h1>
        </div>
      </header>

      {message && <p className="app-notice intake-message" role="status">{message}</p>}

      <div className="intake-basics event-source-step">
        <section className="intake-source" aria-labelledby="event-source-title">
          <div className="section-title-row">
            <div>
              <h2 id="event-source-title">Event source</h2>
            </div>
          </div>
          <form className="source-capture-form" onSubmit={addSource} noValidate>
            <label className="intake-source-field" htmlFor="intake-event-source">
              <span className="visually-hidden">Event link or organizer instructions</span>
              <textarea
                id="intake-event-source"
                rows={3}
                placeholder="Event link or organizer instructions"
                value={sourceValue}
                onChange={(event) => {
                  setSourceValue(event.target.value);
                  setSourceMessage("");
                }}
                aria-describedby={sourceMessage ? "source-feedback" : undefined}
              />
            </label>
            <button className="button button--quiet" type="submit" disabled={isAddingSource}>
              {isAddingSource ? "Reading source" : sources.length > 0 ? "Add source" : "Read event source"}
            </button>
            {sourceMessage && <p className="inline-status" id="source-feedback" role="status" aria-live="polite">{sourceMessage}</p>}
          </form>

          {sources.length > 0 && (
            <details className="intake-source-list">
              <summary>Sources in this plan <span>{sources.length}</span></summary>
              <ul>
                {sources.map((source) => (
                  <li key={source.id}>
                    <strong>{source.label}</strong>
                    <span>{sourceTypeFor(source)} · {sourceDate(source.observedAt)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

      </div>

      <section className="intake-facts" aria-labelledby="intake-facts-title">
        <div className="section-title-row">
          <div>
            <h2 id="intake-facts-title">Confirm the schedule</h2>
          </div>
        </div>

        <div className="schedule-confirm-grid">
          {SCHEDULE_FIELDS.map((field) => (
            <label className="schedule-confirm-field" key={field.id} htmlFor={`schedule-${field.id}`}>
              <span>{field.label}</span>
              <input
                id={`schedule-${field.id}`}
                type={field.type}
                value={scheduleValues[field.id]}
                onChange={(event) => setScheduleValues((current) => ({ ...current, [field.id]: event.target.value }))}
                autoComplete="off"
              />
              {fieldSourceLabel(field.id) && <small>{fieldSourceLabel(field.id)}</small>}
            </label>
          ))}
        </div>

        {conflictGroups.length > 0 && (
          <div className="unresolved-facts" aria-label="Unresolved source conflicts">
            {conflictGroups.map(([key, group]) => (
              <fieldset className="unresolved-fact" key={key}>
                <legend>{group[0].label}</legend>
                <div className="unresolved-fact__choices">
                  {group.filter((fact) => fact.status !== "superseded").map((fact) => {
                    const source = sourceById.get(fact.sourceId);
                    const selected = selectedByKey[key] === fact.id;
                    return (
                      <label className="unresolved-fact__choice" key={fact.id}>
                        <input
                          type="radio"
                          name={`intake-conflict-${key}`}
                          value={fact.id}
                          checked={selected}
                          onChange={() => selectFact(key, fact.id)}
                        />
                        <span>
                          <strong>{fact.value}</strong>
                          <small>{source?.label ?? "Source unavailable"}{source ? ` · ${sourceDate(source.observedAt)}` : ""}</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>
        )}

        {groups.length > 0 && (
          <details className="all-facts-details">
            <summary>Other source facts and history</summary>
            <div className="all-facts-details__body">
              {groups.map(([key, group]) => (
                <fieldset className="intake-fact-group" key={key}>
                  <legend>{group[0].label}</legend>
                  {group.every((fact) => fact.status === "superseded") && (
                    <p className="fact-history-note">
                      {key === "scheduledBreak"
                        ? "No current source confirms a break. This older lunch interval is archival and will not be scheduled."
                        : "Superseded values are retained for context and will not be used in the plan."}
                    </p>
                  )}
                  {group.map((fact) => {
                    const source = sourceById.get(fact.sourceId);
                    const selected = selectedByKey[key] === fact.id;
                    const archived = fact.status === "superseded";
                    return (
                      <div className={`fact-row intake-fact-row${selected ? " is-selected" : ""}${archived ? " fact-row--archived" : ""}`} key={fact.id}>
                        {archived ? <span className="fact-control-static" aria-hidden="true">—</span> : (
                          <label className="fact-control">
                            <input type="radio" name={`all-facts-${key}`} checked={selected} value={fact.id} onChange={() => selectFact(key, fact.id)} />
                            <span className="visually-hidden">Use {fact.value} from {source?.label ?? "unknown source"}</span>
                          </label>
                        )}
                        <div className="fact-row__source">
                          <strong>{source?.label ?? "Source unavailable"}</strong>
                          <span>{source ? `${sourceTypeFor(source)} · ${sourceDate(source.observedAt)}` : "Provenance unavailable"}</span>
                        </div>
                        <div className="fact-row__detail">
                          <strong>{fact.value}</strong>
                          <span>{fact.detail}</span>
                        </div>
                        <span className="fact-row__status">{statusLabel(fact.status)}</span>
                      </div>
                    );
                  })}
                </fieldset>
              ))}
            </div>
          </details>
        )}
      </section>

      <footer className="intake-actions">
        <button className="button button--quiet" type="button" onClick={onBack}>Back</button>
        <button className="button button--primary" type="button" onClick={continueIntake} disabled={!factsReady} aria-describedby={!factsReady ? "schedule-validation" : undefined}>
          Continue to team
        </button>
      </footer>
      {!factsReady && <p className="intake-validation" id="schedule-validation" role="status">Enter a valid date, time zone, start and cutoff.</p>}
    </section>
  );
}
