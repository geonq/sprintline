import { CAPABILITIES, DEVELOPER_SPECIALTIES, TEAM_DEPARTMENTS } from "./types";
import type {
  AIPlanProposal,
  AIPlanTask,
  Capability,
  DeveloperSpecialty,
  EventFact,
  EventScheduleContext,
  PlannedTask,
  ProtectedWindow,
  SprintPlan,
  TeamMember,
  TeamDepartment,
  TeamSurvey,
} from "./types";

const MAX_PROPOSAL_TASKS = 12;
const MAX_PROTECTED_WINDOWS = 10;
const MIN_TASK_MINUTES = 5;
const MAX_TASK_MINUTES = 240;
const MINUTE_MS = 60_000;

const DEPARTMENT_CAPABILITIES: Record<TeamDepartment, Capability[]> = {
  developer: ["frontend", "backend"],
  "product-design": ["product", "design"],
  "data-ai": ["data"],
  "legal-policy": ["product"],
  "sales-gtm": ["product", "demo"],
  "ops-demo": ["demo", "testing"],
};

const DEVELOPER_CAPABILITIES: Record<DeveloperSpecialty, Capability[]> = {
  frontend: ["frontend"],
  backend: ["backend"],
  fullstack: ["frontend", "backend"],
  "ai-data": ["data", "backend"],
  infrastructure: ["backend", "testing"],
};

interface EventBounds {
  date: string;
  timeZone: string;
  start: number;
  deadline: number;
  windows: ProtectedWindow[];
}

interface Booking {
  start: number;
  end: number;
  taskId: string;
}

interface MemberState {
  id?: string;
  index: number;
  capabilities: Capability[];
  hasCapabilityInput: boolean;
  availableFrom: number;
  availableUntil: number;
  bookings: Booking[];
  scheduledLoad: number;
  eligible: boolean;
}

interface Interval {
  start: number;
  end: number;
}

/**
 * Schedules a validated AI proposal against user-confirmed event timing.
 * Protected work is created locally from confirmed source-attributed windows.
 * With an explicit generatedAt, identical inputs produce identical schedules.
 */
export function createSprintPlan(
  survey: TeamSurvey,
  facts: EventFact[],
  event?: EventScheduleContext,
  proposal?: AIPlanProposal,
  generatedAt: Date = new Date(),
): SprintPlan {
  const clock = validDate(generatedAt) ? generatedAt.getTime() : Date.now();
  const generatedIso = new Date(clock).toISOString();
  const assumptions: string[] = [];
  const missingRequirements: string[] = [];
  const reasons: string[] = [];

  if (!validDate(generatedAt)) reasons.push("The plan generation time is invalid.");

  const eventResult = resolveEvent(facts, event);
  if (Array.isArray(facts) && facts.some((fact) => fact?.status === "confirmed" && /^(?:CET|CEST)$/i.test(cleanText(fact.value, 20)))) {
    assumptions.push("A confirmed CET/CEST abbreviation is interpreted as Europe/Berlin for scheduling; verify that zone choice against the event source.");
  }
  missingRequirements.push(...eventResult.missing);
  reasons.push(...eventResult.errors);
  if (!eventResult.bounds) {
    return emptyPlan(generatedIso, assumptions, reasons, missingRequirements);
  }
  const bounds = eventResult.bounds;

  const proposalResult = validateProposal(proposal);
  missingRequirements.push(...proposalResult.missing);
  reasons.push(...proposalResult.errors);
  if (!proposalResult.tasks) {
    return emptyPlan(generatedIso, assumptions, reasons, missingRequirements, new Date(bounds.deadline).toISOString());
  }
  const protectedIds = new Set(bounds.windows.map(protectedTaskId));
  if (proposalResult.tasks.some((task) => protectedIds.has(task.id))) {
    reasons.push("A proposed task ID collides with a locally protected event task.");
    return emptyPlan(generatedIso, assumptions, reasons, missingRequirements, new Date(bounds.deadline).toISOString());
  }
  const missingDeliverableTasks = requiredUnwindowedDeliverableTasks(proposalResult.tasks, bounds.windows, facts);
  if (missingDeliverableTasks.length > 0) {
    return emptyPlan(generatedIso, assumptions, reasons, [...missingRequirements, ...missingDeliverableTasks], new Date(bounds.deadline).toISOString());
  }

  if (!Array.isArray(survey?.members) || survey.members.length < 1 || survey.members.length > 5) {
    missingRequirements.push("Choose a team size from 1 to 5.");
    return emptyPlan(generatedIso, assumptions, reasons, missingRequirements, new Date(bounds.deadline).toISOString());
  }

  if (clock >= bounds.deadline) {
    reasons.push("The confirmed submission deadline has passed; required work cannot be completed on time.");
  }

  const breakResult = parseBreak(survey, bounds);
  if (breakResult.error) {
    missingRequirements.push(breakResult.error);
    return emptyPlan(generatedIso, assumptions, reasons, missingRequirements, new Date(bounds.deadline).toISOString());
  }

  const members = makeMembers(survey.members, bounds, assumptions, reasons);
  const proposalTasks = proposalResult.tasks;
  const dependencyOrder = topologicalOrder(proposalTasks);
  if (!dependencyOrder) {
    reasons.push("The task proposal contains a dependency cycle.");
    return emptyPlan(generatedIso, assumptions, reasons, missingRequirements, new Date(bounds.deadline).toISOString());
  }

  const protectedAssignments = reserveProtectedWindows(bounds, members, breakResult.interval, assumptions, reasons);

  const tasksById = new Map<string, PlannedTask>();
  const planned: PlannedTask[] = [];
  const earliestPlanningTime = Math.max(bounds.start, clock);
  if (clock < bounds.start) {
    assumptions.push(`Planning begins at the confirmed event start (${formatAt(bounds.start, bounds.timeZone)}).`);
  }

  for (const window of bounds.windows) {
    const fixedTask = makeProtectedTask(window, protectedAssignments.get(window.id), clock, reasons, assumptions);
    planned.push(fixedTask);
    tasksById.set(fixedTask.id, fixedTask);
  }

  for (const spec of dependencyOrder) {
    const failedDependency = spec.dependsOn.find((id) => tasksById.get(id)?.state !== "todo");
    const dependencyEnd = Math.max(
      earliestPlanningTime,
      ...spec.dependsOn.map((id) => Date.parse(tasksById.get(id)?.endsAt ?? "") || earliestPlanningTime),
    );

    if (failedDependency) {
      const task = blockedTask(spec, bounds.deadline, `Waiting for “${failedDependency}”, which is not scheduled.`);
      planned.push(task);
      tasksById.set(task.id, task);
      reasons.push(`“${spec.title}” cannot start because dependency “${failedDependency}” is blocked.`);
      continue;
    }

    const assigned = scheduleProposedTask(spec, members, {
      earliest: dependencyEnd,
      deadline: bounds.deadline,
      protected: bounds.windows.map((window) => ({
        start: Date.parse(window.startAt),
        end: Date.parse(window.endAt),
      })),
      breakWindow: breakResult.interval,
    });

    if (!assigned) {
      const task = blockedTask(spec, bounds.deadline, `No eligible available owner has a full ${spec.durationMinutes}-minute slot before the confirmed deadline.`);
      planned.push(task);
      tasksById.set(task.id, task);
      reasons.push(`“${spec.title}” does not fit before the confirmed deadline; its duration was not shortened.`);
      continue;
    }

    const task: PlannedTask = {
      id: spec.id,
      title: spec.title,
      category: spec.category,
      ...(assigned.member.id ? { ownerId: assigned.member.id } : {}),
      durationMinutes: spec.durationMinutes,
      startsAt: new Date(assigned.start).toISOString(),
      endsAt: new Date(assigned.end).toISOString(),
      dependsOn: [...spec.dependsOn],
      acceptance: spec.acceptance,
      state: "todo",
      ...(assigned.provisional ? { provisionalOwner: true } : {}),
    };
    reserve(assigned.member, assigned.start, assigned.end, task.id);
    planned.push(task);
    tasksById.set(task.id, task);
  }

  const cuts = buildCuts(planned, bounds);
  const uniqueReasons = [...new Set(reasons)];
  const orderedTasks = planned.sort((a, b) => {
    const timeDifference = Date.parse(a.startsAt) - Date.parse(b.startsAt);
    return timeDifference || a.id.localeCompare(b.id);
  });

  return {
    generatedAt: generatedIso,
    deadline: new Date(bounds.deadline).toISOString(),
    tasks: orderedTasks,
    assumptions: [...new Set(assumptions)],
    cuts,
    feasible: uniqueReasons.length === 0 && orderedTasks.every((task) => task.state === "todo"),
    ...(uniqueReasons.length > 0 ? { infeasibility: uniqueReasons.join(" ") } : {}),
    ...(missingRequirements.length > 0 ? { missingRequirements: [...new Set(missingRequirements)] } : {}),
  };
}

function resolveEvent(factsInput: EventFact[], supplied?: EventScheduleContext): {
  bounds?: EventBounds;
  missing: string[];
  errors: string[];
} {
  const facts = Array.isArray(factsInput) ? factsInput.filter((fact) => fact?.status === "confirmed") : [];
  const missing: string[] = [];
  const errors: string[] = [];

  const dateFacts = facts.filter((fact) => fact.key === "eventDate");
  const zoneFacts = facts.filter((fact) => fact.key === "timeZone");
  const dateValues = uniqueValues(dateFacts.map((fact) => normalizeFactDate(fact.value)));
  const zoneValues = uniqueValues(zoneFacts.map((fact) => normalizeZone(fact.value)));
  const agendaFacts = facts.filter((fact) => fact.key === "agendaStart");
  const eventStartFacts = facts.filter((fact) => fact.key === "eventStart");
  const deadlineFacts = facts.filter((fact) => fact.key === "submissionDeadline");

  if (dateValues.length === 0) missing.push("Confirm the event date from a source.");
  else if (dateValues.length > 1) errors.push("Confirmed event-date sources conflict; resolve them before planning.");
  if (dateFacts.some((fact) => !normalizeFactDate(fact.value))) errors.push("A confirmed event-date fact could not be interpreted; resolve it before planning.");
  if (zoneValues.length === 0) missing.push("Confirm the event time zone from a source.");
  else if (zoneValues.length > 1) errors.push("Confirmed time-zone sources conflict; resolve them before planning.");
  if (zoneFacts.some((fact) => !normalizeZone(fact.value))) errors.push("A confirmed time-zone fact is not a supported IANA zone.");

  const startFacts = [...agendaFacts, ...eventStartFacts];
  const startTimes = uniqueValues(startFacts.map((fact) => extractClock(fact.value)));
  if (startFacts.length === 0) missing.push("Confirm the event or agenda start time from a source.");
  else if (startFacts.some((fact) => !extractClock(fact.value))) errors.push("A confirmed start-time fact could not be interpreted.");

  const deadlineTimes = uniqueValues(deadlineFacts.map((fact) => extractClock(fact.value)));
  if (deadlineFacts.length === 0) missing.push("Confirm the submission deadline from a source.");
  else if (deadlineTimes.length !== 1) errors.push("Confirmed submission-deadline sources conflict or are ambiguous; resolve them before planning.");
  if (deadlineFacts.some((fact) => !extractClock(fact.value))) errors.push("A confirmed submission-deadline fact could not be interpreted.");

  if (missing.length > 0 || errors.length > 0) return { missing, errors };

  const date = dateValues[0];
  const timeZone = zoneValues[0];
  let selectedStartTime: string | undefined;
  if (startTimes.length === 1) {
    selectedStartTime = startTimes[0];
  } else if (supplied) {
    const suppliedStart = parseExplicitInstant(supplied.workStartAt);
    selectedStartTime = startTimes.find((clock) => localDateTimeToInstant(date, clock, timeZone) === suppliedStart);
    if (!selectedStartTime) errors.push("The selected work start does not match one of the confirmed start-time facts.");
  } else {
    errors.push("Confirmed event and agenda start times differ; select which source controls the work start.");
  }
  if (!selectedStartTime) return { missing, errors };

  const factStart = localDateTimeToInstant(date, selectedStartTime, timeZone);
  const factDeadline = localDateTimeToInstant(date, deadlineTimes[0], timeZone);
  if (factStart === undefined || factDeadline === undefined) {
    missing.push("Use valid local start and deadline times for the confirmed event date and time zone.");
    return { missing, errors };
  }

  const workStartAt = supplied?.workStartAt ?? new Date(factStart).toISOString();
  const deadlineAt = supplied?.deadlineAt ?? new Date(factDeadline).toISOString();
  const start = parseExplicitInstant(workStartAt);
  const deadline = parseExplicitInstant(deadlineAt);
  const suppliedDate = normalizeIsoDate(supplied?.date ?? date);
  const suppliedZone = supplied?.timeZone ?? timeZone;

  if (!supplied || suppliedDate !== date || normalizeZone(suppliedZone) !== timeZone) {
    if (supplied && (suppliedDate !== date || normalizeZone(suppliedZone) !== timeZone)) {
      errors.push("The schedule context conflicts with confirmed event date or time-zone facts.");
    }
  }
  if (start === undefined || deadline === undefined) {
    missing.push("Event start and deadline must include explicit time-zone offsets.");
    return { missing, errors };
  }
  if (start !== factStart || deadline !== factDeadline) {
    errors.push("The supplied start or deadline does not match its confirmed source fact.");
  }
  if (dateAt(start, timeZone) !== date || dateAt(deadline, timeZone) !== date || deadline <= start) {
    errors.push("The confirmed work start and deadline must fall on the event date in chronological order.");
  }

  const rawWindows = Array.isArray(supplied?.protectedWindows) ? supplied!.protectedWindows : [];
  const windowsResult = validateProtectedWindows(rawWindows, facts, date, timeZone, start, deadline);
  errors.push(...windowsResult.errors);
  if (missing.length > 0 || errors.length > 0) return { missing, errors };

  return {
    bounds: { date, timeZone, start, deadline, windows: windowsResult.windows },
    missing,
    errors,
  };
}

function validateProtectedWindows(
  windowsInput: ProtectedWindow[],
  facts: EventFact[],
  date: string,
  timeZone: string,
  workStart: number,
  deadline: number,
): { windows: ProtectedWindow[]; errors: string[] } {
  const errors: string[] = [];
  if (windowsInput.length > MAX_PROTECTED_WINDOWS) {
    return { windows: [], errors: ["There are too many protected event windows to schedule safely."] };
  }
  const factById = new Map(facts.map((fact) => [fact.id, fact]));
  const ids = new Set<string>();
  const windows = windowsInput.map((window) => {
    if (!window || typeof window !== "object") {
      errors.push("A protected window has an invalid shape.");
      return undefined;
    }
    const id = cleanId(window.id);
    const start = parseExplicitInstant(window.startAt);
    const end = parseExplicitInstant(window.endAt);
    const sourceFactIds = Array.isArray(window.sourceFactIds) ? window.sourceFactIds : [];
    const sourceFacts = sourceFactIds.map((sourceId) => factById.get(sourceId)).filter((fact): fact is EventFact => Boolean(fact));
    const sourceKeys = new Set(sourceFacts.map((fact) => fact.key));
    const supportedKind = ["record", "review", "submit", "other"].includes(window.kind);
    const relevantSource = window.kind === "record" || window.kind === "review"
      ? sourceKeys.has("deliverableRule") || sourceKeys.has("videoDuration")
      : window.kind === "submit"
        ? sourceKeys.has("submissionDeadline") || sourceKeys.has("deliverableRule")
        : sourceFacts.length > 0;

    if (!id || ids.has(id)) errors.push("Protected-window IDs must be present and unique.");
    if (!supportedKind || !relevantSource || sourceFacts.length !== sourceFactIds.length || sourceFacts.length === 0) {
      errors.push("Each protected window must have a confirmed, relevant source fact.");
    }
    if (start === undefined || end === undefined || end <= start) {
      errors.push("A protected window has an invalid time range.");
      return undefined;
    }
    if (start < workStart || end > deadline || dateAt(start, timeZone) !== date || dateAt(end, timeZone) !== date) {
      errors.push(`Protected window “${cleanText(window.label, 100) || id}” falls outside the confirmed event work period.`);
    }
    ids.add(id);
    return {
      id,
      label: cleanText(window.label, 120) || "Protected event work",
      kind: window.kind,
      startAt: new Date(start).toISOString(),
      endAt: new Date(end).toISOString(),
      sourceFactIds: [...sourceFactIds],
    } as ProtectedWindow;
  }).filter((window): window is ProtectedWindow => Boolean(window));

  const ordered = [...windows].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  for (let index = 1; index < ordered.length; index += 1) {
    if (Date.parse(ordered[index].startAt) < Date.parse(ordered[index - 1].endAt)) {
      errors.push("Confirmed protected event windows overlap; resolve the source timing before planning.");
      break;
    }
  }
  return { windows: ordered, errors };
}

function validateProposal(proposal?: AIPlanProposal): {
  tasks?: AIPlanTask[];
  missing: string[];
  errors: string[];
} {
  if (!proposal || !Array.isArray(proposal.tasks) || proposal.tasks.length === 0) {
    return { missing: ["Generate a validated task proposal before scheduling."], errors: [] };
  }
  if (proposal.tasks.length > MAX_PROPOSAL_TASKS) {
    return { missing: [], errors: [`The task proposal exceeds the ${MAX_PROPOSAL_TASKS}-task limit.`] };
  }

  const errors: string[] = [];
  const ids = new Set<string>();
  const tasks: AIPlanTask[] = [];
  for (const task of proposal.tasks) {
    if (!task || typeof task !== "object") {
      errors.push("A proposed task has an invalid shape.");
      continue;
    }
    const id = cleanId(task.id);
    if (!id || ids.has(id)) errors.push("Proposed task IDs must be present and unique.");
    else ids.add(id);
    if (!["build", "integrate", "verify"].includes(task.category)) errors.push("Proposed tasks may only use build, integrate, or verify categories.");
    if (!Number.isInteger(task.durationMinutes) || task.durationMinutes < MIN_TASK_MINUTES || task.durationMinutes > MAX_TASK_MINUTES) {
      errors.push(`Task “${cleanText(task.title, 100) || id}” has an invalid duration.`);
    }
    if (!Number.isInteger(task.priority) || task.priority < 1 || task.priority > proposal.tasks.length) {
      errors.push("Task priorities must be unique numbers from one through the task count.");
    }
    const dependencies = Array.isArray(task.dependsOn) ? task.dependsOn : [];
    const rawCapabilities = Array.isArray(task.requiredCapabilities) ? task.requiredCapabilities : [];
    const capabilities = rawCapabilities.filter((item): item is Capability => CAPABILITIES.includes(item));
    if (dependencies.length > MAX_PROPOSAL_TASKS || new Set(dependencies).size !== dependencies.length) {
      errors.push(`Task “${cleanText(task.title, 100) || id}” has invalid dependencies.`);
    }
    if (dependencies.some((dependency) => !cleanId(dependency))) {
      errors.push(`Task “${cleanText(task.title, 100) || id}” has an invalid dependency ID.`);
    }
    if (rawCapabilities.some((capability) => !CAPABILITIES.includes(capability as Capability))) {
      errors.push(`Task “${cleanText(task.title, 100) || id}” has an unsupported required capability.`);
    }
    const title = cleanText(task.title, 120);
    const acceptance = cleanText(task.acceptance, 300);
    if (!title || !acceptance) errors.push(`Task ${id || "with no ID"} needs a title and acceptance condition.`);
    tasks.push({
      id: id || `invalid-${tasks.length + 1}`,
      title: title || "Untitled proposed task",
      category: ["build", "integrate", "verify"].includes(task.category) ? task.category : "verify",
      durationMinutes: Number.isInteger(task.durationMinutes) ? task.durationMinutes : MIN_TASK_MINUTES,
      dependsOn: dependencies.map(cleanId).filter(Boolean),
      requiredCapabilities: [...new Set(capabilities)],
      priority: Number.isInteger(task.priority) ? task.priority : tasks.length + 1,
      rationale: cleanText(task.rationale, 300),
      acceptance,
    });
  }

  if (new Set(tasks.map((task) => task.priority)).size !== tasks.length) {
    errors.push("Task priorities must be unique.");
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    if (task.dependsOn.includes(task.id) || task.dependsOn.some((id) => !byId.has(id))) {
      errors.push(`Task “${task.title}” references an invalid dependency.`);
    }
    if (task.dependsOn.some((id) => (byId.get(id)?.priority ?? Number.POSITIVE_INFINITY) >= task.priority)) {
      errors.push(`Task “${task.title}” depends on work with an equal or lower priority.`);
    }
  }

  if (errors.length > 0) return { missing: [], errors: [...new Set(errors)] };
  return { tasks, missing: [], errors: [] };
}

function topologicalOrder(tasks: AIPlanTask[]): AIPlanTask[] | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const output: AIPlanTask[] = [];

  function visit(id: string): boolean {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    const task = byId.get(id);
    if (!task) return false;
    visiting.add(id);
    for (const dependency of task.dependsOn) if (!visit(dependency)) return false;
    visiting.delete(id);
    visited.add(id);
    output.push(task);
    return true;
  }

  for (const task of [...tasks].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))) {
    if (!visit(task.id)) return undefined;
  }
  return output;
}

function requiredUnwindowedDeliverableTasks(
  tasks: AIPlanTask[],
  windows: ProtectedWindow[],
  facts: EventFact[],
): string[] {
  const confirmed = facts.filter((fact) => fact?.status === "confirmed");
  const fixedKinds = new Set(windows.map((window) => window.kind));
  const searchable = (task: AIPlanTask) => `${task.title} ${task.rationale} ${task.acceptance}`.toLowerCase();
  const verifyTasks = tasks.filter((task) => task.category === "verify");
  const missing: string[] = [];
  const hasVideoRequirement = confirmed.some((fact) =>
    (fact.key === "videoDuration" && /\b\d+\s*(?:minutes?|mins?|seconds?|secs?)\b/i.test(fact.value)) ||
    (fact.key === "deliverableRule" && /\bvideo\b/i.test(fact.value)),
  );
  const hasDemoRequirement = confirmed.some((fact) =>
    fact.key === "demoStart" || (fact.key === "deliverableRule" && /\b(?:working|cool)?\s*demo\b/i.test(fact.value)),
  );
  const hasSubmissionRequirement = confirmed.some((fact) => fact.key === "submissionDeadline");

  if (hasVideoRequirement && !fixedKinds.has("record") && !verifyTasks.some((task) => /\b(?:record|video)\b/.test(searchable(task)))) {
    missing.push("Add a verify task for recording the required video, with an estimated duration.");
  }
  if (hasVideoRequirement && !fixedKinds.has("review") && !verifyTasks.some((task) => /\b(?:review|watch|playback|check).{0,30}\bvideo\b|\bvideo.{0,30}\b(?:review|watch|playback|check)\b/.test(searchable(task)))) {
    missing.push("Add a verify task for reviewing the required video, with an estimated duration.");
  }
  if (hasDemoRequirement && !fixedKinds.has("record") && !verifyTasks.some((task) => /\bdemo\b/.test(searchable(task)))) {
    missing.push("Add a verify task for preparing or checking the required demo.");
  }
  if (hasSubmissionRequirement && !fixedKinds.has("submit") && !verifyTasks.some((task) => /\b(?:submit|submission|upload|entry)\b/.test(searchable(task)))) {
    missing.push("Add a verify task for submitting and checking the entry, with an estimated duration.");
  }
  return missing;
}

function makeMembers(
  input: TeamMember[],
  bounds: EventBounds,
  assumptions: string[],
  reasons: string[],
): MemberState[] {
  const seen = new Set<string>();
  return input.map((member, index) => {
    const id = cleanId(member?.id) || undefined;
    const duplicateId = Boolean(id && seen.has(id));
    if (duplicateId) reasons.push(`Team member ${index + 1} has a duplicate ID and cannot receive tasks.`);
    if (id) seen.add(id);

    const rawCapabilities = Array.isArray(member?.capabilities) ? member.capabilities : [];
    const capabilities = new Set(rawCapabilities.filter((value): value is Capability => CAPABILITIES.includes(value)));
    const department = TEAM_DEPARTMENTS.includes(member?.department as TeamDepartment) ? member.department : undefined;
    const specialty = DEVELOPER_SPECIALTIES.includes(member?.specialty as DeveloperSpecialty) ? member.specialty : undefined;
    if (member?.department !== undefined && !department) {
      reasons.push(`Member ${index + 1} has an unsupported department profile.`);
    }
    if (member?.specialty !== undefined && (!specialty || department !== "developer")) {
      reasons.push(`Member ${index + 1} has a developer specialty that does not match its department.`);
    }
    if (department) {
      const mapped = department === "developer" && specialty
        ? DEVELOPER_CAPABILITIES[specialty]
        : DEPARTMENT_CAPABILITIES[department];
      mapped.forEach((capability) => capabilities.add(capability));
    }
    const effectiveCapabilities = [...capabilities];
    const hasCapabilityInput = effectiveCapabilities.length > 0;
    if (!hasCapabilityInput) assumptions.push(`Member ${index + 1} has no capability profile; ownership may be provisional.`);

    const rawFrom = cleanText(member?.availableFrom, 60);
    const rawUntil = cleanText(member?.availableUntil, 60);
    const parsedFrom = rawFrom ? parseLocalOrZonedInstant(rawFrom, bounds) : bounds.start;
    const parsedUntil = rawUntil ? parseLocalOrZonedInstant(rawUntil, bounds) : bounds.deadline;
    let eligible = !duplicateId;
    let availableFrom = parsedFrom ?? bounds.start;
    let availableUntil = parsedUntil ?? bounds.deadline;
    if ((rawFrom && parsedFrom === undefined) || (rawUntil && parsedUntil === undefined) || availableUntil <= availableFrom) {
      eligible = false;
      availableFrom = bounds.start;
      availableUntil = bounds.start;
      assumptions.push(`Member ${index + 1} has invalid availability and will not receive scheduled work.`);
    } else {
      availableFrom = Math.max(bounds.start, availableFrom);
      availableUntil = Math.min(bounds.deadline, availableUntil);
      if (!rawFrom || !rawUntil) {
        assumptions.push(`Member ${index + 1} has partial availability; missing bounds use the confirmed event start or deadline.`);
      }
    }
    if (!id) assumptions.push(`Member ${index + 1} has no stable ID; the schedule will leave the owner assignment provisional.`);

    return {
      ...(id ? { id } : {}),
      index,
      capabilities: effectiveCapabilities,
      hasCapabilityInput,
      availableFrom,
      availableUntil,
      bookings: [],
      scheduledLoad: 0,
      eligible,
    };
  });
}

function reserveProtectedWindows(
  bounds: EventBounds,
  members: MemberState[],
  breakWindow: Interval | undefined,
  assumptions: string[],
  reasons: string[],
): Map<string, MemberState | undefined> {
  const assignments = new Map<string, MemberState | undefined>();
  const fixed = bounds.windows.map((window) => ({
    window,
    start: Date.parse(window.startAt),
    end: Date.parse(window.endAt),
    capabilities: protectedCapabilities(window.kind),
  }));

  for (const item of fixed) {
    if (breakWindow && overlaps(item.start, item.end, breakWindow.start, breakWindow.end)) {
      reasons.push(`Protected ${item.window.kind} window “${item.window.label}” overlaps the confirmed team break.`);
      assignments.set(item.window.id, undefined);
      continue;
    }
    const candidates = sortMembers(members, item.capabilities);
    const available = candidates.find((member) => member.eligible && member.availableFrom <= item.start && member.availableUntil >= item.end);
    if (available) {
      reserve(available, item.start, item.end, protectedTaskId(item.window));
      assignments.set(item.window.id, available);
      if (isProvisionalMatch(available, item.capabilities)) {
        assumptions.push(`Owner for protected “${item.window.label}” is provisional because no confirmed capability match is available.`);
      }
    } else {
      reasons.push(`No team member is available for the protected ${item.window.kind} window “${item.window.label}”.`);
      assignments.set(item.window.id, undefined);
    }
  }
  return assignments;
}

function makeProtectedTask(
  window: ProtectedWindow,
  assignedMember: MemberState | undefined,
  now: number,
  reasons: string[],
  assumptions: string[],
): PlannedTask {
  const start = Date.parse(window.startAt);
  const end = Date.parse(window.endAt);
  const chosen = assignedMember;
  const elapsed = start < now;
  const blocked = !chosen || elapsed;
  if (blocked && !reasons.some((reason) => reason.includes(`protected ${window.kind} window “${window.label}”`))) {
    reasons.push(elapsed
      ? `Protected ${window.kind} window “${window.label}” has started or passed; its full work can no longer be scheduled.`
      : `Protected ${window.kind} work “${window.label}” has no available owner.`);
  }
  const provisional = Boolean(chosen && isProvisionalMatch(chosen, protectedCapabilities(window.kind))) || !chosen;
  if (provisional && !blocked) assumptions.push(`Owner for protected “${window.label}” is provisional.`);

  return {
    id: protectedTaskId(window),
    title: window.label,
    category: window.kind,
    ...(chosen?.id ? { ownerId: chosen.id } : {}),
    durationMinutes: Math.round((end - start) / MINUTE_MS),
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    dependsOn: [],
    acceptance: blocked
      ? `BLOCKED — ${elapsed ? "This protected window has started or passed." : "Confirm an available owner."} Its full source-confirmed window remains unchanged.`
      : `Complete the full source-protected ${window.kind} work from its confirmed event window.`,
    state: blocked ? "blocked" : "todo",
    protectedWindowKind: window.kind,
    ...(provisional ? { provisionalOwner: true } : {}),
  };
}

function scheduleProposedTask(
  task: AIPlanTask,
  members: MemberState[],
  constraints: { earliest: number; deadline: number; protected: Interval[]; breakWindow?: Interval },
): { member: MemberState; start: number; end: number; provisional: boolean } | undefined {
  const ordered = sortMembers(members, task.requiredCapabilities);
  for (const member of ordered) {
    if (!member.eligible) continue;
    const slot = findSlot(member, task.durationMinutes, constraints);
    if (slot) {
      return { member, ...slot, provisional: isProvisionalMatch(member, task.requiredCapabilities) || !member.id };
    }
  }
  return undefined;
}

function sortMembers(members: MemberState[], required: Capability[]): MemberState[] {
  return [...members].sort((a, b) => {
    const scoreA = required.filter((item) => a.capabilities.includes(item)).length;
    const scoreB = required.filter((item) => b.capabilities.includes(item)).length;
    const completeA = required.length > 0 && scoreA === required.length ? 1 : 0;
    const completeB = required.length > 0 && scoreB === required.length ? 1 : 0;
    return completeB - completeA || scoreB - scoreA || a.scheduledLoad - b.scheduledLoad || a.index - b.index;
  });
}

function isProvisionalMatch(member: MemberState, required: Capability[]): boolean {
  if (!member.id || !member.hasCapabilityInput) return true;
  return required.length > 0 && !required.every((capability) => member.capabilities.includes(capability));
}

function findSlot(
  member: MemberState,
  durationMinutes: number,
  constraints: { earliest: number; deadline: number; protected: Interval[]; breakWindow?: Interval },
): { start: number; end: number } | undefined {
  let cursor = Math.max(constraints.earliest, member.availableFrom);
  const limit = Math.min(constraints.deadline, member.availableUntil);
  const duration = durationMinutes * MINUTE_MS;

  while (cursor + duration <= limit) {
    const end = cursor + duration;
    const conflicts = [
      ...member.bookings,
      ...constraints.protected,
      ...(constraints.breakWindow ? [constraints.breakWindow] : []),
    ].filter((item) => overlaps(cursor, end, item.start, item.end));
    if (conflicts.length === 0) return { start: cursor, end };
    cursor = Math.max(...conflicts.map((item) => item.end));
  }
  return undefined;
}

function reserve(member: MemberState, start: number, end: number, taskId: string): void {
  member.bookings.push({ start, end, taskId });
  member.bookings.sort((a, b) => a.start - b.start || a.end - b.end);
  member.scheduledLoad += (end - start) / MINUTE_MS;
}

function parseBreak(survey: TeamSurvey, bounds: EventBounds): { interval?: Interval; error?: string } {
  const rawStart = cleanText(survey?.breakStart, 60);
  const rawEnd = cleanText(survey?.breakEnd, 60);
  if (!rawStart && !rawEnd) return {};
  if (!rawStart || !rawEnd) return { error: "Enter both ends of the team break, or clear both fields." };
  const start = parseLocalOrZonedInstant(rawStart, bounds);
  const end = parseLocalOrZonedInstant(rawEnd, bounds);
  if (start === undefined || end === undefined || end <= start) {
    return { error: "Use a valid chronological start and end for the team break." };
  }
  if (start < bounds.start || end > bounds.deadline || dateAt(start, bounds.timeZone) !== bounds.date || dateAt(end, bounds.timeZone) !== bounds.date) {
    return { error: "The team break must fit within the confirmed event work period." };
  }
  return { interval: { start, end } };
}

function blockedTask(task: AIPlanTask, marker: number, reason: string): PlannedTask {
  const time = new Date(marker).toISOString();
  return {
    id: task.id,
    title: task.title,
    category: task.category,
    durationMinutes: task.durationMinutes,
    startsAt: time,
    endsAt: time,
    dependsOn: [...task.dependsOn],
    acceptance: `BLOCKED — ${reason} Required duration remains ${task.durationMinutes} minutes.`,
    state: "blocked",
  };
}

function buildCuts(tasks: PlannedTask[], bounds: EventBounds): string[] {
  const cuts = ["Defer optional polish and secondary scope before cutting a confirmed deliverable or shrinking a protected window."];
  const blocked = tasks.filter((task) => task.state === "blocked");
  if (blocked.some((task) => task.category === "build" || task.category === "integrate")) {
    cuts.push("Use an already-working slice if available; otherwise report the core build as infeasible instead of shortening required work.");
  }
  if (blocked.some((task) => task.protectedWindowKind === "record" || task.protectedWindowKind === "review" || task.protectedWindowKind === "submit")) {
    cuts.push("Reassign the protected deliverable work or report it blocked; its confirmed time window stays unchanged.");
  }
  if (bounds.windows.length > 0) {
    cuts.push("All source-confirmed record, review, submission, and other protected windows remain fixed.");
  }
  if (blocked.length === 0) cuts.push("All proposed work fits around the confirmed availability, break, and protected windows.");
  return cuts;
}

function emptyPlan(
  generatedAt: string,
  assumptions: string[],
  errors: string[],
  missing: string[],
  deadline = "",
): SprintPlan {
  const uniqueMissing = [...new Set(missing)];
  const uniqueErrors = [...new Set(errors)];
  return {
    generatedAt,
    deadline,
    tasks: [],
    assumptions,
    cuts: ["Resolve the listed scheduling requirements before generating a timeline."],
    feasible: false,
    ...(uniqueErrors.length > 0
      ? { infeasibility: uniqueErrors.join(" ") }
      : uniqueMissing.length > 0
        ? { infeasibility: uniqueMissing.join(" ") }
        : {}),
    ...(uniqueMissing.length > 0 ? { missingRequirements: uniqueMissing } : {}),
  };
}

function protectedTaskId(window: ProtectedWindow): string {
  return `protected-${window.id}`;
}

function protectedCapabilities(kind: ProtectedWindow["kind"]): Capability[] {
  if (kind === "record") return ["demo", "product", "design"];
  if (kind === "review") return ["demo", "testing", "product"];
  if (kind === "submit") return ["demo", "product", "testing"];
  return [];
}

function normalizeFactDate(value: string): string | undefined {
  const raw = cleanText(value, 100);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return normalizeIsoDate(raw);
  const monthNames: Record<string, string> = {
    jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03",
    apr: "04", april: "04", may: "05", jun: "06", june: "06", jul: "07", july: "07",
    aug: "08", august: "08", sep: "09", sept: "09", september: "09", oct: "10", october: "10",
    nov: "11", november: "11", dec: "12", december: "12",
  };
  let match = raw.match(/\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/);
  if (match) {
    const month = monthNames[match[2].toLowerCase()];
    return month ? validIsoDate(`${match[3]}-${month}-${match[1].padStart(2, "0")}`) : undefined;
  }
  match = raw.match(/\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (match) {
    const month = monthNames[match[1].toLowerCase()];
    return month ? validIsoDate(`${match[3]}-${month}-${match[2].padStart(2, "0")}`) : undefined;
  }
  return undefined;
}

function extractClock(value: string): string | undefined {
  const raw = cleanText(value, 200);
  const iso = raw.match(/T(\d{2}:\d{2})(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i);
  if (iso) return iso[1];
  const clock = raw.match(/\b(noon|midnight|(?:2[0-3]|[01]?\d)[:.][0-5]\d|(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*[ap]\.?m\.?)\b/i);
  if (!clock) return undefined;
  const token = clock[1].toLowerCase().replace(/\s+/g, "").replace(/\./g, ":").replace(/a:m:?$/, "am").replace(/p:m:?$/, "pm");
  if (token === "noon") return "12:00";
  if (token === "midnight") return "00:00";
  const twelve = token.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (twelve) {
    const hour = (Number(twelve[1]) % 12) + (twelve[3] === "pm" ? 12 : 0);
    return `${String(hour).padStart(2, "0")}:${twelve[2] ?? "00"}`;
  }
  const twentyFour = token.match(/^(\d{1,2})[:.](\d{2})$/);
  if (!twentyFour) return undefined;
  const hour = Number(twentyFour[1]);
  const minute = Number(twentyFour[2]);
  return hour <= 23 && minute <= 59 ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : undefined;
}

function normalizeZone(value: string): string | undefined {
  const zone = cleanText(value, 80);
  if (!zone) return undefined;
  if (/^(?:CET|CEST)$/i.test(zone)) return "Europe/Berlin";
  try {
    return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function localDateTimeToInstant(date: string, time: string | undefined, timeZone: string): number | undefined {
  if (!time) return undefined;
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  let candidate = Date.UTC(year, month - 1, day, hour, minute);
  for (let index = 0; index < 4; index += 1) {
    const parts = localParts(candidate, timeZone);
    if (!parts) return undefined;
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const desiredUtc = Date.UTC(year, month - 1, day, hour, minute);
    const correction = desiredUtc - asUtc;
    if (correction === 0) break;
    candidate += correction;
  }
  const result = localParts(candidate, timeZone);
  if (!result || result.year !== year || result.month !== month || result.day !== day || result.hour !== hour || result.minute !== minute) return undefined;
  return candidate;
}

function parseLocalOrZonedInstant(value: string, bounds: EventBounds): number | undefined {
  const text = cleanText(value, 80);
  const explicit = parseExplicitInstant(text);
  if (explicit !== undefined) return explicit;
  const local = text.match(/^(?:(\d{4}-\d{2}-\d{2})[T ]?)?(\d{1,2}[:.][0-5]\d(?:\s*(?:am|pm))?)$/i);
  if (!local) return undefined;
  const date = local[1] ? normalizeIsoDate(local[1]) : bounds.date;
  if (!date) return undefined;
  return localDateTimeToInstant(date, extractClock(local[2]), bounds.timeZone);
}

function parseExplicitInstant(value: string | undefined): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return undefined;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : undefined;
}

function dateAt(instant: number, timeZone: string): string | undefined {
  const parts = localParts(instant, timeZone);
  return parts ? `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}` : undefined;
}

function localParts(instant: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: Number(values.hour),
      minute: Number(values.minute),
    };
  } catch {
    return undefined;
  }
}

function formatAt(instant: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(instant));
  } catch {
    return new Date(instant).toISOString();
  }
}

function normalizeIsoDate(value: string): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? validIsoDate(value) : undefined;
}

function validIsoDate(value: string): string | undefined {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined;
}

function uniqueValues(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function validDate(date: Date): boolean {
  return date instanceof Date && Number.isFinite(date.getTime());
}

function cleanId(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(value) ? value : "";
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email removed]")
    .replace(/https?:\/\/[^\s<>"']+/gi, "[link removed]")
    .replace(/\b(password|passcode|api\s*key|secret|access\s*token)\s*[:=]\s*[^\s,;]+/gi, "$1 [removed]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA;
}
