import type { PlannedTask, SprintPlan, TaskCategory, TeamSurvey as TeamSurveyData } from "../domain/types";

export interface PlanPreviewProps {
  survey: TeamSurveyData;
  plan: SprintPlan;
  onAccept: () => void;
  onBack: () => void;
}

const CATEGORY_LABELS: Record<TaskCategory, string> = {
  build: "Build",
  integrate: "Integrate",
  verify: "Verify",
  record: "Record",
  review: "Review",
  submit: "Submit",
  other: "Other",
};

function clockTime(value: string): string {
  const match = value.match(/(?:^|T|\s)(\d{2}:\d{2})/);
  return match?.[1] ?? value;
}

function taskOrder(left: PlannedTask, right: PlannedTask): number {
  return left.startsAt.localeCompare(right.startsAt);
}

export default function PlanPreview({ survey, plan, onAccept, onBack }: PlanPreviewProps) {
  const tasks = [...plan.tasks].sort(taskOrder);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const ownerById = new Map(survey.members.map((member) => [member.id, member.name]));
  const hasDeadline = Boolean(plan.deadline);

  return (
    <section className="flow-panel plan-preview" aria-labelledby="plan-preview-title">
      <header className="flow-heading">
        <div className="flow-heading__copy">
          <p className="step-kicker"><span className="step-marker">3</span> Review the plan</p>
          <h1 id="plan-preview-title">A finish line your team can reach.</h1>
          <p className="flow-intro">
            {survey.projectName ? `For ${survey.projectName}, ` : "For your project, "}
            work is assigned around each person's skills, availability, and the confirmed event schedule.
          </p>
        </div>
        <span className={`plan-status${plan.feasible ? " is-ready" : " is-blocked"}`}>
          <span className="plan-status__dot" aria-hidden="true" />
          {plan.feasible ? "Fits the available time" : "Needs a smaller scope"}
        </span>
      </header>

      {!plan.feasible && (
        <div className="plan-alert" role="alert">
          <span className="plan-alert__mark" aria-hidden="true">!</span>
          <div>
            <strong>This plan does not fit yet.</strong>
            <p>{plan.infeasibility ?? "Adjust the outcome or team availability and generate another plan."}</p>
          </div>
        </div>
      )}

      <div className="plan-summary">
        <div className="plan-summary__item">
          <span className="summary-label">Team</span>
          <strong>{survey.members.length} {survey.members.length === 1 ? "person" : "people"}</strong>
        </div>
        <div className="plan-summary__item">
          <span className="summary-label">Tasks</span>
          <strong>{tasks.length}</strong>
        </div>
        <div className="plan-summary__deadline">
          <span className="summary-label">Submission cutoff</span>
          <strong>{hasDeadline ? clockTime(plan.deadline) : "Not confirmed"}</strong>
          <span className="deadline-note">Confirmed event cutoff</span>
        </div>
      </div>

      <section className="schedule-section" aria-labelledby="schedule-title">
        <div className="section-title-row">
          <div>
            <h2 id="schedule-title">Who does what, and when</h2>
            <p>Dependencies and acceptance checks are shown with each task.</p>
          </div>
          <span className="quiet-tag">Europe/Berlin</span>
        </div>

        {tasks.length > 0 ? (
          <ol className="schedule-list">
            {tasks.map((task, index) => {
              const owner = task.ownerId ? ownerById.get(task.ownerId) : undefined;
              const dependencies = task.dependsOn
                .map((id) => taskById.get(id)?.title ?? id)
                .filter(Boolean);
              return (
                <li className={`schedule-task schedule-task--${task.category}`} key={task.id}>
                  <div className="schedule-task__time" aria-label={task.state === "blocked" ? `Unscheduled; requires ${task.durationMinutes} minutes` : `From ${clockTime(task.startsAt)} to ${clockTime(task.endsAt)}`}>
                    {task.state === "blocked" ? <strong>Blocked</strong> : <>
                      <time>{clockTime(task.startsAt)}</time>
                      <span aria-hidden="true" />
                      <time>{clockTime(task.endsAt)}</time>
                    </>}
                  </div>
                  <div className="schedule-task__body">
                    <div className="schedule-task__title-line">
                      <span className="sequence-number">{String(index + 1).padStart(2, "0")}</span>
                      <h3>{task.title}</h3>
                      <span className={`category-tag category-tag--${task.category}`}>{CATEGORY_LABELS[task.category]}</span>
                    </div>
                    <div className="task-meta">
                      <span className="task-owner">
                        <span className="meta-label">Owner</span>
                        {owner ?? (task.state === "blocked" ? "Unassigned" : "Shared team task")}
                      </span>
                      <span><span className="meta-label">Time</span>{task.durationMinutes} min</span>
                      {dependencies.length > 0 && (
                        <span className="task-dependency">
                          <span className="meta-label">After</span>
                          {dependencies.join(", ")}
                        </span>
                      )}
                    </div>
                    <p className="task-acceptance"><span className="meta-label">Done when</span>{task.acceptance}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="inline-empty">
            <strong>No tasks could be scheduled.</strong>
            <span>Go back and adjust the outcome or availability, then generate another plan.</span>
          </div>
        )}
      </section>

      <div className="plan-notes-grid">
        <section className="plan-note-section" aria-labelledby="assumptions-title">
          <h2 id="assumptions-title">Schedule assumptions</h2>
          {plan.assumptions.length > 0 ? (
            <ul>{plan.assumptions.map((assumption, index) => <li key={`${index}-${assumption}`}>{assumption}</li>)}</ul>
          ) : (
            <p className="note-empty">No extra assumptions were added.</p>
          )}
        </section>
        <section className="plan-note-section plan-note-section--cuts" aria-labelledby="cuts-title">
          <h2 id="cuts-title">Keep scope under control</h2>
          {plan.cuts.length > 0 ? (
            <ul>{plan.cuts.map((cut, index) => <li key={`${index}-${cut}`}>{cut}</li>)}</ul>
          ) : (
            <p className="note-empty">No scope cuts are needed for this plan.</p>
          )}
        </section>
      </div>

      <footer className="flow-actions">
        <button className="button button--quiet" type="button" onClick={onBack}>Back to team details</button>
        <button className="button button--primary" type="button" onClick={onAccept} disabled={!plan.feasible || tasks.length === 0}>
          Start the sprint
        </button>
      </footer>
    </section>
  );
}
