export const CAPABILITIES = [
  "product",
  "frontend",
  "backend",
  "data",
  "design",
  "testing",
  "demo",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const TEAM_DEPARTMENTS = [
  "developer",
  "product-design",
  "data-ai",
  "legal-policy",
  "sales-gtm",
  "ops-demo",
] as const;

export type TeamDepartment = (typeof TEAM_DEPARTMENTS)[number];

export const DEVELOPER_SPECIALTIES = [
  "frontend",
  "backend",
  "fullstack",
  "ai-data",
  "infrastructure",
] as const;

export type DeveloperSpecialty = (typeof DEVELOPER_SPECIALTIES)[number];

export type FactKey =
  | "eventDate"
  | "timeZone"
  | "eventStart"
  | "agendaStart"
  | "foodArrival"
  | "scheduledBreak"
  | "submissionDeadline"
  | "deliverableRule"
  | "videoDuration"
  | "demoStart"
  | "teamLimit";

export type FactStatus = "needs-review" | "confirmed" | "superseded";

export interface EventSource {
  id: string;
  label: string;
  kind: "event-page" | "organizer-message" | "prior-note";
  observedAt: string;
  note: string;
}

export interface EventFact {
  id: string;
  key: FactKey;
  label: string;
  value: string;
  detail: string;
  sourceId: string;
  status: FactStatus;
}

export interface TeamMember {
  id: string;
  name?: string;
  department?: TeamDepartment;
  specialty?: DeveloperSpecialty;
  capabilities?: Capability[];
  availableFrom?: string;
  availableUntil?: string;
}

export type ProjectStage = "idea" | "in-progress" | "working" | "ready-to-demo";
export type DemoMode = "product" | "workflow" | "automation" | "exploration";

export interface TeamSurvey {
  members: TeamMember[];
  projectName: string;
  projectStage: ProjectStage;
  demoMode: DemoMode;
  outcome: string;
  outcomeDoneWhen: string;
  breakStart?: string;
  breakEnd?: string;
}

export type TaskState = "todo" | "active" | "blocked" | "done" | "deferred";
export type TaskCategory = "build" | "integrate" | "verify" | "record" | "review" | "submit" | "other";

export type ProtectedWindowKind = "record" | "review" | "submit" | "other";

export interface ProtectedWindow {
  id: string;
  label: string;
  kind: ProtectedWindowKind;
  startAt: string;
  endAt: string;
  sourceFactIds: string[];
}

/** Confirmed event timing used by the local deterministic scheduler. */
export interface EventScheduleContext {
  date: string;
  timeZone: string;
  workStartAt: string;
  deadlineAt: string;
  protectedWindows: ProtectedWindow[];
}

export interface AIPlanTask {
  id: string;
  title: string;
  category: "build" | "integrate" | "verify";
  durationMinutes: number;
  dependsOn: string[];
  requiredCapabilities: Capability[];
  priority: number;
  rationale: string;
  acceptance: string;
}

export interface AIPlanProposal {
  summary: string;
  tasks: AIPlanTask[];
}

export interface PlannedTask {
  id: string;
  title: string;
  category: TaskCategory;
  ownerId?: string;
  durationMinutes: number;
  startsAt: string;
  endsAt: string;
  dependsOn: string[];
  acceptance: string;
  state: TaskState;
  protectedWindowKind?: ProtectedWindowKind;
  provisionalOwner?: boolean;
}

export interface SprintPlan {
  generatedAt: string;
  deadline: string;
  tasks: PlannedTask[];
  assumptions: string[];
  cuts: string[];
  feasible: boolean;
  infeasibility?: string;
  missingRequirements?: string[];
}

export interface SprintlineState {
  version: 1;
  facts: EventFact[];
  sources: EventSource[];
  survey: TeamSurvey;
  plan?: SprintPlan;
  planAccepted?: boolean;
  laterIdeas: string[];
  savedAt?: string;
}
