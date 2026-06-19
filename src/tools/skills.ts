import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";
import { esiGet, getActiveCharacter } from "../auth/esi-client.js";

interface EsiSkill {
  skill_id: number;
  active_skill_level: number;
  trained_skill_level: number;
  skillpoints_in_skill: number;
}

interface EsiSkillsResponse {
  skills: EsiSkill[];
  total_sp: number;
  unallocated_sp?: number;
}

interface EsiQueueEntry {
  skill_id: number;
  finished_level: number;
  queue_position: number;
  start_date?: string;
  finish_date?: string;
  level_start_sp?: number;
  level_end_sp?: number;
  training_start_sp?: number;
}

interface EsiAttributes {
  charisma: number;
  intelligence: number;
  memory: number;
  perception: number;
  willpower: number;
  bonus_remaps?: number;
  last_remap_date?: string;
  accrued_remap_cooldown_date?: string;
}

const SKILL_REQ_ATTRS = [
  { skillAttr: 182, levelAttr: 277 },
  { skillAttr: 183, levelAttr: 278 },
  { skillAttr: 184, levelAttr: 279 },
  { skillAttr: 1285, levelAttr: 1286 },
  { skillAttr: 1289, levelAttr: 1287 },
  { skillAttr: 1290, levelAttr: 1288 },
];

export function registerSkillTools(server: McpServer): void {
  server.tool(
    "get_character_skills",
    "Get all trained skills for the authenticated character, enriched with skill names and group names from the SDE.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
      group: z.string().optional().describe("Filter by skill group name (e.g. 'Spaceship Command', 'Gunnery')"),
      min_level: z.number().optional().describe("Only show skills at or above this trained level"),
    },
    async ({ character_id, group, min_level }) => {
      const char = await getActiveCharacter(character_id);
      const data = await esiGet<EsiSkillsResponse>(
        `/characters/${char.characterId}/skills/`,
        { characterId: char.characterId }
      );

      const db = getDatabase();

      let skills = data.skills.map((s) => {
        const typeInfo = db
          .prepare(
            `SELECT t.typeName, g.groupName
             FROM invTypes t
             JOIN invGroups g ON t.groupID = g.groupID
             WHERE t.typeID = ?`
          )
          .get(s.skill_id) as { typeName: string; groupName: string } | undefined;

        return {
          skillId: s.skill_id,
          skillName: typeInfo?.typeName ?? `Unknown(${s.skill_id})`,
          groupName: typeInfo?.groupName ?? "Unknown",
          trainedLevel: s.trained_skill_level,
          activeLevel: s.active_skill_level,
          skillpoints: s.skillpoints_in_skill,
        };
      });

      if (group) {
        skills = skills.filter((s) => s.groupName.toLowerCase().includes(group.toLowerCase()));
      }
      if (min_level !== undefined) {
        skills = skills.filter((s) => s.trainedLevel >= min_level);
      }

      skills.sort((a, b) => a.groupName.localeCompare(b.groupName) || a.skillName.localeCompare(b.skillName));

      const result = {
        characterName: char.characterName,
        characterId: char.characterId,
        totalSP: data.total_sp,
        unallocatedSP: data.unallocated_sp ?? 0,
        skillCount: skills.length,
        skills,
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_skill_queue",
    "Get the current skill training queue for the authenticated character, enriched with skill names from the SDE.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ character_id }) => {
      const char = await getActiveCharacter(character_id);
      const queue = await esiGet<EsiQueueEntry[]>(
        `/characters/${char.characterId}/skillqueue/`,
        { characterId: char.characterId }
      );

      const db = getDatabase();

      const enriched = queue.map((entry) => {
        const typeInfo = db
          .prepare("SELECT typeName FROM invTypes WHERE typeID = ?")
          .get(entry.skill_id) as { typeName: string } | undefined;

        return {
          position: entry.queue_position,
          skillId: entry.skill_id,
          skillName: typeInfo?.typeName ?? `Unknown(${entry.skill_id})`,
          targetLevel: entry.finished_level,
          startDate: entry.start_date ?? null,
          finishDate: entry.finish_date ?? null,
        };
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { characterName: char.characterName, queueLength: enriched.length, queue: enriched },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_character_attributes",
    "Get character attributes (intelligence, memory, perception, willpower, charisma) and remap info. These affect skill training speed.",
    {
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ character_id }) => {
      const char = await getActiveCharacter(character_id);
      const attrs = await esiGet<EsiAttributes>(
        `/characters/${char.characterId}/attributes/`,
        { characterId: char.characterId }
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ characterName: char.characterName, ...attrs }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "check_skill_requirements",
    "Check which skills are required for a ship or module and whether the authenticated character meets them. Shows trained vs required levels and identifies gaps.",
    {
      type_id: z.number().describe("typeID of the ship or module to check requirements for"),
      character_id: z.number().optional().describe("Character ID (uses active character if omitted)"),
    },
    async ({ type_id, character_id }) => {
      const db = getDatabase();
      const char = await getActiveCharacter(character_id);
      const skillData = await esiGet<EsiSkillsResponse>(
        `/characters/${char.characterId}/skills/`,
        { characterId: char.characterId }
      );

      const trainedMap = new Map<number, number>();
      for (const s of skillData.skills) {
        trainedMap.set(s.skill_id, s.trained_skill_level);
      }

      const typeInfo = db
        .prepare(
          `SELECT t.typeName, g.groupName, c.categoryName
           FROM invTypes t
           JOIN invGroups g ON t.groupID = g.groupID
           JOIN invCategories c ON g.categoryID = c.categoryID
           WHERE t.typeID = ?`
        )
        .get(type_id) as { typeName: string; groupName: string; categoryName: string } | undefined;

      if (!typeInfo) {
        return { content: [{ type: "text", text: `Type ${type_id} not found.` }] };
      }

      const requirements: Array<{
        skillId: number;
        skillName: string;
        requiredLevel: number;
        trainedLevel: number;
        met: boolean;
      }> = [];

      for (const { skillAttr, levelAttr } of SKILL_REQ_ATTRS) {
        const skillRow = db
          .prepare(
            "SELECT COALESCE(valueFloat, valueInt) as value FROM dgmTypeAttributes WHERE typeID = ? AND attributeID = ?"
          )
          .get(type_id, skillAttr) as { value: number } | undefined;

        if (!skillRow || skillRow.value === 0) continue;

        const levelRow = db
          .prepare(
            "SELECT COALESCE(valueFloat, valueInt) as value FROM dgmTypeAttributes WHERE typeID = ? AND attributeID = ?"
          )
          .get(type_id, levelAttr) as { value: number } | undefined;

        const requiredSkillId = Math.round(skillRow.value);
        const requiredLevel = levelRow ? Math.round(levelRow.value) : 1;

        const skillName = db
          .prepare("SELECT typeName FROM invTypes WHERE typeID = ?")
          .get(requiredSkillId) as { typeName: string } | undefined;

        const trainedLevel = trainedMap.get(requiredSkillId) ?? 0;

        requirements.push({
          skillId: requiredSkillId,
          skillName: skillName?.typeName ?? `Unknown(${requiredSkillId})`,
          requiredLevel,
          trainedLevel,
          met: trainedLevel >= requiredLevel,
        });
      }

      const allMet = requirements.every((r) => r.met);
      const missing = requirements.filter((r) => !r.met);

      const result = {
        type: { typeId: type_id, typeName: typeInfo.typeName, group: typeInfo.groupName, category: typeInfo.categoryName },
        characterName: char.characterName,
        allRequirementsMet: allMet,
        requirements,
        ...(missing.length > 0 ? { missingSkills: missing } : {}),
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
