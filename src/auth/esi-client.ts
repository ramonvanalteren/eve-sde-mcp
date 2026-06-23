import fs from "fs";
import path from "path";
import os from "os";
import { refreshAccessToken } from "./oauth.js";
import { getCurrentCharacter, updateTokens, getTokens } from "./tokens.js";
import type { StoredCharacter } from "./tokens.js";

const ESI_BASE = "https://esi.evetech.net/latest";

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
  if (character.expiresAt.getTime() - Date.now() < fiveMinutes) {
    const clientId = readClientId();
    const newTokens = await refreshAccessToken(character.refreshToken, clientId);
    updateTokens(character.characterId, newTokens);
    character = getTokens(character.characterId)!;
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

  return (await response.json()) as T;
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
  const response = await fetch(url, { headers });
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

  const firstResponse = await fetch(url, { headers });
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
      fetch(pageUrl, { headers }).then((r) => handleResponse<T[]>(r, esiPath))
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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  return handleResponse<T>(response, esiPath);
}

export async function esiDelete(
  esiPath: string,
  opts?: EsiRequestOptions
): Promise<void> {
  const url = `${ESI_BASE}${esiPath}`;
  const { token } = await getValidToken(opts?.characterId);

  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  checkRateLimit(response, esiPath);

  if (response.status === 420) {
    const reset = response.headers.get("x-esi-error-limit-reset") ?? "unknown";
    throw new Error(`ESI rate limited on ${esiPath}. Retry after ${reset} seconds.`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ESI DELETE ${esiPath} failed (${response.status}): ${body}`);
  }
}

export async function getActiveCharacter(
  characterId?: number
): Promise<StoredCharacter> {
  const { character } = await getValidToken(characterId);
  return character;
}
