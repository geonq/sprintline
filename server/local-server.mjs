import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createOAuthManager } from "./oauth.mjs";
import { extractPublicEventPage } from "./source-extractor.mjs";
import { BoundaryError, generatePlanProposal, generateProjectIdeas, validateIdeaRequest, validatePlanRequest } from "./plan-service.mjs";

const HOST = "127.0.0.1";
const PORT = 1455;
const BASE_ORIGIN = `http://${HOST}:${PORT}`;
const ALLOWED_ORIGINS = new Set([BASE_ORIGIN, "http://127.0.0.1:5173"]);
const CALLBACK_PATH = "/auth/callback";
const MAX_JSON_BYTES = 24 * 1024;
const MAX_AUTH_SESSIONS = 30;
const IDEA_REQUEST_COOLDOWN_MS = 15_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const MODEL_CACHE_MS = 60 * 1000;
const MODEL_LIST_ENDPOINT = "https://api.openai.com/v1/models";
const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distRoot = resolve(appRoot, "dist");
const sessions = new Map();
const authAttempts = new Map();

function createCspNonce() {
  return randomBytes(18).toString("base64");
}

function setBaseHeaders(response, nonce) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("cache-control", "no-store");
  const nonceSource = nonce ? ` 'nonce-${nonce}'` : "";
  response.setHeader(
    "content-security-policy",
    `default-src 'self'; style-src 'self'${nonceSource}; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
  );
}

function sendJson(response, status, value) {
  setBaseHeaders(response);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function sendText(response, status, value, type = "text/plain; charset=utf-8") {
  setBaseHeaders(response);
  response.writeHead(status, { "content-type": type });
  response.end(value);
}

function sendApiError(response, status, code, message) {
  sendJson(response, status, { error: { code, message } });
}

function validateHost(request) {
  if (request.headers.host !== `${HOST}:${PORT}`) return false;
  const remote = request.socket.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::ffff:127.0.0.1";
}

function applyCors(request, response, { requireOrigin = false } = {}) {
  const origin = request.headers.origin;
  if (typeof origin === "string") {
    if (!ALLOWED_ORIGINS.has(origin)) return false;
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "Origin");
  } else if (requireOrigin) {
    return false;
  }
  return true;
}

function parseCookie(header, name) {
  if (typeof header !== "string" || header.length > 4_096) return undefined;
  for (const token of header.split(";")) {
    const separator = token.indexOf("=");
    if (separator < 0 || token.slice(0, separator).trim() !== name) continue;
    return token.slice(separator + 1).trim();
  }
  return undefined;
}

function newSessionId() {
  return randomBytes(32).toString("base64url");
}

function setSessionCookie(response, id) {
  response.setHeader("set-cookie", `sprintline_session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function cleanExpiredState() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastSeen > SESSION_TTL_MS) sessions.delete(id);
  }
  for (const [state, attempt] of authAttempts) {
    if (attempt.expiresAt <= now || !sessions.has(attempt.sessionId)) authAttempts.delete(state);
  }
}

function getSession(request, response, { create = true } = {}) {
  cleanExpiredState();
  const cookieId = parseCookie(request.headers.cookie, "sprintline_session");
  const validCookie = typeof cookieId === "string" && /^[A-Za-z0-9_-]{43}$/.test(cookieId);
  let id = validCookie ? cookieId : undefined;
  let session = id ? sessions.get(id) : undefined;
  if (!session && !create) return undefined;
  if (!session) {
    while (sessions.size >= MAX_AUTH_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      if (!oldest) break;
      sessions.delete(oldest[0]);
    }
    id = newSessionId();
    session = {
      id,
      lastSeen: Date.now(),
      oauthPromise: undefined,
      models: undefined,
      modelsFetchedAt: 0,
      ideasRequestedAt: 0,
      ideasInFlight: false,
    };
    sessions.set(id, session);
    setSessionCookie(response, id);
  } else {
    session.lastSeen = Date.now();
  }
  return session;
}

async function oauthFor(session) {
  session.oauthPromise ??= createOAuthManager({ port: PORT }).catch((error) => {
    session.oauthPromise = undefined;
    throw error;
  });
  return session.oauthPromise;
}

async function accessTokenFor(oauth) {
  try {
    return await oauth.accessToken();
  } catch {
    throw new RequestError(401, "reauthorization_required", "Reconnect ChatGPT to continue using plan access.");
  }
}

async function readJsonBody(request, maxBytes = MAX_JSON_BYTES) {
  const contentType = String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new RequestError(415, "invalid_content_type", "Send a JSON request body.");
  const length = Number(request.headers["content-length"]);
  if (Number.isFinite(length) && length > maxBytes) throw new RequestError(413, "request_too_large", "The request body is too large.");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new RequestError(413, "request_too_large", "The request body is too large.");
    chunks.push(chunk);
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "invalid_json", "The request body is not valid JSON.");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new RequestError(400, "invalid_json", "The request body must be a JSON object.");
  }
  return decoded;
}

async function readResponseJson(response, maxBytes = 512 * 1024) {
  if (!response.body) throw new Error("empty_response");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("response_too_large");
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function discoverModels(session, force = false) {
  if (!force && session.models && Date.now() - session.modelsFetchedAt < MODEL_CACHE_MS) return session.models;
  const oauth = await oauthFor(session);
  const token = await accessTokenFor(oauth);
  let response;
  try {
    response = await fetch(MODEL_LIST_ENDPOINT, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new RequestError(502, "models_unavailable", "The connected account's model list is temporarily unavailable.");
  }
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    if (response.status === 401) {
      oauth.requireReauthorization?.();
      session.models = undefined;
      throw new RequestError(401, "reauthorization_required", "Reconnect ChatGPT to continue using plan access.");
    }
    if (response.status === 403) {
      oauth.markPlanAccessNotGranted?.();
      session.models = undefined;
      throw new RequestError(403, "plan_access_not_granted", "This account did not grant ChatGPT plan usage to Sprintline.");
    }
    throw new RequestError(502, "models_unavailable", "The connected account's model list is temporarily unavailable.");
  }

  let payload;
  try {
    payload = await readResponseJson(response);
  } catch {
    throw new RequestError(502, "models_unavailable", "The connected account returned an unsupported model list.");
  }
  if (!Array.isArray(payload?.models) || payload.models.length > 500) {
    throw new RequestError(502, "models_unavailable", "The connected account returned an unsupported model list.");
  }
  const models = payload.models.flatMap((item) => {
    const slug = typeof item?.slug === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(item.slug) ? item.slug : undefined;
    if (!slug) return [];
    if (item?.visibility !== "list") return [];
    const displayName = typeof item?.display_name === "string" && item.display_name.length <= 120
      ? item.display_name
      : slug;
    return [{ slug, displayName }];
  });
  if (models.length === 0) throw new RequestError(503, "models_unavailable", "No eligible models were listed for this account.");
  session.models = models;
  session.modelsFetchedAt = Date.now();
  return models;
}

function recommendedModelSlug(models) {
  return models.find((model) => model.slug.toLowerCase() === "gpt-6-luna")?.slug ?? null;
}

function ideasModelSlug(models) {
  return models.find((model) => model.slug.toLowerCase() === "gpt-6.1-sol")?.slug ?? null;
}

function safeStatus(status) {
  const allowed = new Set([
    "oauth_access_denied",
    "oauth_failed",
    "oauth_state_invalid",
    "oauth_exchange_failed",
    "oauth_identity_invalid",
    "plan_access_not_granted",
    "reauthorization_required",
  ]);
  return {
    connected: status.connected === true,
    planUsageEnabled: status.planUsageEnabled === true,
    ...(typeof status.expiresAt === "string" ? { expiresAt: status.expiresAt } : {}),
    ...(allowed.has(status.error) ? { error: status.error } : {}),
  };
}

function routeError(error, response) {
  if (error instanceof RequestError) {
    sendApiError(response, error.status, error.code, error.message);
    return;
  }
  if (error instanceof BoundaryError) {
    const status = error.code === "usage_limit" ? 429
      : error.code === "invalid_model" ? 400
        : error.code === "invalid_input" || error.code === "missing_event_facts" ? 400
          : error.code === "model_request_unsupported" ? 400
          : error.code === "reauthorization_required" ? 401
            : error.code === "plan_access_not_granted" ? 403
              : error.code === "model_unavailable" ? 503
                : 502;
    sendApiError(response, status, error.code, error.message);
    return;
  }
  sendApiError(response, 500, "request_failed", "The local request could not be completed.");
}

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function handleCallback(request, response, url) {
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== "https://auth.openai.com") {
    sendText(response, 403, "Sign-in callback rejected.");
    return;
  }
  const state = url.searchParams.get("state");
  const attempt = state ? authAttempts.get(state) : undefined;
  if (!attempt || attempt.expiresAt <= Date.now()) {
    sendText(response, 400, "Sign-in could not be verified. Return to Sprintline and try again.");
    return;
  }

  const session = getSession(request, response, { create: false });
  if (!session || session.id !== attempt.sessionId) {
    authAttempts.delete(state);
    sendText(response, 400, "Sign-in could not be verified in this browser. Return to Sprintline and try again.");
    return;
  }
  authAttempts.delete(state);
  const redirectOrigin = ALLOWED_ORIGINS.has(attempt.returnOrigin) ? attempt.returnOrigin : BASE_ORIGIN;
  try {
    if (url.searchParams.has("iss") && url.searchParams.get("iss") !== "https://auth.openai.com") {
      const oauth = await oauthFor(session);
      oauth.failAuthorization?.("oauth_state_invalid");
      throw new Error("oauth_issuer_invalid");
    }
    const oauth = await oauthFor(session);
    await oauth.handleCallback(url.searchParams);
  } catch {
    // OAuth manager retains only a bounded error code; never reflect callback data.
  }
  response.writeHead(303, {
    location: `${redirectOrigin}/`,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end();
}

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
  [".ico", "image/x-icon"],
  [".json", "application/json; charset=utf-8"],
]);

async function serveStatic(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendApiError(response, 405, "method_not_allowed", "This method is not supported.");
    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendApiError(response, 400, "invalid_path", "The requested path is invalid.");
    return;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) {
    sendApiError(response, 400, "invalid_path", "The requested path is invalid.");
    return;
  }
  const relativePath = decoded.replace(/^\/+/, "");
  let filePath = resolve(distRoot, relativePath || "index.html");
  const relativePathFromRoot = relative(distRoot, filePath);
  if (relativePathFromRoot === ".." || relativePathFromRoot.startsWith(`..${sep}`) || relativePathFromRoot.startsWith(sep)) {
    sendApiError(response, 400, "invalid_path", "The requested path is invalid.");
    return;
  }
  try {
    const details = await stat(filePath);
    if (details.isDirectory()) filePath = resolve(filePath, "index.html");
  } catch {
    filePath = resolve(distRoot, "index.html");
  }
  try {
    let content = await readFile(filePath);
    const nonce = createCspNonce();
    setBaseHeaders(response, nonce);
    if (extname(filePath) === ".html") {
      const html = content.toString("utf8");
      const nonceMeta = `<meta name="csp-nonce" content="${nonce}">`;
      content = Buffer.from(html.replace("</head>", `${nonceMeta}</head>`), "utf8");
    }
    response.writeHead(200, { "content-type": CONTENT_TYPES.get(extname(filePath)) ?? "application/octet-stream" });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch {
    sendApiError(response, 503, "app_not_built", "Build the local app first, then restart this server.");
  }
}

async function handleRequest(request, response) {
  setBaseHeaders(response);
  if (!validateHost(request)) {
    sendApiError(response, 403, "host_rejected", "Use the local Sprintline address at 127.0.0.1:1455.");
    return;
  }
  if (typeof request.url !== "string" || request.url.length > 8_192) {
    sendApiError(response, 414, "request_target_too_large", "The request target is too large.");
    return;
  }
  let url;
  try {
    url = new URL(request.url, BASE_ORIGIN);
  } catch {
    sendApiError(response, 400, "invalid_path", "The request path is invalid.");
    return;
  }
  if (url.origin !== BASE_ORIGIN) {
    sendApiError(response, 400, "invalid_path", "The request path is invalid.");
    return;
  }

  if (url.pathname === CALLBACK_PATH && request.method === "GET") {
    await handleCallback(request, response, url);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    if (!applyCors(request, response, { requireOrigin: request.method === "POST" })) {
      sendApiError(response, 403, "origin_rejected", "This browser origin is not allowed.");
      return;
    }
    if (request.method === "OPTIONS") {
      if (typeof request.headers.origin !== "string") {
        sendApiError(response, 403, "origin_rejected", "This browser origin is not allowed.");
        return;
      }
      response.writeHead(204, {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Content-Type",
        "access-control-max-age": "600",
      });
      response.end();
      return;
    }
    const session = getSession(request, response);
    try {
      await handleApi(request, response, url, session);
    } catch (error) {
      routeError(error, response);
    }
    return;
  }

  if (!applyCors(request, response)) {
    sendApiError(response, 403, "origin_rejected", "This browser origin is not allowed.");
    return;
  }
  await serveStatic(request, response, url.pathname);
}

async function handleApi(request, response, url, session) {
  if (url.pathname === "/api/auth/status" && request.method === "GET") {
    const oauth = await oauthFor(session);
    sendJson(response, 200, safeStatus(oauth.status()));
    return;
  }

  if (url.pathname === "/api/auth/start" && request.method === "POST") {
    const body = await readJsonBody(request, 1_024);
    if (Object.keys(body).length > 0) throw new RequestError(400, "invalid_input", "Sign-in start does not accept extra fields.");
    const origin = request.headers.origin;
    if (!ALLOWED_ORIGINS.has(origin)) throw new RequestError(403, "origin_rejected", "This browser origin is not allowed.");
    const oauth = await oauthFor(session);
    const authorizationUrl = oauth.startAuthorization();
    const state = new URL(authorizationUrl).searchParams.get("state");
    if (!state) throw new RequestError(500, "oauth_failed", "Sign-in could not be started.");
    authAttempts.set(state, { sessionId: session.id, returnOrigin: origin, expiresAt: Date.now() + AUTH_ATTEMPT_TTL_MS });
    sendJson(response, 200, { authorizationUrl });
    return;
  }

  if (url.pathname === "/api/auth/disconnect" && request.method === "POST") {
    const body = await readJsonBody(request, 1_024);
    if (Object.keys(body).length > 0) throw new RequestError(400, "invalid_input", "Disconnect does not accept extra fields.");
    const oauth = await oauthFor(session);
    const result = await oauth.disconnect();
    session.models = undefined;
    sendJson(response, 200, {
      disconnected: true,
      revocationConfirmed: result.revocationConfirmed === true,
    });
    return;
  }

  if (url.pathname === "/api/models" && request.method === "GET") {
    const oauth = await oauthFor(session);
    if (!oauth.status().planUsageEnabled) throw new RequestError(401, "auth_required", "Connect an account with ChatGPT plan usage first.");
    const models = await discoverModels(session);
    sendJson(response, 200, { models, recommendedModelSlug: recommendedModelSlug(models) });
    return;
  }

  if (url.pathname === "/api/sources/extract" && request.method === "POST") {
    const body = await readJsonBody(request, 4_096);
    if (Object.keys(body).length !== 1 || typeof body.url !== "string") {
      throw new RequestError(400, "invalid_input", "Provide one event URL over HTTPS.");
    }
    try {
      const extracted = await extractPublicEventPage(body.url);
      sendJson(response, 200, extracted);
    } catch (error) {
      const code = error?.message === "unsupported_page" || error?.message === "unsupported_content_type"
        ? "source_unsupported"
        : error?.message === "unsupported_url" || error?.message === "invalid_url" || error?.message === "non_public_address"
          ? "source_url_rejected"
          : "source_unavailable";
      const message = code === "source_unsupported"
        ? "This page does not expose enough readable event text. Paste the relevant instructions instead."
        : code === "source_url_rejected"
          ? "Only public HTTPS event pages can be fetched. Paste the relevant instructions if this URL is private or unsupported."
          : "The page could not be safely fetched. Keep your URL and paste the relevant instructions instead.";
      sendApiError(response, code === "source_url_rejected" ? 400 : 422, code, message);
    }
    return;
  }

  if (url.pathname === "/api/plan" && request.method === "POST") {
    const body = await readJsonBody(request, MAX_JSON_BYTES);
    const validated = validatePlanRequest(body);
    const oauth = await oauthFor(session);
    if (!oauth.status().planUsageEnabled) throw new RequestError(401, "auth_required", "Connect an account with ChatGPT plan usage first.");
    const models = await discoverModels(session);
    const token = await accessTokenFor(oauth);
    try {
      const proposal = await generatePlanProposal({
        accessToken: token,
        model: validated.model,
        availableModels: new Set(models.map((item) => item.slug)),
        body: validated,
      });
      sendJson(response, 200, proposal);
    } catch (error) {
      if (error instanceof BoundaryError && error.code === "reauthorization_required") {
        oauth.requireReauthorization?.();
        session.models = undefined;
      }
      if (error instanceof BoundaryError && error.code === "plan_access_not_granted") {
        oauth.markPlanAccessNotGranted?.();
        session.models = undefined;
      }
      throw error;
    }
    return;
  }

  if (url.pathname === "/api/ideas" && request.method === "POST") {
    const body = await readJsonBody(request, 12 * 1024);
    validateIdeaRequest(body);
    const oauth = await oauthFor(session);
    if (!oauth.status().planUsageEnabled) throw new RequestError(401, "auth_required", "Connect an account with ChatGPT plan usage first.");
    const now = Date.now();
    if (session.ideasInFlight || now - session.ideasRequestedAt < IDEA_REQUEST_COOLDOWN_MS) {
      throw new RequestError(429, "ideas_rate_limited", "Wait briefly before requesting more project suggestions.");
    }
    const models = await discoverModels(session);
    const model = ideasModelSlug(models);
    if (!model) throw new RequestError(503, "ideas_model_unavailable", "GPT-6.1 Sol is not listed for this account. No suggestions were generated; check the account's model list.");
    const token = await accessTokenFor(oauth);
    session.ideasInFlight = true;
    session.ideasRequestedAt = now;
    try {
      const result = await generateProjectIdeas({
        accessToken: token,
        model,
        availableModels: new Set(models.map((item) => item.slug)),
        body,
      });
      response.setHeader("x-sprintline-idea-model", model);
      sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof BoundaryError && error.code === "reauthorization_required") {
        oauth.requireReauthorization?.();
        session.models = undefined;
      }
      if (error instanceof BoundaryError && error.code === "plan_access_not_granted") {
        oauth.markPlanAccessNotGranted?.();
        session.models = undefined;
      }
      throw error;
    } finally {
      session.ideasInFlight = false;
    }
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (request.method !== "GET" && request.method !== "POST") {
      throw new RequestError(405, "method_not_allowed", "This API method is not supported.");
    }
    throw new RequestError(404, "not_found", "This local API route does not exist.");
  }
  throw new RequestError(404, "not_found", "This local API route does not exist.");
}

const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
  handleRequest(request, response).catch(() => {
    if (!response.headersSent) sendApiError(response, 500, "request_failed", "The local request could not be completed.");
    else response.destroy();
  });
});

server.headersTimeout = 10_000;
server.requestTimeout = 20_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

server.on("error", (error) => {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : "UNKNOWN";
  process.stderr.write(`Sprintline could not start on 127.0.0.1:1455 (${code}). Check whether that local port is already in use.\n`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  process.stdout.write("Sprintline local server ready at http://127.0.0.1:1455\n");
});

function closeServer() {
  sessions.clear();
  authAttempts.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
}

process.on("SIGINT", closeServer);
process.on("SIGTERM", closeServer);
