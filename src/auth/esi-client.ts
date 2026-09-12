import fs from "fs";
import path from "path";
import os from "os";
import { refreshAccessToken, startLoginFlow, waitForLogin, getPendingLogin } from "./oauth.js";
import { getCurrentCharacter, updateTokens, getTokens, storeTokens, setCurrentCharacterId } from "./tokens.js";
import type { StoredCharacter } from "./tokens.js";

const ESI_BASE = "https://esi.evetech.net/latest";
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

export const ESI_CACHE_TTL = 5 * 60 * 1000;

export interface EsiRequestOptions {
  characterId?: number;
  public?: boolean;
}

const esiCache = new Map<string, { data: unknown; expiresAt: number }>();

function getCached<T>(key: string): T | undefined {
  const entry = esiCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    esiCache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

function setCached(key: string, data: unknown, ttlMs: number): void {
  esiCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

/** A definitively dead refresh token (ESI invalid_grant) — the only failure
 *  worth interrupting the user with a browser for. */
export function isDeadRefreshToken(underlyingMsg: string): boolean {
  return underlyingMsg.includes("invalid_grant");
}

/** The error a caller sees when re-authentication didn't happen or failed. */
export function refreshFailureMessage(characterName: string, underlyingMsg: string): string {
  return (
    `Token refresh failed for ${characterName}: ${underlyingMsg}. ` +
    `Use the esi_login tool to re-authenticate.`
  );
}

// Auto-login, wait-and-continue: when a tool call fails a token refresh
// with invalid_grant, start the SSO login flow (browser opens) and WAIT for
// the user to authenticate — up to the flow's 5-minute timeout — instead of
// failing fast. On success the original call continues with the fresh
// token. Concurrent dead-token calls share one in-flight flow rather than
// superseding each other. A cooldown after a failed/abandoned flow stops a
// retry loop from reopening the browser every call.
let lastAutoLoginAt = 0;
const AUTO_LOGIN_COOLDOWN_MS = 60_000;

type AutoLoginOutcome =
  | { status: "authenticated"; character: StoredCharacter }
  | { status: "mismatch"; authedAs: string }
  | { status: "failed" };

async function autoLoginAndWait(
  requested: StoredCharacter,
  explicitCharacterId: number | undefined,
  clientId: string
): Promise<AutoLoginOutcome> {
  let flow = getPendingLogin();
  if (flow) {
    process.stderr.write(`[auto-login] Login flow already in progress — waiting on it.\n`);
  } else {
    if (Date.now() - lastAutoLoginAt < AUTO_LOGIN_COOLDOWN_MS) return { status: "failed" };
    lastAutoLoginAt = Date.now();
    const { authUrl } = startLoginFlow(clientId);
    try {
      const { execFile } = await import("child_process");
      execFile("open", [authUrl], () => {
        // best-effort; the URL is also in stderr
      });
    } catch {
      // best-effort
    }
    process.stderr.write(
      `[auto-login] Token for ${requested.characterName} is dead — browser opened, waiting for authentication (up to 5 minutes)...\n`
    );
    flow = waitForLogin();
  }

  try {
    const result = await flow;
    storeTokens(result.tokens, result.character);
    setCurrentCharacterId(result.character.characterId);
    if (explicitCharacterId && result.character.characterId !== explicitCharacterId) {
      process.stderr.write(
        `[auto-login] Authenticated as ${result.character.characterName}, but this call needs ${requested.characterName}.\n`
      );
      return { status: "mismatch", authedAs: result.character.characterName };
    }
    process.stderr.write(`[auto-login] Authenticated as ${result.character.characterName} — continuing the call.\n`);
    const restored = getTokens(result.character.characterId);
    return restored ? { status: "authenticated", character: restored } : { status: "failed" };
  } catch (err) {
    process.stderr.write(
      `[auto-login] Login flow ended without success: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return { status: "failed" };
  }
}

export function readClientId(): string {
  const configPath = path.join(os.homedir(), ".eve-sde", "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      "No config.json found at ~/.eve-sde/config.json — run esi_login with a client_id first"
    );
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  return config.clientId;
}

export async function getValidToken(
  characterId?: number
): Promise<{ token: string; character: StoredCharacter }> {
  let character: StoredCharacter | null;
  if (characterId) {
    character = getTokens(characterId);
  } else {
    character = getCurrentCharacter();
  }

  if (!character) {
    throw new Error("No authenticated character. Use the esi_login tool first.");
  }

  const fiveMinutes = 5 * 60 * 1000;
  const timeLeft = character.expiresAt.getTime() - Date.now();
  if (timeLeft < fiveMinutes) {
    const expired = timeLeft <= 0;
    process.stderr.write(
      `ESI token for ${character.characterName} ${expired ? "expired" : "expiring soon"}, refreshing...\n`
    );
    const clientId = readClientId();
    try {
      const newTokens = await refreshAccessToken(character.refreshToken, clientId);
      updateTokens(character.characterId, newTokens);
      character = getTokens(character.characterId)!;
      process.stderr.write(`ESI token refreshed, valid for ${Math.round(newTokens.expiresAt.getTime() - Date.now()) / 1000}s\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isDeadRefreshToken(msg)) {
        const outcome = await autoLoginAndWait(character, characterId, clientId);
        if (outcome.status === "authenticated") {
          // One refresh retry with the fresh refresh token
          try {
            const newTokens = await refreshAccessToken(outcome.character.refreshToken, clientId);
            updateTokens(outcome.character.characterId, newTokens);
            character = getTokens(outcome.character.characterId)!;
            process.stderr.write(
              `[auto-login] Token restored for ${character.characterName} — continuing the call.\n`
            );
            // fall through with a valid token — the call proceeds
          } catch (retryErr) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            throw new Error(refreshFailureMessage(outcome.character.characterName, retryMsg));
          }
        } else if (outcome.status === "mismatch") {
          throw new Error(
            `Authenticated as ${outcome.authedAs}, but this call needs ${character.characterName} — their token is still dead. ` +
            `Run esi_login again and authenticate as ${character.characterName}, then re-run this tool.`
          );
        } else {
          throw new Error(refreshFailureMessage(character.characterName, msg));
        }
      } else {
        throw new Error(refreshFailureMessage(character.characterName, msg));
      }
    }
  }

  return { token: character.accessToken, character };
}

function checkRateLimit(response: Response, esiPath: string): void {
  const remaining = response.headers.get("x-esi-error-limit-remain");
  if (remaining !== null && parseInt(remaining, 10) < 20) {
    const reset = response.headers.get("x-esi-error-limit-reset") ?? "?";
    process.stderr.write(
      `ESI error limit warning: ${remaining} errors remaining, resets in ${reset}s (${esiPath})\n`
    );
  }
}

async function handleResponse<T>(response: Response, esiPath: string): Promise<T> {
  checkRateLimit(response, esiPath);

  if (response.status === 420) {
    const reset = response.headers.get("x-esi-error-limit-reset") ?? "unknown";
    throw new Error(
      `ESI rate limited on ${esiPath}. Retry after ${reset} seconds.`
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ESI ${esiPath} failed (${response.status}): ${body}`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  esiPath: string
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, init);
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_RETRIES) {
      return response;
    }
    process.stderr.write(
      `ESI ${response.status} on ${esiPath}, retry ${attempt + 1}/${MAX_RETRIES}...\n`
    );
    await sleep(RETRY_DELAY_MS * (attempt + 1));
  }
  return fetch(url, init);
}

async function buildHeaders(opts?: EsiRequestOptions): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (!opts?.public) {
    const { token } = await getValidToken(opts?.characterId);
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function esiGet<T>(
  esiPath: string,
  opts?: EsiRequestOptions & { cacheTtlMs?: number }
): Promise<T> {
  if (opts?.cacheTtlMs) {
    const cached = getCached<T>(esiPath);
    if (cached !== undefined) return cached;
  }

  const url = `${ESI_BASE}${esiPath}`;
  const headers = await buildHeaders(opts);
  const response = await fetchWithRetry(url, { headers }, esiPath);
  const data = await handleResponse<T>(response, esiPath);

  if (opts?.cacheTtlMs) {
    setCached(esiPath, data, opts.cacheTtlMs);
  }

  return data;
}

export async function esiGetAll<T>(
  esiPath: string,
  opts?: EsiRequestOptions & { cacheTtlMs?: number }
): Promise<T[]> {
  if (opts?.cacheTtlMs) {
    const cached = getCached<T[]>(esiPath);
    if (cached !== undefined) return cached;
  }

  const url = `${ESI_BASE}${esiPath}`;
  const headers = await buildHeaders(opts);

  const firstResponse = await fetchWithRetry(url, { headers }, esiPath);
  const firstPage = await handleResponse<T[]>(firstResponse, esiPath);

  const totalPages = parseInt(firstResponse.headers.get("x-pages") ?? "1", 10);

  if (totalPages <= 1) {
    if (opts?.cacheTtlMs) setCached(esiPath, firstPage, opts.cacheTtlMs);
    return firstPage;
  }

  const separator = esiPath.includes("?") ? "&" : "?";
  const pagePromises: Promise<T[]>[] = [];
  for (let page = 2; page <= totalPages; page++) {
    const pageUrl = `${ESI_BASE}${esiPath}${separator}page=${page}`;
    pagePromises.push(
      fetchWithRetry(pageUrl, { headers }, esiPath).then((r) => handleResponse<T[]>(r, esiPath))
    );
  }

  const remainingPages = await Promise.all(pagePromises);
  const allData = firstPage.concat(...remainingPages);

  if (opts?.cacheTtlMs) setCached(esiPath, allData, opts.cacheTtlMs);
  return allData;
}

export async function esiPost<T>(
  esiPath: string,
  body: unknown,
  opts?: EsiRequestOptions
): Promise<T> {
  const url = `${ESI_BASE}${esiPath}`;
  const { token } = await getValidToken(opts?.characterId);

  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  }, esiPath);

  return handleResponse<T>(response, esiPath);
}

export async function esiDelete(
  esiPath: string,
  opts?: EsiRequestOptions
): Promise<void> {
  const url = `${ESI_BASE}${esiPath}`;
  const { token } = await getValidToken(opts?.characterId);

  const response = await fetchWithRetry(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  }, esiPath);

  await handleResponse<void>(response, esiPath);
}

export async function getActiveCharacter(
  characterId?: number
): Promise<StoredCharacter> {
  const { character } = await getValidToken(characterId);
  return character;
}
