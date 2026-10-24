# Sprintline local companion

This service is the local-only OAuth, event-page extraction, and ChatGPT plan-usage boundary. It binds to `127.0.0.1:1455` and owns the Sign in with ChatGPT callback at `http://127.0.0.1:1455/auth/callback`. Do not launch a second callback listener on that port.

## Run

For the built app:

```sh
npm run build
node server/local-server.mjs
```

For Vite development, run `node server/local-server.mjs` in one terminal and `npm run dev` in another. The API allows the exact dev origin `http://127.0.0.1:5173` and the built origin `http://127.0.0.1:1455`. Browser API requests must include `credentials: "include"`.

The server refuses alternate hosts, ports, and public origins. If port `1455` is occupied, stop the conflicting local process before starting Sprintline. The Cloudflare Pages frontend cannot use this companion remotely and must not report the local account as connected.

## Browser API

- `GET /api/auth/status` → `{ connected, planUsageEnabled, expiresAt?, error? }`
- `POST /api/auth/start` with `{}` → `{ authorizationUrl }`; call only from the explicit Connect action, then navigate the top-level browser to that URL.
- `POST /api/auth/disconnect` with `{}` → `{ disconnected: true, revocationConfirmed }`
- `GET /api/models` → `{ models: [{ slug, displayName }], recommendedModelSlug }`. The selected slugs come from the account's documented `models[]` catalog entries with `visibility: "list"`; planning recommends account-listed GPT-6 Luna (`gpt-6-luna`) and requests low reasoning effort for fast generation.
- `POST /api/sources/extract` with `{ url }` → `{ url, title, description, text, contentType }`. The UI passes this bounded text to the deterministic fact parser. Extraction failures include a paste-text fallback message.
- `POST /api/ideas` accepts `{ event: { confirmedFacts }, project: { brief? }, team: { members: [{ id, department?, specialty?, capabilities? }] } }` and returns `{ ideas: [{ title, description, teamFit, demonstration }] }` with exactly five distinct, validated ideas. It makes three bounded parallel Responses calls for problem fit, team fit, and demoability, then interleaves and deduplicates results deterministically. It requires GPT-6.1 Sol to appear in the account's model list; it returns an actionable error if unavailable.
- `POST /api/plan` accepts confirmed event facts, the user-typed project brief, and pseudonymous team members with department/specialty/capabilities plus an explicitly selected account-listed model. It returns `{ summary, tasks }`; local code validates and schedules the proposal using local availability and break data.

Team department values are `developer`, `product-design`, `data-ai`, `legal-policy`, `sales-gtm`, and `ops-demo`. Developer specialties are `frontend`, `backend`, `fullstack`, `ai-data`, and `infrastructure`; specialty is accepted only for the `developer` department. Names and availability stay local and are not sent to model requests. Planning requires the selected model to be on the account's listed catalog; the recommendation is GPT-6 Luna only when it is actually listed and is otherwise `null`.

The SIWC preview currently rejects the hosted Responses `multi_agent` field. Idea suggestions therefore use app-managed parallel model calls, not the hosted Multi-agent beta; the server sends no beta header or `multi_agent` field. If fewer than five unique valid ideas survive validation and deduplication, it returns an error instead of filling gaps.

OpenAI access and refresh tokens remain in memory in this process and are never returned to the browser or written to local storage. The OS application-support file stores only the OAuth host identifier and issued client ID. Restarting the server loses the in-memory session and requires the user to reconnect. Sign-in uses PKCE, state, nonce, ID-token signature/issuer/audience/expiry checks, and granted plan-usage scopes.

The service makes no login or inference request on startup. The model endpoint is called only when the connected UI requests the model list, explicitly requests suggestions, or submits a plan-generation request. Each HTML response receives a fresh CSP style nonce; local audio playback may use `blob:` media URLs. If the account, model, or plan-usage route is unavailable, the API returns an error; it does not create a simulated proposal.
