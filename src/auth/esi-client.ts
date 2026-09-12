import fs from "fs";
import path from "path";
import os from "os";
import { refreshAccessToken, startLoginFlow, waitForLogin } from "./oauth.js";
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

/** The error a caller sees when a token refresh fails. */
export function refreshFailureMessage(characterName: string, underlyingMsg: string, autoLoginStarted: boolean): string {
  return (
    `Token refresh failed for ${characterName}: ${underlyingMsg}. ` +
    (autoLoginStarted
      ? `A login page has been opened in your browser — authenticate as ${characterName}, then re-run this tool.`
      : `Use the esi_login tool to re-authenticate.`)
  );
}

// Auto-login: when a tool call hits a definitively dead refresh token, open
// the SSO login flow in the browser instead of only suggesting it. The
// triggering tool call still fails immediately (no 5-minute hang); a
// background continuation stores the tokens once the user authenticates and
// logs completion to stderr. Cooldown keeps a retry loop of failing tool
// calls from opening a browser tab every time.
let lastAutoLoginAt = 0;
const AUTO_LOGIN_COOLDOWN_MS = 60_000;

async function triggerAutoLogin(): Promise<boolean> {
  if (Date.now() - lastAutoLoginAt < AUTO_LOGIN_COOLDOWN_MS) return false;
  lastAutoLoginAt = Date.now();
  let clientId: string;
  try {
    clientId = readClientId();
  } catch {
    return false; // no client id configured — a manual esi_login with client_id is needed
  }
  try {
    const { authUrl } = startLoginFlow(clientId);
    try {
      const { execFile } = await import("child_process");
      execFile("open", [authUrl], () => {
        // best-effort; if the browser didn't open, the URL is in the error text
      });
    } catch {
      // best-effort
    }
    void waitForLogin().then(
      (result) => {
        storeTokens(result.tokens, result.character);
        setCurrentCharacterId(result.character.characterId);
        process.stderr.write(
          `[auto-login] Authenticated as ${result.character.characterName} — token fixed; re-run the tool that failed.\n`
        );
      },
      (err) => {
        process.stderr.write(
          `[auto-login] Login flow ended without success: ${err instanceof Error ? err.message : String(err)}\n`
        );
      }
    );
    return true;
  } catch (err) {
    process.stderr.write(
      `[auto-login] Could not start login flow: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return false;
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
      const autoLogin = isDeadRefreshToken(msg) ? await triggerAutoLogin() : false;
      throw new Error(refreshFailureMessage(character.characterName, msg, autoLogin));
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
