import { z } from "zod";
import fs from "fs";
import path from "path";
import os from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startLoginFlow, waitForLogin } from "../auth/oauth.js";
import {
  storeTokens,
  listCharacters,
  removeTokens,
  getCurrentCharacter,
  setCurrentCharacterId,
} from "../auth/tokens.js";
import { readClientId } from "../auth/esi-client.js";
import { getSdeDir } from "../database.js";

export function registerAuthTools(server: McpServer): void {
  server.tool(
    "esi_login",
    "Start EVE SSO login. Opens a browser URL for authentication. After the user authenticates, tokens are stored locally. Call this, then tell the user to open the URL in their browser.",
    {
      client_id: z
        .string()
        .optional()
        .describe("EVE SSO Client ID. Falls back to ~/.eve-sde/config.json if not provided."),
    },
    async ({ client_id }) => {
      let clientId = client_id;
      if (!clientId) {
        try {
          clientId = readClientId();
        } catch {
          return {
            content: [
              {
                type: "text",
                text: "No client_id provided and no config.json found at ~/.eve-sde/config.json. Please provide a client_id parameter or create the config file with: { \"clientId\": \"your_id\" }",
              },
            ],
          };
        }
      }

      // Save client ID to config if not already there
      const configPath = path.join(getSdeDir(), "config.json");
      if (!fs.existsSync(configPath)) {
        fs.mkdirSync(getSdeDir(), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({ clientId }, null, 2));
      }

      const { authUrl } = startLoginFlow(clientId);

      // Try to open browser
      try {
        const { exec } = await import("child_process");
        exec(`open "${authUrl}"`);
      } catch {
        // Browser open is best-effort
      }

      // Wait for the callback in the background
      waitForLogin()
        .then((result) => {
          storeTokens(result.tokens, result.character);
          setCurrentCharacterId(result.character.characterId);
          process.stderr.write(
            `Authenticated as ${result.character.characterName} (${result.character.characterId})\n`
          );
        })
        .catch((err) => {
          process.stderr.write(`Login failed: ${err}\n`);
        });

      return {
        content: [
          {
            type: "text",
            text: `Opening EVE SSO login in your browser. If it didn't open automatically, visit:\n\n${authUrl}\n\nAfter authenticating, use esi_status to confirm the login succeeded.`,
          },
        ],
      };
    }
  );

  server.tool(
    "esi_status",
    "Show ESI authentication status — authenticated characters, token expiry, and scopes.",
    {},
    async () => {
      const characters = listCharacters();
      if (characters.length === 0) {
        return {
          content: [
            { type: "text", text: "No authenticated characters. Use esi_login to authenticate." },
          ],
        };
      }

      const current = getCurrentCharacter();
      const result = {
        currentCharacter: current
          ? { name: current.characterName, id: current.characterId }
          : null,
        characters: characters.map((c) => ({
          characterId: c.characterId,
          characterName: c.characterName,
          tokenExpiry: c.expiresAt.toISOString(),
          tokenExpired: c.expiresAt < new Date(),
          scopes: c.scopes,
        })),
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "esi_logout",
    "Remove stored tokens for a character.",
    {
      character_id: z.number().describe("Character ID to log out"),
    },
    async ({ character_id }) => {
      removeTokens(character_id);
      return {
        content: [{ type: "text", text: `Logged out character ${character_id}.` }],
      };
    }
  );

  server.tool(
    "esi_switch_character",
    "Switch the active character for ESI queries.",
    {
      character_id: z.number().describe("Character ID to switch to"),
    },
    async ({ character_id }) => {
      const characters = listCharacters();
      const match = characters.find((c) => c.characterId === character_id);
      if (!match) {
        return {
          content: [
            {
              type: "text",
              text: `Character ${character_id} not found. Authenticated characters: ${characters.map((c) => `${c.characterName} (${c.characterId})`).join(", ") || "none"}`,
            },
          ],
        };
      }
      setCurrentCharacterId(character_id);
      return {
        content: [
          { type: "text", text: `Switched to ${match.characterName} (${match.characterId}).` },
        ],
      };
    }
  );
}
