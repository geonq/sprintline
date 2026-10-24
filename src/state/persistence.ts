import { z } from "zod";
import { CAPABILITIES, DEVELOPER_SPECIALTIES, TEAM_DEPARTMENTS } from "../domain/types";
import type { SprintPlan, SprintlineState } from "../domain/types";

export type StoredTaskPriority = "P0" | "P1" | "P2" | "P3";

const sourceSchema = z
  .object({
    id: z.string().min(1).max(100),
    label: z.string().min(1).max(160),
    kind: z.enum(["event-page", "organizer-message", "prior-note"]),
    observedAt: z.string().max(40),
    note: z.string().max(500),
  })
  .strict();

const factSchema = z
  .object({
    id: z.string().min(1).max(120),
    key: z.enum([
      "eventDate",
      "timeZone",
      "eventStart",
      "agendaStart",
      "foodArrival",
      "scheduledBreak",
      "submissionDeadline",
      "deliverableRule",
      "videoDuration",
      "demoStart",
      "teamLimit",
    ]),
    label: z.string().min(1).max(120),
    value: z.string().max(240),
    detail: z.string().max(600),
    sourceId: z.string().min(1).max(100),
    status: z.enum(["needs-review", "confirmed", "superseded"]),
  })
  .strict();

const memberSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().max(80).optional(),
    department: z.enum(TEAM_DEPARTMENTS).optional(),
    specialty: z.enum(DEVELOPER_SPECIALTIES).optional(),
    capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length).optional(),
    availableFrom: z.string().max(40).optional(),
    availableUntil: z.string().max(40).optional(),
  })
  .strict();

const surveySchema = z
  .object({
    members: z.array(memberSchema).max(5),
    projectName: z.string().max(120),
    projectStage: z.enum(["idea", "in-progress", "working", "ready-to-demo"]),
    demoMode: z.enum(["product", "workflow", "automation", "exploration"]),
    outcome: z.string().max(2400),
    outcomeDoneWhen: z.string().max(240),
    breakStart: z.string().max(40).optional(),
    breakEnd: z.string().max(40).optional(),
  })
  .strict();

const taskSchema = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(180),
    category: z.enum(["build", "integrate", "verify", "record", "review", "submit", "other"]),
    ownerId: z.string().max(100).optional(),
    durationMinutes: z.number().int().min(0).max(600),
    startsAt: z.string().max(40),
    endsAt: z.string().max(40),
    dependsOn: z.array(z.string().max(100)).max(30),
    acceptance: z.string().max(1000),
    state: z.enum(["todo", "active", "blocked", "done", "deferred"]),
    protectedWindowKind: z.enum(["record", "review", "submit", "other"]).optional(),
    provisionalOwner: z.boolean().optional(),
  })
  .strict();

const planSchema = z
  .object({
    generatedAt: z.string().max(40),
    deadline: z.string().max(40),
    tasks: z.array(taskSchema).max(60),
    assumptions: z.array(z.string().max(1000)).max(30),
    cuts: z.array(z.string().max(1000)).max(30),
    feasible: z.boolean(),
    infeasibility: z.string().max(12000).optional(),
    missingRequirements: z.array(z.string().max(1000)).max(60).optional(),
  })
  .strict();

const sprintlineStateSchema = z
  .object({
    version: z.literal(1),
    facts: z.array(factSchema).max(120),
    sources: z.array(sourceSchema).max(30),
    survey: surveySchema,
    plan: planSchema.optional(),
    planAccepted: z.boolean().optional(),
    laterIdeas: z.array(z.string().max(500)).max(50),
    savedAt: z.string().max(40).optional(),
  })
  .strict();

export type LoadResult =
  | { status: "found"; state: SprintlineState }
  | { status: "empty" }
  | { status: "invalid"; message: string };

// v3 starts with an empty event and team flow. Older user data remains untouched.
const STORAGE_KEY = "sprintline-state-v3";
const PRIORITY_STORAGE_KEY = "sprintline-plan-priorities-v1";

export function loadSprintlineState(): LoadResult {
  let serialized: string | null;

  try {
    serialized = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return { status: "invalid", message: "This browser blocked local storage." };
  }

  if (serialized === null) return { status: "empty" };

  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    return { status: "invalid", message: "The saved plan could not be read." };
  }

  const parsed = sprintlineStateSchema.safeParse(decoded);
  if (!parsed.success) {
    return { status: "invalid", message: "The saved plan has an unsupported shape." };
  }

  return { status: "found", state: parsed.data };
}

export function saveSprintlineState(state: SprintlineState): string | undefined {
  const parsed = sprintlineStateSchema.safeParse({
    ...state,
    savedAt: new Date().toISOString(),
  });

  if (!parsed.success) return "Some plan data could not be saved.";

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed.data));
    return undefined;
  } catch {
    return "Browser storage is full or unavailable. Your latest changes may not survive refresh.";
  }
}

export function loadPlanPriorities(plan?: SprintPlan): Record<string, StoredTaskPriority> {
  if (!plan) return {};
  try {
    const serialized = window.localStorage.getItem(PRIORITY_STORAGE_KEY);
    if (!serialized) return {};
    const value: unknown = JSON.parse(serialized);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    if (record.planGeneratedAt !== plan.generatedAt || typeof record.priorities !== "object" || record.priorities === null || Array.isArray(record.priorities)) return {};
    const allowedIds = new Set(plan.tasks.map((task) => task.id));
    const priorities = record.priorities as Record<string, unknown>;
    return Object.fromEntries(Object.entries(priorities).filter((entry): entry is [string, StoredTaskPriority] =>
      allowedIds.has(entry[0]) && ["P0", "P1", "P2", "P3"].includes(String(entry[1])),
    )) as Record<string, StoredTaskPriority>;
  } catch {
    return {};
  }
}

export function savePlanPriorities(plan: SprintPlan, priorities: Record<string, StoredTaskPriority>): string | undefined {
  try {
    const allowedIds = new Set(plan.tasks.map((task) => task.id));
    const filtered = Object.fromEntries(Object.entries(priorities).filter(([id, priority]) =>
      allowedIds.has(id) && ["P0", "P1", "P2", "P3"].includes(priority),
    ));
    window.localStorage.setItem(PRIORITY_STORAGE_KEY, JSON.stringify({
      planGeneratedAt: plan.generatedAt,
      priorities: filtered,
    }));
    return undefined;
  } catch {
    return "Task priorities could not be saved locally.";
  }
}

export function clearSprintlineState(): string | undefined {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    return undefined;
  } catch {
    return "The saved plan could not be cleared.";
  }
}
