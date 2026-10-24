import { useEffect, useMemo, useState } from "react";
import type { EventFact, EventSource, FactKey } from "../domain/types";

export interface SourceReviewProps {
  sources: EventSource[];
  facts: EventFact[];
  onPaste: (text: string) => boolean;
  onConfirm: (selectedFactIds: string[]) => void;
  confirmed: boolean;
}

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

function sourceType(kind: EventSource["kind"]): string {
  if (kind === "organizer-message") return "Organizer update";
  if (kind === "prior-note") return "Earlier note";
  return "Event page";
}

function sourceDate(value: string): string {
  if (!value.includes("T")) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  }).format(date);
}

function statusLabel(status: EventFact["status"]): string {
  if (status === "confirmed") return "Confirmed current";
  if (status === "superseded") return "Older information";
  return "Needs confirmation";
}

function getInitialSelections(facts: EventFact[]): Record<string, string> {
  const grouped = new Map<FactKey, EventFact[]>();
  facts.forEach((fact) => {
    grouped.set(fact.key, [...(grouped.get(fact.key) ?? []), fact]);
  });

  const selections: Record<string, string> = {};
  grouped.forEach((group, key) => {
    const confirmed = group.filter((fact) => fact.status === "confirmed");
    if (confirmed.length === 1) {
      selections[key] = confirmed[0].id;
      return;
    }
    const active = group.filter((fact) => fact.status !== "superseded");
    if (active.length === 1) selections[key] = active[0].id;
  });
  return selections;
}

export default function SourceReview({
  sources,
  facts,
  onPaste,
  onConfirm,
  confirmed,
}: SourceReviewProps) {
  const [pastedText, setPastedText] = useState("");
  const [pasteMessage, setPasteMessage] = useState("");
  const factSignature = facts
    .map((fact) => `${fact.id}:${fact.status}:${fact.value}`)
    .join("|");
  const initialSelections = useMemo(() => getInitialSelections(facts), [factSignature]);
  const [selectedByKey, setSelectedByKey] = useState<Record<string, string>>(initialSelections);

  useEffect(() => {
    setSelectedByKey(initialSelections);
  }, [initialSelections]);

  const sourceById = useMemo(
    () => new Map(sources.map((source) => [source.id, source])),
    [sources],
  );
  const factGroups = useMemo(() => {
    const grouped = new Map<FactKey, EventFact[]>();
    facts.forEach((fact) => {
      grouped.set(fact.key, [...(grouped.get(fact.key) ?? []), fact]);
    });
    return [...grouped.entries()].sort(
      ([left], [right]) => FACT_ORDER.indexOf(left) - FACT_ORDER.indexOf(right),
    );
  }, [facts]);
  const decisionGroups = factGroups.filter(([, group]) => group.some((fact) => fact.status !== "superseded"));
  const canConfirm = decisionGroups.length > 0 && decisionGroups.every(([key, group]) =>
    group.some((fact) => fact.id === selectedByKey[key]),
  );

  function addPastedSource() {
    const text = pastedText.trim();
    if (!text) {
      setPasteMessage("Paste the event instruction you want to review.");
      return;
    }
    if (onPaste(text)) {
      setPastedText("");
      setPasteMessage("Extracted facts are ready for review. The pasted text was discarded.");
    } else {
      setPasteMessage("The text was kept here so you can edit it. Check the message above.");
    }
  }

  function confirmFacts() {
    if (!canConfirm) return;
    onConfirm(decisionGroups.flatMap(([key]) => selectedByKey[key] ? [selectedByKey[key]] : []));
  }

  return (
    <section className="flow-panel source-review" aria-labelledby="source-review-title">
      <header className="flow-heading">
        <div className="flow-heading__copy">
          <p className="step-kicker"><span className="step-marker">1</span> Event details</p>
          <h1 id="source-review-title">Start with what the event actually requires.</h1>
          <p className="flow-intro">
            Check where each time and deliverable came from. Resolve any older or conflicting note before planning.
          </p>
        </div>
        <div className={`confirmation-flag${confirmed ? " is-confirmed" : ""}`} role="status" aria-live="polite">
          <span className="confirmation-flag__dot" aria-hidden="true" />
          {confirmed ? "Event facts confirmed" : "Review needed"}
        </div>
      </header>

      <div className="source-input-section">
        <div className="section-title-row">
          <div>
            <h2>Event instructions</h2>
            <p>Use the DevDay pack or paste the relevant organizer text.</p>
          </div>
          <span className="quiet-tag">No account or API key</span>
        </div>

        {sources.length > 0 ? (
          <ul className="source-list" aria-label="Event sources">
            {sources.map((source) => (
              <li className="source-row" key={source.id}>
                <span className={`source-mark source-mark--${source.kind}`} aria-hidden="true" />
                <div className="source-row__body">
                  <div className="source-row__title-line">
                    <strong>{source.label}</strong>
                    <span className="source-kind">{sourceType(source.kind)}</span>
                  </div>
                  <p>{source.note}</p>
                </div>
                <time className="source-date" dateTime={source.observedAt === "unknown" ? undefined : source.observedAt}>
                  {sourceDate(source.observedAt)}
                </time>
              </li>
            ))}
          </ul>
        ) : (
          <div className="inline-empty">
            <strong>No event pack loaded yet.</strong>
            <span>Paste the organizer's schedule or load a dated event pack to begin.</span>
          </div>
        )}

        <div className="paste-entry">
          <label htmlFor="event-instructions">Paste event instructions</label>
          <textarea
            id="event-instructions"
            value={pastedText}
            onChange={(event) => {
              setPastedText(event.target.value);
              setPasteMessage("");
            }}
            rows={3}
            placeholder="For example: Demo presentations begin at 14:00. Submit your project by 15:45."
            aria-describedby="paste-help paste-status"
          />
          <div className="paste-entry__footer">
            <span id="paste-help">Only include instructions needed to plan your sprint.</span>
            <button className="button button--quiet" type="button" onClick={addPastedSource}>
              Review pasted text
            </button>
          </div>
          <p className="inline-status" id="paste-status" role="status" aria-live="polite">
            {pasteMessage}
          </p>
        </div>
      </div>

      <div className="facts-section">
        <div className="section-title-row">
          <div>
            <h2>Confirm the facts</h2>
            <p>Choose one instruction for each detail. Source dates stay visible beside every claim.</p>
          </div>
          <span className="fact-count">{facts.length} {facts.length === 1 ? "fact" : "facts"}</span>
        </div>

        {factGroups.length > 0 ? (
          <div className="fact-groups">
            {factGroups.map(([key, group]) => (
              <fieldset className="fact-group" key={key}>
                <legend>{group[0].label}</legend>
                {group.length > 1 && (
                  <p className="fact-group__prompt">More than one version was found. Choose the one to use.</p>
                )}
                {group.every((fact) => fact.status === "superseded") && (
                  <p className="fact-history-note">
                    {key === "scheduledBreak"
                      ? "No current source confirms a scheduled break. This earlier lunch interval is retained as context only and will not be scheduled."
                      : "Every source for this detail is superseded. These values remain visible for context and will not be used in the plan."}
                  </p>
                )}
                <div className="fact-table">
                  <div className="fact-table-head" aria-hidden="true">
                    <span>Choose</span>
                    <span>Source and date</span>
                    <span>Reported fact</span>
                    <span>Review state</span>
                  </div>
                  {group.map((fact) => {
                    const source = sourceById.get(fact.sourceId);
                    const isHistorical = fact.status === "superseded";
                    const selected = selectedByKey[key] === fact.id;
                    const control = isHistorical ? (
                      <span className="fact-control-static" aria-hidden="true">—</span>
                    ) : (
                      <label className="fact-control">
                        <input
                          type="radio"
                          name={`fact-${key}`}
                          value={fact.id}
                          checked={selected}
                          onChange={() => setSelectedByKey((current) => ({ ...current, [key]: fact.id }))}
                        />
                        <span className="visually-hidden">Use {fact.value} from {source?.label ?? "unknown source"}</span>
                      </label>
                    );
                    return (
                      <div className={`fact-row${selected ? " is-selected" : ""}${isHistorical ? " fact-row--archived" : ""}`} key={fact.id}>
                        {control}
                        <div className="fact-row__source">
                          <strong>{source?.label ?? "Source unavailable"}</strong>
                          <span>{source ? `${sourceType(source.kind)} · ${sourceDate(source.observedAt)}` : "Provenance unavailable"}</span>
                        </div>
                        <div className="fact-row__detail">
                          <strong>{fact.value}</strong>
                          <span>{fact.detail}</span>
                        </div>
                        <span className="fact-row__status">{statusLabel(fact.status)}</span>
                      </div>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>
        ) : (
          <div className="inline-empty inline-empty--facts">
            <strong>There are no schedule facts to confirm.</strong>
            <span>Add event instructions above, then review the extracted times and deliverables here.</span>
          </div>
        )}
      </div>

      <footer className="flow-actions">
        <p className="flow-actions__hint">
          {canConfirm ? "Your selections become the schedule assumptions." : "Choose one source for every conflicting detail to continue."}
        </p>
        <button className="button button--primary" type="button" onClick={confirmFacts} disabled={!canConfirm}>
          {confirmed ? "Update confirmed facts" : "Confirm facts and continue"}
        </button>
      </footer>
    </section>
  );
}
