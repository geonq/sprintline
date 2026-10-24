import { useEffect, useState } from "react";
import { CAPABILITIES } from "./domain/types";
import type {
  AIPlanProposal,
  DeveloperSpecialty,
  EventFact,
  EventSource,
  EventScheduleContext,
  SprintlineState,
  TaskState,
  TeamDepartment,
  TeamMember,
  TeamSurvey as TeamSurveyData,
} from "./domain/types";
import { createSprintPlan } from "./domain/create-plan";
import { parsePastedInstructions } from "./domain/parse-facts";
import BackgroundIntake, { type ManualScheduleFactInput } from "./components/BackgroundIntake";
import ConnectAccount from "./components/ConnectAccount";
import ProjectPrompt from "./components/ProjectPrompt";
import type { PlanningModelOption, ProjectIdea } from "./components/ProjectPrompt";
import TeamSurvey, { roleCapabilities } from "./components/TeamSurvey";
import Workspace from "./components/Workspace";
import type { ChatGPTOAuthState } from "./components/ConnectAccount";
import type { ProjectPromptSubmission } from "./components/ProjectPrompt";
import type { TaskPriority } from "./components/Workspace";
import { loadPlanPriorities, loadSprintlineState, savePlanPriorities, saveSprintlineState } from "./state/persistence";

const API_BASE = "http://127.0.0.1:1455";
type Screen = "connect" | "event" | "team" | "prompt" | "workspace";
type ModelOption = PlanningModelOption;

interface AuthStatusPayload {
  connected: boolean;
  planUsageEnabled: boolean;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
    cache: "no-store",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const nested = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
    const code = nested && typeof nested.code === "string"
      ? nested.code
      : isRecord(payload) && typeof payload.error === "string" ? payload.error : undefined;
    const message = nested && typeof nested.message === "string"
      ? nested.message
      : isRecord(payload) && typeof payload.message === "string" ? payload.message : `Request failed (${response.status}).`;
    throw new ApiRequestError(message, response.status, code);
  }
  return payload;
}

class ApiRequestError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

function friendlyLocalError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof TypeError) {
    return "The browser could not reach the local sign-in service. Open http://127.0.0.1:1455/ and retry the connection. The deployed preview cannot connect to this local account service.";
  }
  return "Sprintline could not verify the sign-in response. Refresh the page and try again.";
}

function authStatusErrorMessage(error?: string): string {
  switch (error) {
    case "oauth_access_denied":
      return "ChatGPT sign-in was declined. Try again when you’re ready.";
    case "plan_access_not_granted":
      return "ChatGPT plan access is not enabled. Continue with ChatGPT to update it.";
    case "reauthorization_required":
      return "Your ChatGPT connection needs renewal. Continue with ChatGPT to reconnect.";
    case "oauth_failed":
    case "oauth_state_invalid":
    case "oauth_exchange_failed":
    case "oauth_identity_invalid":
      return "ChatGPT sign-in could not be confirmed. Try again.";
    default:
      return "";
  }
}

function parseProjectIdeas(value: unknown): ProjectIdea[] {
  if (!isRecord(value) || !Array.isArray(value.ideas) || value.ideas.length !== 5) {
    throw new Error("The idea service did not return exactly five options.");
  }
  const ideas = value.ideas.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.title !== "string" || !item.title.trim() || item.title.length > 140 ||
      typeof item.description !== "string" || !item.description.trim() || item.description.length > 1200 ||
      typeof item.teamFit !== "string" || !item.teamFit.trim() || item.teamFit.length > 600 ||
      typeof item.demonstration !== "string" || !item.demonstration.trim() || item.demonstration.length > 600
    ) {
      throw new Error(`The idea service returned an invalid option (${index + 1}).`);
    }
    return {
      id: `idea-${index + 1}`,
      title: item.title.trim(),
      description: item.description.trim(),
      teamFit: item.teamFit.trim(),
      demonstration: item.demonstration.trim(),
    };
  });
  if (new Set(ideas.map((idea) => idea.title.toLowerCase())).size !== 5) {
    throw new Error("The idea service returned duplicate options. Try again.");
  }
  return ideas;
}

function createFreshState(): SprintlineState {
  return {
    version: 1,
    sources: [],
    facts: [],
    survey: {
      members: [],
      projectName: "",
      projectStage: "idea",
      demoMode: "product",
      outcome: "",
      outcomeDoneWhen: "",
    },
    laterIdeas: [],
  };
}

function currentFact(facts: EventFact[], keys: EventFact["key"][]): EventFact | undefined {
  return facts.find((fact) => keys.includes(fact.key) && fact.status === "confirmed");
}

function hasConfirmedSchedule(facts: EventFact[]): boolean {
  return Boolean(
    currentFact(facts, ["eventDate"]) &&
    currentFact(facts, ["timeZone"]) &&
    currentFact(facts, ["agendaStart", "eventStart"]) &&
    currentFact(facts, ["submissionDeadline"]),
  );
}

function normalizeTime(value: string): string | undefined {
  const match = value.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : undefined;
}

function normalizeDate(value: string): string | undefined {
  const iso = value.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

function timezoneOffset(date: string, time: string, timeZone: string): string | undefined {
  const normalizedZone = /^(?:CET|CEST)$/i.test(timeZone) ? "Europe/Berlin" : timeZone;
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const clock = time.match(/^(\d{2}):(\d{2})$/);
  if (!match || !clock) return undefined;

  try {
    const [year, month, day, hour, minute] = [...match.slice(1), clock[1], clock[2]].map(Number);
    const wallTime = Date.UTC(year, month - 1, day, hour, minute);
    if (!Number.isFinite(wallTime) || hour > 23 || minute > 59 ||
      new Date(wallTime).toISOString().slice(0, 16) !== `${date}T${time}`) return undefined;
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: normalizedZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const findOffset = (instant: number) => {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
      const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
      return Math.round((asUtc - instant) / 60_000);
    };
    let offset = findOffset(wallTime);
    offset = findOffset(wallTime - offset * 60_000);
    const instant = wallTime - offset * 60_000;
    if (!Number.isInteger(offset) || Math.abs(offset) > 14 * 60 ||
      !Number.isFinite(instant) || findOffset(instant) !== offset) return undefined;
    const sign = offset >= 0 ? "+" : "-";
    const absolute = Math.abs(offset);
    return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  } catch {
    return undefined;
  }
}

function eventContext(facts: EventFact[]): EventScheduleContext | undefined {
  const dateFact = currentFact(facts, ["eventDate"]);
  const zoneFact = currentFact(facts, ["timeZone"]);
  const workFact = currentFact(facts, ["agendaStart", "eventStart"]);
  const deadlineFact = currentFact(facts, ["submissionDeadline"]);
  if (!dateFact || !zoneFact || !workFact || !deadlineFact) return undefined;

  const date = normalizeDate(dateFact.value);
  const workTime = normalizeTime(workFact.value);
  const deadlineTime = normalizeTime(deadlineFact.value);
  if (!date || !workTime || !deadlineTime) return undefined;
  const offset = timezoneOffset(date, workTime, zoneFact.value);
  const deadlineOffset = timezoneOffset(date, deadlineTime, zoneFact.value);
  if (!offset || !deadlineOffset) return undefined;

  const workStartAt = `${date}T${workTime}:00${offset}`;
  const deadlineAt = `${date}T${deadlineTime}:00${deadlineOffset}`;
  if (!Number.isFinite(Date.parse(workStartAt)) || !Number.isFinite(Date.parse(deadlineAt))) return undefined;

  return {
    date,
    timeZone: /^(?:CET|CEST)$/i.test(zoneFact.value) ? "Europe/Berlin" : zoneFact.value,
    workStartAt,
    deadlineAt,
    protectedWindows: [],
  };
}

function parseModels(value: unknown): ModelOption[] {
  if (!isRecord(value) || !Array.isArray(value.models)) return [];
  return value.models.flatMap((item): ModelOption[] =>
    isRecord(item) && typeof item.slug === "string" && typeof item.displayName === "string"
      ? [{ slug: item.slug, displayName: item.displayName }]
      : [],
  );
}

function parseProposal(value: unknown): AIPlanProposal {
  if (!isRecord(value) || typeof value.summary !== "string" || !Array.isArray(value.tasks)) {
    throw new Error("The planning service returned an unreadable proposal.");
  }
  const tasks = value.tasks.map((task, index) => {
    if (
      !isRecord(task) ||
      typeof task.id !== "string" ||
      typeof task.title !== "string" ||
      !["build", "integrate", "verify"].includes(String(task.category)) ||
      typeof task.durationMinutes !== "number" ||
      !Array.isArray(task.dependsOn) ||
      !Array.isArray(task.requiredCapabilities) ||
      typeof task.priority !== "number" ||
      typeof task.rationale !== "string" ||
      typeof task.acceptance !== "string"
    ) {
      throw new Error(`The planning service returned an invalid task (${index + 1}).`);
    }
    return {
      id: task.id,
      title: task.title,
      category: task.category as AIPlanProposal["tasks"][number]["category"],
      durationMinutes: task.durationMinutes,
      dependsOn: task.dependsOn.filter((dependency): dependency is string => typeof dependency === "string"),
      requiredCapabilities: task.requiredCapabilities.filter((capability): capability is (typeof CAPABILITIES)[number] =>
        typeof capability === "string" && CAPABILITIES.includes(capability as (typeof CAPABILITIES)[number]),
      ),
      priority: task.priority,
      rationale: task.rationale,
      acceptance: task.acceptance,
    };
  });
  return { summary: value.summary, tasks };
}

function priorityLabels(proposal: AIPlanProposal): Record<string, TaskPriority> {
  const ranked = [...proposal.tasks].sort((left, right) => left.priority - right.priority);
  const length = Math.max(1, ranked.length);
  return Object.fromEntries(ranked.map((task, index) => {
    const band = Math.min(3, Math.floor((index / length) * 4));
    return [task.id, `P${band}` as TaskPriority];
  }));
}

function App() {
  const [loadResult] = useState(() => loadSprintlineState());
  const [state, setState] = useState<SprintlineState>(() =>
    loadResult.status === "found" ? loadResult.state : createFreshState(),
  );
  const [screen, setScreen] = useState<Screen>("connect");
  const [authState, setAuthState] = useState<ChatGPTOAuthState>("idle");
  const [authMessage, setAuthMessage] = useState("");
  const [authRetry, setAuthRetry] = useState(0);
  const [selectedModel, setSelectedModel] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [recommendedModelSlug, setRecommendedModelSlug] = useState<string | null>(null);
  const [modelMessage, setModelMessage] = useState("");
  const [voiceMemo, setVoiceMemo] = useState<Blob | null>(null);
  const [priorityByTaskId, setPriorityByTaskId] = useState<Record<string, TaskPriority>>(() => loadPlanPriorities(state.plan));
  const [ideas, setIdeas] = useState<ProjectIdea[]>([]);
  const [isSuggestingIdeas, setIsSuggestingIdeas] = useState(false);
  const [ideaError, setIdeaError] = useState("");
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [notice, setNotice] = useState("");
  const [saveMessage, setSaveMessage] = useState<string>(loadResult.status === "invalid" ? loadResult.message : "");
  const [saveState, setSaveState] = useState<"saving" | "saved" | "error">(loadResult.status === "found" ? "saved" : "saving");

  function handleAuthFailure(error: unknown): boolean {
    if (!(error instanceof ApiRequestError) || !["auth_required", "reauthorization_required", "plan_access_not_granted"].includes(error.code ?? "")) {
      return false;
    }
    setAuthState("error");
    setAuthMessage(error.message);
    setSelectedModel("");
    setModels([]);
    setRecommendedModelSlug(null);
    setModelMessage(error.message);
    setScreen("connect");
    return true;
  }

  useEffect(() => {
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      const error = saveSprintlineState(state);
      if (error) {
        setSaveState("error");
        setSaveMessage(error);
      } else {
        setSaveState("saved");
        setSaveMessage("");
      }
    }, 220);
    return () => window.clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const payload = await requestJson("/api/auth/status");
        if (!isRecord(payload) || typeof payload.connected !== "boolean" || typeof payload.planUsageEnabled !== "boolean") {
          throw new Error("The local sign-in service returned an invalid status.");
        }
        if (!active) return;
        const status = payload as unknown as AuthStatusPayload;
        if (status.connected && status.planUsageEnabled) {
          setAuthState("connected");
          setAuthMessage("ChatGPT plan access is confirmed.");
          setScreen(state.plan ? "workspace"
            : hasConfirmedSchedule(state.facts) && eventContext(state.facts)
              ? state.survey.members.length > 0 && state.survey.members.every((member) => member.name?.trim() && member.department)
                ? "prompt" : "team"
              : "event");
          try {
            const modelPayload = await requestJson("/api/models");
            const discovered = parseModels(modelPayload);
            if (!active) return;
            const recommendedSlug = isRecord(modelPayload) && typeof modelPayload.recommendedModelSlug === "string"
              ? modelPayload.recommendedModelSlug
              : null;
            setModels(discovered);
            setRecommendedModelSlug(recommendedSlug);
            setSelectedModel(discovered.find((model) => model.slug === recommendedSlug)?.slug ?? discovered[0]?.slug ?? "");
            setModelMessage(recommendedSlug
              ? "The account-recommended model is selected. You can change it."
              : discovered.length > 0 ? "An available account model is selected. You can change it." : "No account-listed model is available.");
          } catch (error) {
            if (active && handleAuthFailure(error)) return;
            if (active) {
              setModelMessage(friendlyLocalError(error));
              setAuthMessage("Connected. Choose a listed model before creating a plan.");
            }
          }
        } else {
          setAuthState(payload.connected ? "error" : "idle");
          setAuthMessage(payload.connected
            ? "ChatGPT did not authorize plan access. Continue with ChatGPT to update it."
            : authStatusErrorMessage(status.error));
        }
      } catch (error) {
        if (!active) return;
        setAuthState("error");
        setAuthMessage(friendlyLocalError(error));
      }
    })();
    return () => { active = false; };
  }, [authRetry]);

  const factsConfirmed = hasConfirmedSchedule(state.facts);
  const teamSize = state.survey.members.length;
  const teamReady = teamSize >= 1 && teamSize <= 5 && state.survey.members.every((member) =>
    Boolean(member.name?.trim() && member.department),
  );
  const eventLabel = state.sources[0]?.label ?? "Event details not added";

  function updateSurvey(survey: TeamSurveyData) {
    setState((current) => ({ ...current, survey, plan: undefined, planAccepted: false }));
    setNotice("");
  }

  function updateTeamSize(size: number) {
    const members = Array.from({ length: Math.max(0, Math.min(5, size)) }, (_, index): TeamMember => {
      const existing = state.survey.members[index];
      return existing ?? {
        id: `builder-${index + 1}`,
        capabilities: [],
      };
    });
    updateSurvey({ ...state.survey, members });
  }

  function updateMemberName(memberId: string, name: string) {
    updateSurvey({
      ...state.survey,
      members: state.survey.members.map((member) => member.id === memberId ? { ...member, name } : member),
    });
  }

  function updateMemberRole(memberId: string, department: TeamDepartment | "", specialty: DeveloperSpecialty | "") {
    const normalizedDepartment = department || undefined;
    const normalizedSpecialty = department === "developer" ? specialty || undefined : undefined;
    const capabilities = roleCapabilities(normalizedDepartment, normalizedSpecialty);
    updateSurvey({
      ...state.survey,
      members: state.survey.members.map((member) => member.id === memberId
        ? { ...member, department: normalizedDepartment, specialty: normalizedSpecialty, capabilities }
        : member),
    });
  }

  async function addEventSource(input: string): Promise<boolean> {
    setNotice("");
    let text = input;
    let sourceLabel = "Pasted event instructions";
    const possibleUrl = input.trim();
    try {
      const url = new URL(possibleUrl);
      if (url.protocol !== "https:" || /\s/.test(possibleUrl)) {
        setNotice("Use an HTTPS event link or paste the event instructions.");
        return false;
      }
      const extracted = await requestJson("/api/sources/extract", {
        method: "POST",
        body: JSON.stringify({ url: url.toString() }),
      });
      if (!isRecord(extracted) || typeof extracted.text !== "string") {
        throw new Error("The event page did not return readable text. Paste its schedule instead.");
      }
      text = extracted.text;
      sourceLabel = typeof extracted.title === "string" && extracted.title.trim()
        ? `Event page: ${extracted.title.trim().slice(0, 80)}`
        : `Event page: ${url.hostname}`;
    } catch (error) {
      if (error instanceof TypeError) {
        // Ordinary pasted wording is parsed locally and is never sent to the model service.
      } else {
        setNotice(error instanceof Error ? error.message : "The event page could not be read.");
        return false;
      }
    }

    if (text.length > 12_000) text = text.slice(0, 12_000);
    const parsed = parsePastedInstructions(text, sourceLabel);
    if (parsed.facts.length === 0) {
      setNotice("No schedule facts were found. Paste the event date, start, time zone, and submission cutoff.");
      return false;
    }
    const source = {
      ...parsed.source,
      kind: sourceLabel.startsWith("Event page:") ? "event-page" as const : parsed.source.kind,
      note: sourceLabel.startsWith("Event page:")
        ? "Public event page extracted locally for fact review. The page text is not retained or sent to the plan model."
        : parsed.source.note,
    };
    if (state.sources.some((item) => item.id === source.id)) {
      setNotice("That source is already in the plan.");
      return false;
    }
    setState((current) => ({
      ...current,
      sources: [...current.sources, source].slice(0, 30),
      facts: [...current.facts, ...parsed.facts].slice(0, 120),
      plan: undefined,
      planAccepted: false,
    }));
    setNotice(`${parsed.facts.length} schedule details are ready to review.`);
    return true;
  }

  function confirmFacts(selectedFactIds: string[], manualInputs: ManualScheduleFactInput[]) {
    const selectedIds = new Set(selectedFactIds);
    const selectedKeys = new Set(state.facts.filter((fact) => selectedIds.has(fact.id)).map((fact) => fact.key));
    const selectedWorkStart = state.facts.find((fact) => selectedIds.has(fact.id) && (fact.key === "eventStart" || fact.key === "agendaStart"));
    const manualKeys = new Set<import("./domain/types").FactKey>(manualInputs.map((fact) => fact.key));
    const manualWorkStart = manualKeys.has("eventStart");
    const manualSourceId = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const manualSource: EventSource | undefined = manualInputs.length > 0 ? {
      id: manualSourceId,
      label: "Entered by team",
      kind: "organizer-message",
      observedAt: new Date().toISOString(),
      note: "Schedule values entered by the team; not extracted from an event source.",
    } : undefined;
    const manualLabels: Record<ManualScheduleFactInput["key"], string> = {
      eventDate: "Event date",
      timeZone: "Time zone",
      eventStart: "Start time",
      submissionDeadline: "Submission cutoff",
    };
    const confirmedManualFacts: EventFact[] = manualInputs.map((fact) => ({
      id: `${manualSource?.id ?? "m"}-${fact.key}`,
      key: fact.key,
      label: manualLabels[fact.key],
      value: fact.value,
      detail: "Entered manually by the team.",
      sourceId: manualSource?.id ?? "manual",
      status: "confirmed",
    }));
    const selectedFacts = state.facts.map((fact) => {
      if (selectedIds.has(fact.id)) return { ...fact, status: "confirmed" as const };
      const isWorkStart = fact.key === "eventStart" || fact.key === "agendaStart";
      const replacedWorkStart = isWorkStart && (manualWorkStart || Boolean(selectedWorkStart && selectedWorkStart.key !== fact.key));
      return selectedKeys.has(fact.key) || manualKeys.has(fact.key) || replacedWorkStart
        ? { ...fact, status: "superseded" as const }
        : fact;
    });
    const nextFacts = [...selectedFacts, ...confirmedManualFacts].slice(-120);
    setState((current) => ({
      ...current,
      sources: manualSource ? [...current.sources, manualSource].slice(-30) : current.sources,
      facts: nextFacts,
      plan: undefined,
      planAccepted: false,
    }));
    if (hasConfirmedSchedule(nextFacts) && eventContext(nextFacts)) {
      setNotice("");
      setScreen("team");
    } else {
      setNotice("Enter a valid date, time zone, start and cutoff.");
    }
  }

  async function startChatGPTOAuth() {
    setAuthState("starting");
    setAuthMessage("Opening ChatGPT sign-in…");
    try {
      const payload = await requestJson("/api/auth/start", { method: "POST", body: "{}" });
      if (!isRecord(payload) || typeof payload.authorizationUrl !== "string") {
        throw new Error("The sign-in service did not return an authorization URL.");
      }
      const authorizationUrl = new URL(payload.authorizationUrl);
      if (authorizationUrl.protocol !== "https:") throw new Error("The authorization URL is not secure.");
      setAuthState("awaiting-return");
      window.location.assign(authorizationUrl.toString());
    } catch (error) {
      setAuthState("error");
      setAuthMessage(friendlyLocalError(error));
    }
  }

  async function disconnectAccount() {
    setIsDisconnecting(true);
    try {
      const payload = await requestJson("/api/auth/disconnect", { method: "POST", body: "{}" });
      if (!isRecord(payload) || payload.disconnected !== true || typeof payload.revocationConfirmed !== "boolean") {
        throw new Error("The sign-in service returned an invalid disconnect status.");
      }
      setAuthState("idle");
      setSelectedModel("");
      setModels([]);
      setRecommendedModelSlug(null);
      setAuthMessage(payload.revocationConfirmed
        ? "ChatGPT was disconnected."
        : "This browser connection was removed; provider revocation could not be confirmed.");
      setNotice("");
      setScreen("connect");
    } catch (error) {
      if (!handleAuthFailure(error)) setNotice(friendlyLocalError(error));
    } finally {
      setIsDisconnecting(false);
    }
  }

  async function suggestProjects() {
    setIdeaError("");
    setIdeas([]);
    if (!factsConfirmed) {
      setScreen("event");
      setIdeaError("Confirm the event schedule first.");
      return;
    }
    if (!teamReady) {
      setScreen("team");
      setIdeaError("Finish the team names and roles first.");
      return;
    }
    setIsSuggestingIdeas(true);
    try {
      const confirmedFacts = state.facts
        .filter((fact) => fact.status === "confirmed")
        .map(({ id, key, value, status }) => ({ id, key, value, status }));
      const teamMembers = state.survey.members.map((member) => ({
        id: member.id,
        department: member.department,
        specialty: member.specialty,
        capabilities: member.capabilities,
      }));
      const payload = await requestJson("/api/ideas", {
        method: "POST",
        body: JSON.stringify({
          event: { confirmedFacts },
          project: state.survey.outcome.trim() ? { brief: state.survey.outcome.trim() } : {},
          team: { members: teamMembers },
        }),
      });
      setIdeas(parseProjectIdeas(payload));
    } catch (error) {
      if (!handleAuthFailure(error)) {
        setIdeaError(error instanceof Error ? error.message : "Project ideas could not be suggested. Try again.");
      }
    } finally {
      setIsSuggestingIdeas(false);
    }
  }

  async function generatePlan(submission: ProjectPromptSubmission) {
    if (teamSize < 1 || teamSize > 5) {
      setNotice("Choose a team size from one to five people.");
      setScreen("team");
      return;
    }
    if (!teamReady) {
      setNotice("Add each teammate’s name and department.");
      setScreen("team");
      return;
    }
    const event = eventContext(state.facts);
    if (!event || !factsConfirmed) {
      setNotice("The confirmed event schedule is missing a date, time zone, work start, or cutoff.");
      setScreen("event");
      return;
    }
    if (!selectedModel || !models.some((model) => model.slug === selectedModel)) {
      setNotice("Choose a model listed for this ChatGPT account.");
      return;
    }

    setIsGenerating(true);
    setNotice("");
    try {
      const confirmedFacts = state.facts
        .filter((fact) => fact.status === "confirmed")
        .map(({ id, key, value, status }) => ({ id, key, value, status }));
      const planPayload = {
        model: selectedModel,
        event: {
          date: event.date,
          timeZone: event.timeZone,
          workStart: event.workStartAt,
          deadlineAt: event.deadlineAt,
          confirmedFacts,
          protectedWindows: event.protectedWindows,
        },
        project: {
          name: submission.survey.projectName.trim() || "Sprint project",
          brief: submission.projectDescription,
          stage: submission.survey.projectStage,
          demoMode: submission.survey.demoMode,
          outcome: submission.survey.outcome,
          doneWhen: submission.survey.outcomeDoneWhen,
        },
        team: {
          members: submission.survey.members.map((member) => ({
            id: member.id,
            department: member.department,
            specialty: member.specialty,
            capabilities: member.capabilities,
          })),
        },
      };
      const rawProposal = await requestJson("/api/plan", {
        method: "POST",
        body: JSON.stringify(planPayload),
      });
      const proposal = parseProposal(rawProposal);
      const plan = createSprintPlan(submission.survey, state.facts, event, proposal);
      const priorities = priorityLabels(proposal);
      setState((current) => ({ ...current, survey: submission.survey, plan, planAccepted: true }));
      setPriorityByTaskId(priorities);
      const prioritySaveError = savePlanPriorities(plan, priorities);
      if (prioritySaveError) setSaveMessage(prioritySaveError);
      setScreen("workspace");
      if (!plan.feasible) {
        setNotice(plan.infeasibility ?? "Some tasks need a schedule adjustment.");
      }
    } catch (error) {
      if (!handleAuthFailure(error)) setNotice(error instanceof Error ? error.message : "The plan could not be generated. Try again.");
    } finally {
      setIsGenerating(false);
    }
  }

  function changeTaskState(taskId: string, taskState: TaskState) {
    setState((current) => {
      if (!current.plan) return current;
      const selectedTask = current.plan.tasks.find((task) => task.id === taskId);
      if (!selectedTask) return current;
      if ((taskState === "active" || taskState === "done") && !selectedTask.dependsOn.every((id) => current.plan?.tasks.some((task) => task.id === id && task.state === "done"))) return current;
      return {
        ...current,
        plan: { ...current.plan, tasks: current.plan.tasks.map((task) => task.id === taskId ? { ...task, state: taskState } : task) },
      };
    });
  }

  function saveLaterIdea(idea: string) {
    const cleanIdea = idea.trim().slice(0, 500);
    if (!cleanIdea) return;
    setState((current) => ({ ...current, laterIdeas: [cleanIdea, ...current.laterIdeas].slice(0, 50) }));
  }

  const eventBadge = screen === "connect"
    ? "Codex account"
    : screen === "workspace"
      ? eventLabel
      : screen === "team"
        ? teamSize > 0 ? `${teamSize} ${teamSize === 1 ? "person" : "people"}` : "Choose team size"
        : factsConfirmed ? "Event schedule confirmed" : "Add event details";

  return (
    <div className={`app-shell${screen === "workspace" ? " app-shell--workspace" : ""}`}>
      <header className="topbar">
        <div className="brand-lockup" aria-label="Sprintline">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>
            <span className="brand-name">Sprintline</span>
            <span className="brand-caption">Team sprint planner</span>
          </span>
        </div>
        <div className="event-badge" aria-live="polite">{eventBadge}</div>
        {authState === "connected" && (
          <button className="header-action" type="button" onClick={disconnectAccount} disabled={isDisconnecting}>
            {isDisconnecting ? "Disconnecting" : "Disconnect"}
          </button>
        )}
        <div className={`save-indicator save-${saveState}`} role="status" aria-live="polite">
          <span className="save-dot" aria-hidden="true" />
          {authState !== "connected"
            ? "Not connected"
            : saveState === "saving" ? "Saving locally" : saveState === "saved" ? "Saved on this device" : "Save issue"}
        </div>
      </header>

      {screen !== "connect" && screen !== "workspace" && (
        <nav className="step-nav" aria-label="Setup steps">
          <button
            className="step-button"
            type="button"
            aria-current={screen === "event" ? "step" : undefined}
            onClick={() => setScreen("event")}
          >
            <span className="step-number">01</span><span>Event</span>
          </button>
          <button
            className="step-button"
            type="button"
            aria-current={screen === "team" ? "step" : undefined}
            disabled={!factsConfirmed}
            onClick={() => setScreen("team")}
          >
            <span className="step-number">02</span><span>Team</span>
          </button>
          <button
            className="step-button"
            type="button"
            aria-current={screen === "prompt" ? "step" : undefined}
            disabled={!teamReady}
            onClick={() => setScreen("prompt")}
          >
            <span className="step-number">03</span><span>Project</span>
          </button>
        </nav>
      )}

      {notice && screen !== "event" && <p className="app-notice" role="status" aria-live="polite">{notice}</p>}
      {saveMessage && screen !== "workspace" && <p className="save-warning" role="status">{saveMessage}</p>}

      <div className="app-main">
      {screen === "connect" && (
        <ConnectAccount
          onStartChatGPTOAuth={startChatGPTOAuth}
          onRetryConnection={() => {
            setAuthMessage("Checking the local connection…");
            setAuthRetry((current) => current + 1);
          }}
          onContinueToSprint={() => setScreen("event")}
          state={authState}
          message={authMessage}
        />
      )}
      {screen === "event" && (
        <BackgroundIntake
          sources={state.sources}
          facts={state.facts}
          onAddSource={addEventSource}
          onContinue={confirmFacts}
          onBack={() => setScreen("connect")}
          message={notice}
        />
      )}
      {screen === "team" && (
        <TeamSurvey
          survey={state.survey}
          teamSize={teamSize}
          onTeamSizeChange={updateTeamSize}
          onMemberNameChange={updateMemberName}
          onRoleChange={updateMemberRole}
          onContinue={() => {
            if (teamReady) {
              setNotice("");
              setScreen("prompt");
            }
          }}
          onBack={() => setScreen("event")}
        />
      )}
      {screen === "prompt" && (
        <ProjectPrompt
          survey={state.survey}
          projectDescription={state.survey.outcome}
          onSurveyChange={updateSurvey}
          onDescriptionChange={(description) => updateSurvey({ ...state.survey, outcome: description })}
          audioMemo={voiceMemo}
          onAudioMemoChange={setVoiceMemo}
          ideas={ideas}
          isSuggestingIdeas={isSuggestingIdeas}
          ideaError={ideaError}
          onSuggestIdeas={suggestProjects}
          models={models}
          selectedModel={selectedModel}
          recommendedModelSlug={recommendedModelSlug}
          modelMessage={modelMessage}
          onModelChange={setSelectedModel}
          onGenerate={generatePlan}
          onBack={() => setScreen("team")}
          isGenerating={isGenerating}
        />
      )}
      {screen === "workspace" && state.plan && (
        <Workspace
          survey={state.survey}
          plan={state.plan}
          laterIdeas={state.laterIdeas}
          priorityByTaskId={priorityByTaskId}
          eventLabel={state.sources[0]?.label ?? "Event schedule"}
          eventTimeZone={eventContext(state.facts)?.timeZone ?? "UTC"}
          audioMemo={voiceMemo}
          onTaskStateChange={changeTaskState}
          onSaveLater={saveLaterIdea}
          onRestart={() => {
            setState((current) => ({ ...current, plan: undefined, planAccepted: false }));
            setScreen("prompt");
          }}
        />
      )}
      </div>

    </div>
  );
}

export default App;
