import fs from "fs";
import path from "path";
import os from "os";
import { refreshAccessToken } from "./oauth.js";
import { getCurrentCharacter, updateTokens, getTokens } from "./tokens.js";
import type { StoredCharacter } from "./tokens.js";

const ESI_BASE = "https://esi.evetech.net/latest";

export interface EsiRequestOptions {
  characterId?: number;
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

async function getValidToken(
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

export async function esiGet<T>(
  esiPath: string,
  opts?: EsiRequestOptions & { public?: boolean }
): Promise<T> {
  const url = `${ESI_BASE}${esiPath}`;
  const headers: Record<string, string> = { Accept: "application/json" };

  if (!opts?.public) {
    const { token } = await getValidToken(opts?.characterId);
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ESI ${esiPath} failed (${response.status}): ${body}`);
  }

  return (await response.json()) as T;
}

export async function getActiveCharacter(
  characterId?: number
): Promise<StoredCharacter> {
  const { character } = await getValidToken(characterId);
  return character;
}
