import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { PlannedTask, SprintPlan, TaskCategory, TaskState, TeamSurvey as TeamSurveyData } from "../domain/types";

export type TaskPriority = "P0" | "P1" | "P2" | "P3";

export interface WorkspaceProps {
  survey: TeamSurveyData;
  plan: SprintPlan;
  laterIdeas: string[];
  priorityByTaskId?: Record<string, TaskPriority>;
  eventLabel?: string;
  eventTimeZone?: string;
  audioMemo?: Blob | null;
  onTaskStateChange: (taskId: string, state: TaskState) => void;
  onSaveLater: (idea: string) => void;
  onRestart: () => void;
}

const TASK_STATES: TaskState[] = ["todo", "active", "blocked", "done", "deferred"];
const STATE_LABELS: Record<TaskState, string> = {
  todo: "To do",
  active: "In progress",
  blocked: "Blocked",
  done: "Done",
  deferred: "Deferred",
};
const DEFAULT_PRIORITY: Record<TaskCategory, TaskPriority> = {
  submit: "P0",
  record: "P0",
  review: "P0",
  other: "P2",
  verify: "P1",
  integrate: "P1",
  build: "P2",
};

function clockTime(value: string, timeZone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(date);
  }
}

function instant(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function taskOrder(left: PlannedTask, right: PlannedTask): number {
  return left.startsAt.localeCompare(right.startsAt);
}

export default function Workspace({
  survey,
  plan,
  laterIdeas,
  priorityByTaskId = {},
  eventLabel = "Event schedule",
  eventTimeZone = "UTC",
  audioMemo = null,
  onTaskStateChange,
  onSaveLater,
  onRestart,
}: WorkspaceProps) {
  const [idea, setIdea] = useState("");
  const [ideaStatus, setIdeaStatus] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [voiceMemoUrl, setVoiceMemoUrl] = useState("");
  const tasks = useMemo(() => [...plan.tasks].sort(taskOrder), [plan.tasks]);
  const dependenciesDone = (task: PlannedTask) => task.startsAt !== task.endsAt && task.dependsOn.every((id) => tasks.some((dependency) => dependency.id === id && dependency.state === "done"));
  const activeTask = tasks.find((task) => task.state === "active" && dependenciesDone(task));
  const currentTask = activeTask ?? tasks.find((task) => task.state === "todo" && dependenciesDone(task));
  const doneCount = tasks.filter((task) => task.state === "done").length;
  const blockedCount = tasks.filter((task) => task.state === "blocked").length;
  const deferredCount = tasks.filter((task) => task.state === "deferred").length;
  const ownerById = useMemo(() => new Map(survey.members.map((member) => [member.id, member.name?.trim() || undefined])), [survey.members]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!audioMemo) {
      setVoiceMemoUrl("");
      return;
    }
    const url = URL.createObjectURL(audioMemo);
    setVoiceMemoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [audioMemo]);

  function priorityFor(task: PlannedTask): TaskPriority {
    return priorityByTaskId[task.id] ?? DEFAULT_PRIORITY[task.category];
  }

  const target = currentTask
    ? instant(activeTask ? currentTask.endsAt : currentTask.startsAt)
    : undefined;
  const countdownDelta = target === undefined ? undefined : target - now;
  const countdownLabel = !currentTask
    ? "No active stage"
    : activeTask
      ? countdownDelta !== undefined && countdownDelta < 0 ? "Over target" : "Time remaining"
      : countdownDelta !== undefined && countdownDelta > 0 ? "Starts in" : "Start now";

  function saveIdea(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = idea.trim();
    if (!value) {
      setIdeaStatus("Add a short note before saving it for later.");
      return;
    }
    onSaveLater(value);
    setIdea("");
    setIdeaStatus("Added to the later list.");
  }

  function advanceTask(task: PlannedTask) {
    if (task.state === "todo") onTaskStateChange(task.id, "active");
    if (task.state === "active") onTaskStateChange(task.id, "done");
  }

  return (
    <main className="workspace-screen" aria-labelledby="workspace-title">
      <div className="workspace-screen__header">
        <div className="workspace-project-lockup">
          <span className="workspace-project-mark" aria-hidden="true">S</span>
          <div>
            <p className="workspace-project-name">{survey.projectName || "Sprint workspace"}</p>
            <p className="workspace-project-meta">{survey.members.length} {survey.members.length === 1 ? "person" : "people"} · {eventLabel} · {eventTimeZone}</p>
          </div>
        </div>
        <button className="workspace-link-button" type="button" onClick={onRestart}>Back to intake</button>
      </div>

      <div className="execution-clock-rail" aria-label="Current stage countdown">
        <div className="execution-clock">
          <span className="execution-clock__label">{countdownLabel}</span>
          <time className="execution-clock__value" aria-label={countdownLabel === "Time remaining" ? `Time remaining ${countdownDelta === undefined ? "" : formatCountdown(Math.abs(countdownDelta))}` : countdownLabel === "Starts in" ? `Stage starts in ${countdownDelta === undefined ? "" : formatCountdown(countdownDelta)}` : countdownLabel}>
            {countdownDelta === undefined
              ? "--:--:--"
              : activeTask && countdownDelta < 0
                ? `+${formatCountdown(Math.abs(countdownDelta))}`
                : formatCountdown(countdownDelta)}
          </time>
          {currentTask && <span className="execution-clock__stage">{currentTask.protectedWindowKind ? "Confirmed window" : "Estimated stage"} · {currentTask.title}</span>}
        </div>
      </div>

      <div className="workspace-content">
        <header className="workspace-title-row">
          <div>
            <p className="screen-index">EXECUTION / SPRINT</p>
            <h1 id="workspace-title">Build toward the finish.</h1>
            <p className="workspace-intro">Priority work first. Generated task times are estimates.</p>
          </div>
          <div className="workspace-deadline">
            <span>Submission cutoff</span>
            <strong>{clockTime(plan.deadline, eventTimeZone) || "Not confirmed"}</strong>
          </div>
        </header>

        {audioMemo && (
          <section className="workspace-voice-note" aria-label="Local voice memo">
            <div>
              <strong>Voice memo</strong>
              <span>Plan generated from typed text · audio stays local</span>
            </div>
            <audio controls src={voiceMemoUrl} aria-label="Listen to saved voice memo">Audio memo playback is unavailable.</audio>
          </section>
        )}

        <div className="workspace-save-note" role="note">
          <span className="save-indicator" aria-hidden="true" />
          <p><strong>Local copy</strong> Plan and progress stay in this browser on this device; they do not sync to other team members' devices.</p>
        </div>

        <section className="workspace-progress" aria-label="Sprint progress">
          <div className="workspace-progress__copy">
            <span><strong>{doneCount}</strong> of {tasks.length} complete</span>
            <span>{blockedCount > 0 ? `${blockedCount} blocked` : ""}{blockedCount > 0 && deferredCount > 0 ? " · " : ""}{deferredCount > 0 ? `${deferredCount} deferred` : ""}</span>
          </div>
          {tasks.length > 0 && <progress value={doneCount} max={tasks.length} aria-label={`${doneCount} of ${tasks.length} tasks complete`} />}
        </section>

        {currentTask && (
          <section className="current-stage" aria-labelledby="current-stage-title">
            <div>
              <p className="current-stage__eyebrow">{activeTask ? "Current stage" : "Next stage"} · {priorityFor(currentTask)}</p>
              <h2 id="current-stage-title">{currentTask.title}</h2>
              <p>{currentTask.acceptance}</p>
            </div>
            <button className="button button--primary" type="button" onClick={() => advanceTask(currentTask)}>
              {activeTask ? "Complete stage" : "Start stage"}
            </button>
          </section>
        )}

        {tasks.length === 0 ? (
          <div className="execution-empty">
            <strong>No tasks in this sprint.</strong>
            <span>Return to the project prompt and generate a plan.</span>
          </div>
        ) : !currentTask && doneCount === tasks.length ? (
          <div className="execution-empty" role="status">
            <strong>Every planned task is complete.</strong>
            <span>Use the remaining time to check the recording and submission requirements.</span>
          </div>
        ) : !currentTask ? (
          <div className="execution-empty" role="status">
            <strong>No task is ready to start.</strong>
            <span>Review blocked or deferred work in the timeline below.</span>
          </div>
        ) : null}

        <section className="execution-timeline-section" aria-labelledby="timeline-title">
          <div className="execution-timeline-heading">
            <h2 id="timeline-title">Sprint timeline</h2>
            <p>Estimated time · priority · owner · status · dependencies</p>
          </div>

          {tasks.length > 0 ? (
            <ol className="execution-timeline">
              {tasks.map((task) => {
                const owner = task.ownerId ? ownerById.get(task.ownerId) : undefined;
                const dependencies = task.dependsOn.map((id) => tasks.find((dependency) => dependency.id === id)?.title ?? id);
                const priority = priorityFor(task);
                const isCurrent = task.id === currentTask?.id;
                return (
                  <li className={`execution-task execution-task--${task.state}${isCurrent ? " is-current" : ""}`} key={task.id} aria-current={isCurrent ? "step" : undefined}>
                    <div className="execution-task__time">
                      <span className="meta-label">{task.protectedWindowKind ? "Confirmed window" : "Estimate"}</span>
                      <time>{task.startsAt === task.endsAt ? "Unscheduled" : clockTime(task.startsAt, eventTimeZone)}</time>
                      <span>{task.startsAt === task.endsAt ? `Needs ${task.durationMinutes} min` : clockTime(task.endsAt, eventTimeZone)}</span>
                    </div>
                    <span className={`execution-task__priority execution-task__priority--${priority.toLowerCase()}`}>{priority}</span>
                    <div className="execution-task__summary">
                      <h3>{task.title}</h3>
                      <p>{task.acceptance}</p>
                    </div>
                    <div className="execution-task__owner">
                      <span className="meta-label">Owner</span>
                      <span>{owner ?? (task.state === "blocked" ? "Unassigned" : "Shared")}</span>
                    </div>
                    <div className="execution-task__dependencies">
                      <span className="meta-label">Depends on</span>
                      <span>{dependencies.length > 0 ? dependencies.join(", ") : "None"}</span>
                    </div>
                    <label className="execution-task__status">
                      <span className="visually-hidden">Update status for {task.title}</span>
                      <select
                        value={task.state}
                        aria-label={`Update status for ${task.title}`}
                        onChange={(event) => onTaskStateChange(task.id, event.target.value as TaskState)}
                      >
                        {TASK_STATES.map((state) => (
                          <option
                            value={state}
                            key={state}
                            disabled={(state === "active" || state === "done") && !dependenciesDone(task)}
                          >
                            {STATE_LABELS[state]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </li>
                );
              })}
            </ol>
          ) : null}
        </section>

        <section className="workspace-later" aria-labelledby="later-ideas-title">
          <div>
            <h2 id="later-ideas-title">Later ideas</h2>
            <p>Save ideas without changing the sprint in progress.</p>
          </div>
          <form className="later-idea-form" onSubmit={saveIdea}>
            <label className="visually-hidden" htmlFor="later-idea">Idea to save for later</label>
            <input
              id="later-idea"
              maxLength={500}
              type="text"
              value={idea}
              onChange={(event) => {
                setIdea(event.target.value);
                setIdeaStatus("");
              }}
              placeholder="Add one idea you are not building now"
              autoComplete="off"
              aria-describedby="later-idea-status"
            />
            <button className="button button--quiet" type="submit">Save</button>
          </form>
          {laterIdeas.length > 0 && (
            <ul aria-label="Saved later ideas">
              {laterIdeas.map((savedIdea, index) => <li key={`${index}-${savedIdea}`}>{savedIdea}</li>)}
            </ul>
          )}
          <p className="inline-status" id="later-idea-status" role="status" aria-live="polite">{ideaStatus}</p>
        </section>
      </div>
    </main>
  );
}
