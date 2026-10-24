import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTHORIZATION_ENDPOINT = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_ENDPOINT = "https://auth.openai.com/api/accounts/oauth/token";
const REVOKE_ENDPOINT = "https://auth.openai.com/api/accounts/oauth/revoke";
const JWKS_ENDPOINT = "https://auth.openai.com/.well-known/jwks.json";
const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const REQUESTED_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  "chatgpt.tokens.use.direct",
].join(" ");
const CALLBACK_PATH = "/auth/callback";
const AUTH_ATTEMPT_TTL_MS = 10 * 60_000;
let registrationPromise;

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function randomUrlToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function isSafeClientId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function getDataDirectory() {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Sprintline");
  }
  const dataHome = process.env.XDG_DATA_HOME?.trim();
  return join(dataHome || join(homedir(), ".local", "share"), "sprintline");
}

async function secureDataDirectory() {
  const directory = getDataDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("unsafe_data_directory");
  }
  await chmod(directory, 0o700);
  return directory;
}

async function loadRegistration() {
  const directory = await secureDataDirectory();
  const registrationPath = join(directory, "oauth-registration.json");
  let registration;

  try {
    const details = await lstat(registrationPath);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("unsafe_registration_file");
    registration = JSON.parse(await readFile(registrationPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("invalid_registration_file");
  }

  if (registration !== undefined) {
    if (
      registration === null ||
      typeof registration !== "object" ||
      Object.keys(registration).some((key) => !["hostId", "clientId"].includes(key)) ||
      typeof registration.hostId !== "string" ||
      !/^urn:uuid:[0-9a-f-]{36}$/i.test(registration.hostId) ||
      (registration.clientId !== undefined && !isSafeClientId(registration.clientId))
    ) {
      throw new Error("invalid_registration_file");
    }
    return { directory, registrationPath, registration };
  }

  const created = { hostId: `urn:uuid:${randomUUID()}` };
  await writeRegistration(registrationPath, created);
  return { directory, registrationPath, registration: created };
}

async function writeRegistration(registrationPath, registration) {
  const temporaryPath = `${registrationPath}.${randomUrlToken(8)}.tmp`;
  const json = `${JSON.stringify(registration, null, 2)}\n`;
  await writeFile(temporaryPath, json, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, registrationPath);
}

async function readJson(response, maxBytes = 64_000) {
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

function parseJwt(token) {
  if (typeof token !== "string" || token.length > 24_000) throw new Error("invalid_id_token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid_id_token");
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const signature = Buffer.from(parts[2], "base64url");
    return { header, claims, signature, signingInput: `${parts[0]}.${parts[1]}` };
  } catch {
    throw new Error("invalid_id_token");
  }
}

async function verifyIdToken(token, clientId, expectedNonce, expectedSubject) {
  const { header, claims, signature, signingInput } = parseJwt(token);
  if (header?.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 200) {
    throw new Error("invalid_id_token");
  }

  const response = await fetch(JWKS_ENDPOINT, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("jwks_unavailable");
  const jwks = await readJson(response, 64_000);
  const jwk = Array.isArray(jwks?.keys)
    ? jwks.keys.find((candidate) => candidate?.kid === header.kid && candidate?.kty === "RSA" && (!candidate.alg || candidate.alg === "RS256") && (!candidate.use || candidate.use === "sig"))
    : undefined;
  if (!jwk) throw new Error("unknown_signing_key");

  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  const validSignature = verify("RSA-SHA256", Buffer.from(signingInput), publicKey, signature);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const audienceMatches = claims?.aud === clientId || (Array.isArray(claims?.aud) && claims.aud.includes(clientId));
  const audienceValid = audienceMatches && (!Array.isArray(claims?.aud) || claims.aud.length <= 1 || claims.azp === clientId);
  if (
    !validSignature ||
    claims?.iss !== ISSUER ||
    !audienceValid ||
    typeof claims.sub !== "string" ||
    claims.sub.length < 1 ||
    claims.sub.length > 500 ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= nowSeconds ||
    (Number.isFinite(claims.nbf) && claims.nbf > nowSeconds + 60) ||
    (Number.isFinite(claims.iat) && claims.iat > nowSeconds + 60) ||
    (expectedNonce !== undefined && claims.nonce !== expectedNonce) ||
    (expectedSubject !== undefined && claims.sub !== expectedSubject)
  ) {
    throw new Error("invalid_id_token");
  }
  return claims;
}

function tokenScopes(body, fallbackScopes = []) {
  if (typeof body?.scope === "string") {
    return new Set(body.scope.split(/\s+/).filter(Boolean));
  }
  return new Set(fallbackScopes);
}

function isPlanGrant(scopes) {
  return scopes.has("chatgpt.tokens.use.direct") && scopes.has("resource.invoke");
}

export async function createOAuthManager({ port }) {
  registrationPromise ??= loadRegistration();
  const metadata = await registrationPromise;
  let session;
  let pending;
  let lastError;

  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

  function status() {
    return {
      connected: Boolean(session),
      planUsageEnabled: Boolean(session && isPlanGrant(session.scopes)),
      ...(session ? { expiresAt: new Date(session.expiresAt).toISOString() } : {}),
      ...(lastError ? { error: lastError } : {}),
    };
  }

  function startAuthorization() {
    const verifier = randomUrlToken(48);
    const state = randomUrlToken();
    const nonce = randomUrlToken();
    const codeChallenge = base64Url(createHash("sha256").update(verifier).digest());
    const clientId = metadata.registration.clientId;
    const authorizationUrl = new URL(AUTHORIZATION_ENDPOINT);
    authorizationUrl.searchParams.set("client_id", clientId ?? DYNAMIC_CLIENT_ID);
    if (!clientId) authorizationUrl.searchParams.set("agent_name_hint", "Sprintline");
    authorizationUrl.searchParams.set("ext_agent_host_id", metadata.registration.hostId);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("scope", REQUESTED_SCOPES);
    authorizationUrl.searchParams.set("resource", RESOURCE);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("code_challenge", codeChallenge);

    pending = {
      state,
      nonce,
      verifier,
      clientId,
      createdAt: Date.now(),
    };
    lastError = undefined;
    return authorizationUrl.toString();
  }

  async function handleCallback(params) {
    const callbackState = params.get("state");
    if (!pending || !callbackState || callbackState !== pending.state || Date.now() - pending.createdAt > AUTH_ATTEMPT_TTL_MS) {
      pending = undefined;
      lastError = "oauth_state_invalid";
      throw new Error("oauth_state_invalid");
    }

    const attempt = pending;
    pending = undefined;

    const oauthError = params.get("error");
    if (oauthError) {
      lastError = oauthError === "access_denied" ? "oauth_access_denied" : "oauth_failed";
      throw new Error(lastError);
    }

    const code = params.get("code");
    if (!code || code.length > 4_000) {
      lastError = "oauth_callback_invalid";
      throw new Error(lastError);
    }

    const callbackClientId = params.get("client_id") ?? undefined;
    let clientId = attempt.clientId;
    if (!clientId) {
      if (!isSafeClientId(callbackClientId)) {
        lastError = "oauth_registration_invalid";
        throw new Error(lastError);
      }
      clientId = callbackClientId;
      metadata.registration.clientId = clientId;
      await writeRegistration(metadata.registrationPath, metadata.registration);
    } else if (callbackClientId !== undefined && callbackClientId !== clientId) {
      lastError = "oauth_registration_mismatch";
      throw new Error(lastError);
    }

    let tokenResponse;
    try {
      const response = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: attempt.verifier,
          redirect_uri: redirectUri,
          resource: RESOURCE,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error("token_exchange_failed");
      tokenResponse = await readJson(response, 64_000);
    } catch {
      lastError = "oauth_exchange_failed";
      throw new Error(lastError);
    }

    try {
      if (typeof tokenResponse?.id_token !== "string") throw new Error("missing_id_token");
      const identity = await verifyIdToken(tokenResponse.id_token, clientId, attempt.nonce);
      const scopes = tokenScopes(tokenResponse);
      if (!isPlanGrant(scopes)) {
        session = undefined;
        lastError = "plan_access_not_granted";
        throw new Error(lastError);
      }
      if (
        typeof tokenResponse.access_token !== "string" ||
        tokenResponse.access_token.length < 20 ||
        tokenResponse.access_token.length > 16_000 ||
        typeof tokenResponse.refresh_token !== "string" ||
        tokenResponse.refresh_token.length < 20 ||
        tokenResponse.refresh_token.length > 16_000 ||
        typeof tokenResponse.token_type !== "string" ||
        tokenResponse.token_type.toLowerCase() !== "bearer" ||
        !Number.isFinite(tokenResponse.expires_in) ||
        tokenResponse.expires_in < 60 ||
        tokenResponse.expires_in > 86_400
      ) {
        throw new Error("invalid_token_response");
      }

      session = {
        clientId,
        subject: identity.sub,
        idToken: tokenResponse.id_token,
        nonce: attempt.nonce,
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        scopes,
        expiresAt: Date.now() + tokenResponse.expires_in * 1000,
        refreshPromise: undefined,
      };
      lastError = undefined;
      return status();
    } catch (error) {
      if (error?.message !== "plan_access_not_granted") {
        session = undefined;
        lastError = "oauth_identity_invalid";
        throw new Error(lastError);
      }
      throw error;
    }
  }

  async function refreshSession(activeSession) {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: activeSession.clientId,
        refresh_token: activeSession.refreshToken,
        resource: RESOURCE,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error("refresh_failed");
    const result = await readJson(response, 64_000);
    const scopes = tokenScopes(result, [...activeSession.scopes]);
    if (!isPlanGrant(scopes)) throw new Error("refresh_scope_missing");
    if (
      typeof result.access_token !== "string" ||
      result.access_token.length < 20 ||
      result.access_token.length > 16_000 ||
      typeof result.token_type !== "string" ||
      result.token_type.toLowerCase() !== "bearer" ||
      !Number.isFinite(result.expires_in) ||
      result.expires_in < 60 ||
      result.expires_in > 86_400
    ) {
      throw new Error("invalid_refresh_response");
    }
    if (typeof result.refresh_token === "string" && result.refresh_token.length >= 20 && result.refresh_token.length <= 16_000) {
      activeSession.refreshToken = result.refresh_token;
    }
    if (typeof result.id_token === "string") {
      await verifyIdToken(result.id_token, activeSession.clientId, undefined, activeSession.subject);
      activeSession.idToken = result.id_token;
    }
    activeSession.accessToken = result.access_token;
    activeSession.scopes = scopes;
    activeSession.expiresAt = Date.now() + result.expires_in * 1000;
  }

  async function accessToken() {
    if (!session || !isPlanGrant(session.scopes)) throw new Error("not_connected");
    if (session.expiresAt > Date.now() + 60_000) return session.accessToken;

    const activeSession = session;
    activeSession.refreshPromise ??= refreshSession(activeSession)
      .catch(() => {
        if (session === activeSession) session = undefined;
        lastError = "reauthorization_required";
        throw new Error("reauthorization_required");
      })
      .finally(() => {
        activeSession.refreshPromise = undefined;
      });
    await activeSession.refreshPromise;
    return activeSession.accessToken;
  }

  async function disconnect() {
    const activeSession = session;
    session = undefined;
    lastError = undefined;
    if (!activeSession?.refreshToken) return { disconnected: true, revocationConfirmed: false };

    try {
      const response = await fetch(REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: activeSession.refreshToken,
          token_type_hint: "refresh_token",
          client_id: activeSession.clientId,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      return { disconnected: true, revocationConfirmed: response.ok };
    } catch {
      return { disconnected: true, revocationConfirmed: false };
    }
  }

  function requireReauthorization() {
    session = undefined;
    pending = undefined;
    lastError = "reauthorization_required";
  }

  function markPlanAccessNotGranted() {
    session = undefined;
    pending = undefined;
    lastError = "plan_access_not_granted";
  }

  function failAuthorization(code = "oauth_state_invalid") {
    session = undefined;
    pending = undefined;
    lastError = code === "oauth_access_denied" ? "oauth_access_denied" : "oauth_state_invalid";
  }

  return {
    status,
    startAuthorization,
    handleCallback,
    accessToken,
    disconnect,
    requireReauthorization,
    markPlanAccessNotGranted,
    failAuthorization,
  };
}
