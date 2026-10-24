# Sprintline — product brief

This document specifies intended behavior. It is not evidence that the features or integrations below are implemented or verified.

## Purpose

Sprintline turns event instructions and a team's project idea into prioritized work that fits the confirmed event deadline. It serves existing hackathon teams of one to five, including teams of one, working from a Mac desktop browser. Live multi-device collaboration is outside the current scope.

Teams should spend little effort explaining their context, understand what to do next, and retain enough protected time to demonstrate and submit actual working behavior. Source uncertainty and infeasible schedules must remain visible.

## Intended flow

1. **Connect:** offer official Sign in with ChatGPT to connect the user's account for ChatGPT-plan-backed AI. Connection succeeds only after the runtime confirms authentication; pending, cancellation, failure and retry remain explicit.
2. **Event source:** show one blank field accepting an event link or relevant pasted instructions. No DevDay fixtures, dates or facts appear automatically.
3. **Team:** show an initially unselected team size, then create the corresponding blank teammate rows for name and department. Show Dev-specialty fields conditionally for teammates in Dev. Do not insert fictional names, departments or specialties. Keep secondary availability details optional.
4. **Project:** make one project-idea prompt dominant, with optional voice capture and a real **Suggest 5 projects** action. Voice must produce an editable transcript that the user can review and correct before generation; reviewed text supplies the planning input. Preserve the user's draft while suggestions load. Local recording/playback alone does not satisfy the voice demo.
5. **Execute:** the selected or typed project feeds Luna Max planning, then generation leads directly into a distinct sprint workspace without another preview screen. Show priority-weighted tasks and a dependency-aware timeline, clear owners/status, and an always-visible current-stage countdown at top-right. Expand task details through real controls. Support progress and later ideas with visible local-save status.

## Event facts and planning

An event URL should trigger bounded deterministic extraction through the local backend. Unsupported, inaccessible or rejected sources should offer a pasted-text fallback without losing the input. Display concise provenance and require explicit resolution of material conflicts; do not present a stored URL as a fetched source.

Event date, timezone, cutoff and protected finish windows must come from confirmed generic event context. Ask for missing scheduling essentials inline. Video requirements are event-specific, not mandatory for every event. A timestamp alone does not establish a deadline; food arrival does not establish a break.

ChatGPT-plan-backed AI should propose actual tasks and priorities informed by the project description. A local deterministic scheduler must validate and schedule those proposals against dependencies, owner availability, explicit breaks and confirmed protected windows. AI output is untrusted structured input, not authority over deadlines. Report infeasibility and useful cuts instead of silently shortening protected work or claiming a fixed template is a personalized AI plan.

**Suggest 5 projects** should run three app-managed parallel GPT-6.1 Sol requests with low reasoning effort, using complementary idea-generation perspectives. Validate the responses, then deterministically deduplicate, rank and merge them into exactly five valid project choices. Do not fabricate missing choices after failures; show an actionable retry if fewer than five valid candidates remain. Selecting a choice populates the project prompt for Luna Max planning. Discover both requested models from the signed-in account and disclose missing access rather than silently substituting another model.

This is application-managed concurrency. The SIWC preview explicitly excludes the Responses `multi_agent` field; do not send it or imply hosted subagents ran. Keep each request within the supported SIWC flow (`store:false`, `stream:true`) and require completed inference before reporting success. [SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## Visual and interaction direction

Optimize for geonq's normal Mac desktop viewport, approximately 1440×900 or the observed screen dimensions. Phone optimization is out of scope. Use a restrained dark monochrome interface, sparse copy, clear hierarchy and real whitespace/proximity. Keep the overall content near 1160px and the execution timeline near 1300px; use rounded controls without excessive pills.

Inspect and reuse compatible Pegasus/Pi GUI form surfaces and layout primitives after checking licensing and browser compatibility. Avoid gradients, glows, oversized fact cards and passive elements that appear clickable. Inputs need deliberate styling and a visible designed keyboard-focus treatment, rather than browser-default textbox/focus effects. The project prompt should dominate intake; the current stage and next work should dominate execution.

## Runtime and security boundary

The intended stack remains React + TypeScript + Vite with a local backend at `127.0.0.1:1455`. Confirm ownership of the OAuth callback port before integration. Local/open-source Codex app-server authentication is a local runtime path; it must not be repurposed as authentication for a hosted service. A hosted service requires the official supported Sign in with ChatGPT integration and its required access. A Cloudflare static frontend does not remove this boundary or the need to disclose a local companion.

Discover account/model capabilities at runtime and report missing access honestly. Keep account credentials in the supported runtime credential boundary, never browser persistence or logs. Validate the local browser session, Origin/Host and request limits; expose only required planning operations. URL extraction must prevent SSRF, including private/reserved destinations, unsafe redirects and DNS rebinding, with bounded time and response size.

Persist only non-secret plan/progress locally and state that each browser/device has its own copy. Do not retain raw private email or raw voice recordings as plan data. Preserve drafts and report save/generation failures honestly.

## Current integration blockers and evidence required

- **Actual OAuth and model smoke test:** remains a runtime gate. Demonstrate real account connection and model discovery, three parallel low-effort Sol idea requests with exactly five merged choices, and selected-project Luna Max inference through the supported local integration. Popup opening, mock connection or static task output is insufficient.
- **Voice transcript to editable text — critical demo gate:** demonstrate spoken project capture producing text in the editable project prompt, successful review/correction, and generation from that reviewed text. Actual transcription integration and inference remain unverified by this brief; a VoiceGlow animation or local memo alone is insufficient. Also verify denied/unsupported permission, recording, stop/cancel and playback under the built-host CSP, without unexplained audio retention.
- **End-to-end review:** demonstrate blank event/team inputs, dynamic teammate fields, suggestion selection or typed input, direct workspace transition, generic scheduling, countdown, progress and refresh recovery in the actual Mac desktop browser before claiming completion.

## Demo and delivery boundaries

The live demo uses Sprintline itself as the hackathon planner. The hypothetical project being planned is a **notes app that converts notes to todos and creates workspace invite links**; Sprintline is not that notes app. Enter a team of three during the demonstration: Sales/GTM, Full-stack Developer and Backend Developer. Names remain live inputs rather than invented identities.

Speak the notes-app idea into the project prompt, inspect the transcript, edit it, and generate a visual sprint timeline containing concrete next steps and owners suited to those three roles. Verify that the reviewed transcript, not just an audio blob or placeholder description, reaches planning. This is a live demo scenario only: never preload its project, team size, departments or specialties into first-run form data. Transcript-to-editable-text is a critical demo acceptance gate.

Use real working behavior and label any sample inputs. Do not claim measured productivity gains, an official judging rubric or guaranteed selection. The current DevDay submission context has a 15:45 Europe/Berlin cutoff on 24 October 2026 and a two-minute working-product video instruction whose exact-versus-maximum wording needs confirmation; these are submission notes, not product defaults.

Cloudflare Pages may host the static frontend in a dedicated project/subdomain. Preserve the existing geonq root site, verify the delivered artifact, and disclose local-runtime requirements. Accounts/calendar sync, hosted team collaboration, native SwiftUI clients and unnecessary animation remain out of scope.
