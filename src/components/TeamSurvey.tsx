import { DEVELOPER_SPECIALTIES, TEAM_DEPARTMENTS } from "../domain/types";
import type { Capability, DeveloperSpecialty, TeamDepartment, TeamMember, TeamSurvey as TeamSurveyData } from "../domain/types";

export interface TeamSurveyProps {
  survey: TeamSurveyData;
  teamSize: number;
  onTeamSizeChange: (size: number) => void;
  onMemberNameChange: (memberId: string, name: string) => void;
  onRoleChange: (memberId: string, department: TeamDepartment | "", specialty: DeveloperSpecialty | "") => void;
  onContinue: () => void;
  onBack: () => void;
}

const DEPARTMENT_LABELS: Record<TeamDepartment, string> = {
  developer: "Developer",
  "product-design": "Product/Design",
  "data-ai": "Data/AI",
  "legal-policy": "Legal/Policy",
  "sales-gtm": "Sales/GTM",
  "ops-demo": "Ops/Demo",
};

const SPECIALTY_LABELS: Record<DeveloperSpecialty, string> = {
  frontend: "Frontend",
  backend: "Backend",
  fullstack: "Full-stack",
  "ai-data": "AI/Data",
  infrastructure: "Infrastructure",
};

export function roleLabel(member: Pick<TeamMember, "department" | "specialty">): string | undefined {
  if (!member.department) return undefined;
  return member.department === "developer" && member.specialty
    ? `${DEPARTMENT_LABELS[member.department]} / ${SPECIALTY_LABELS[member.specialty]}`
    : DEPARTMENT_LABELS[member.department];
}

export function roleCapabilities(
  department?: TeamDepartment,
  specialty?: DeveloperSpecialty,
): Capability[] {
  if (department === "developer") {
    switch (specialty) {
      case "frontend": return ["frontend"];
      case "backend": return ["backend"];
      case "fullstack": return ["frontend", "backend"];
      case "ai-data": return ["data", "backend"];
      case "infrastructure": return ["backend", "testing"];
      default: return ["frontend", "backend"];
    }
  }
  if (department === "product-design") return ["product", "design"];
  if (department === "data-ai") return ["data"];
  if (department === "legal-policy") return ["product"];
  if (department === "sales-gtm") return ["product", "demo"];
  if (department === "ops-demo") return ["testing", "demo"];
  return [];
}

export function inferRole(
  capabilities: Capability[] = [],
): Pick<TeamMember, "department" | "specialty"> {
  const selected = new Set(capabilities);
  if (selected.has("frontend") && selected.has("backend")) return { department: "developer", specialty: "fullstack" };
  if (selected.has("data") && selected.has("backend")) return { department: "developer", specialty: "ai-data" };
  if (selected.has("backend") && selected.has("testing")) return { department: "developer", specialty: "infrastructure" };
  if (selected.has("frontend")) return { department: "developer", specialty: "frontend" };
  if (selected.has("backend")) return { department: "developer", specialty: "backend" };
  if (selected.has("data")) return { department: "data-ai" };
  if (selected.has("design")) return { department: "product-design" };
  if (selected.has("product") && selected.has("demo")) return { department: "sales-gtm" };
  if (selected.has("demo") || selected.has("testing")) return { department: "ops-demo" };
  if (selected.has("product")) return { department: "legal-policy" };
  return {};
}

export default function TeamSurvey({
  survey,
  teamSize,
  onTeamSizeChange,
  onMemberNameChange,
  onRoleChange,
  onContinue,
  onBack,
}: TeamSurveyProps) {
  const rolesReady = teamSize >= 1 && teamSize <= 5 && survey.members.length === teamSize && survey.members.every((member) =>
    Boolean(member.name?.trim() && member.department),
  );

  return (
    <section className="flow-panel team-role-screen" aria-labelledby="team-survey-title">
      <header className="flow-heading">
        <div className="flow-heading__copy">
          <p className="step-kicker"><span className="step-marker">02</span> Setup · 2 of 3</p>
          <h1 id="team-survey-title">Who is building?</h1>
          <p className="flow-intro">Choose a team size, then add each person’s role.</p>
        </div>
      </header>

      <section className="team-role-intake" aria-label="Team roles">
        <label className="select-field team-role-size" htmlFor="team-role-size">
          <span>Team size</span>
          <select id="team-role-size" value={teamSize} onChange={(event) => onTeamSizeChange(Number(event.target.value))}>
            <option value={0}>Choose team size</option>
            {[1, 2, 3, 4, 5].map((size) => <option value={size} key={size}>{size} {size === 1 ? "person" : "people"}</option>)}
          </select>
        </label>

        {teamSize > 0 && (
          <div className="team-role-list">
            {survey.members.slice(0, teamSize).map((member, index) => {
              const specialtyId = `team-member-specialty-${member.id}`;
              return (
                <div className={`team-role-row${member.department === "developer" ? " team-role-row--developer" : ""}`} key={member.id}>
                  <span className="team-role-row__index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <label className="text-field" htmlFor={`team-member-name-${member.id}`}>
                    <span>Name</span>
                    <input
                      id={`team-member-name-${member.id}`}
                      type="text"
                      value={member.name ?? ""}
                      maxLength={80}
                      onChange={(event) => onMemberNameChange(member.id, event.target.value)}
                      autoComplete="off"
                      required
                    />
                  </label>
                  <label className="text-field" htmlFor={`team-member-department-${member.id}`}>
                    <span>Department</span>
                    <select
                      id={`team-member-department-${member.id}`}
                      value={member.department ?? ""}
                      onChange={(event) => onRoleChange(member.id, event.target.value as TeamDepartment | "", "")}
                      required
                    >
                      <option value="">Choose department</option>
                      {TEAM_DEPARTMENTS.map((department) => <option value={department} key={department}>{DEPARTMENT_LABELS[department]}</option>)}
                    </select>
                  </label>
                  {member.department === "developer" && (
                    <label className="text-field team-role-row__specialty" htmlFor={specialtyId}>
                      <span>Specialty</span>
                      <select
                        id={specialtyId}
                        value={member.specialty ?? ""}
                        onChange={(event) => onRoleChange(member.id, "developer", event.target.value as DeveloperSpecialty | "")}
                        required
                      >
                        <option value="">Choose specialty</option>
                        {DEVELOPER_SPECIALTIES.map((specialty) => <option value={specialty} key={specialty}>{SPECIALTY_LABELS[specialty]}</option>)}
                      </select>
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <footer className="intake-actions">
        <button className="button button--quiet" type="button" onClick={onBack}>Back</button>
        <button className="button button--primary" type="button" onClick={onContinue} disabled={!rolesReady}>Continue to project</button>
      </footer>
    </section>
  );
}
