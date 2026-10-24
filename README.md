# Sprintline

An unfinished hackathon planner built during DevDay Berlin on 24 October 2026.

## Failed delivery

Codex failed to deliver a working end-to-end application before the 15:45 Europe/Berlin submission deadline. Codex's slow execution, repeated incomplete iterations, and failure to verify authentication and real model-backed plan generation left geonq unable to reach the submission deadline.

The owner reported that the final step said no model was connected. Successful builds and HTTP responses did not establish a working demo. The application was not ready for submission, and this repository must not be presented as a completed or production-ready project.

Development was stopped at the owner's request. This repository preserves the final unfinished source and the record of that failure.

See [the skill usage audit](SKILL_USAGE_AUDIT.md) for what can and cannot be substantiated about the requested Pegasus workflow.

## Teardown

- The Cloudflare Pages project `sprintline`, including its deployments and custom-domain association, was deleted.
- The one connected local Sprintline ChatGPT OAuth session was disconnected, and the provider confirmed token revocation.
- The local Sprintline servers on ports 1455 and 5173 were stopped.
- The local Sprintline OAuth registration was removed.
- The owner's main Codex login and unrelated projects were not disconnected.

## Intended flow

Connect a ChatGPT account, import an event link or organizer text, enter team members and roles, describe a project by text or voice, and generate a task timeline with owners and a countdown.

The implementation contains React/TypeScript/Vite UI, deterministic event parsing and scheduling, browser speech recognition, and a local Node OAuth/planning companion. The Cloudflare deployment served only the frontend; a hosted authentication/planning backend was never delivered.

## Known limitations

- A complete real-account flow through successful model inference and a usable workspace was not verified.
- The owner encountered missing model access at the final step.
- Event ingestion and source-conflict handling required repeated fixes during the event.
- Voice recognition originally inherited the browser language, producing German recognition on a German locale. An explicit English source fix landed immediately before work stopped; it was not rebuilt or redeployed afterward.
- OAuth sessions were held only in memory, so restarting the local service lost the connection.
- The scheduler preserves the actual event deadline and can return an infeasible plan when insufficient time remains.

## Source reference

This is an archival setup reference, not an instruction to restore the deleted deployment or account connection.

```sh
npm install
npm run build
node server/local-server.mjs
```

The built local entry is `http://127.0.0.1:1455/`. Vite development additionally uses `npm run dev` on `http://127.0.0.1:5173/` with the companion running separately. See [server/README.md](server/README.md) for the existing local service contract.

The last UI build completed before the final voice-language edit. No new feature work or runtime release verification was performed after the stop request.
