import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";

export function registerIndustryTools(server: McpServer): void {
  server.tool(
    "get_blueprint",
    "Get Eve Online blueprint details — materials, products, skills, and time for all activities (manufacturing, invention, copying, ME/TE research, reaction).",
    {
      blueprint_type_id: z.number().describe("typeID of the blueprint"),
    },
    async ({ blueprint_type_id }) => {
      const db = getDatabase();

      const blueprint = db
        .prepare(
          `SELECT t.typeID, t.typeName
           FROM invTypes t
           WHERE t.typeID = ?`
        )
        .get(blueprint_type_id);

      if (!blueprint) {
        return { content: [{ type: "text", text: `Blueprint ${blueprint_type_id} not found.` }] };
      }

      const ACTIVITY_NAMES: Record<number, string> = {
        1: "Manufacturing",
        3: "Researching Time Efficiency",
        4: "Researching Material Efficiency",
        5: "Copying",
        7: "Reverse Engineering",
        8: "Invention",
        9: "Reactions",
        11: "Reactions",
      };

      const activities = db
        .prepare("SELECT activityID, time FROM industryActivity WHERE typeID = ?")
        .all(blueprint_type_id)
        .map((r: any) => ({ ...r, activityName: ACTIVITY_NAMES[r.activityID] ?? `Activity ${r.activityID}` }));

      const materials = db
        .prepare(
          `SELECT iam.activityID, iam.materialTypeID,
                  t.typeName as materialName, iam.quantity
           FROM industryActivityMaterials iam
           JOIN invTypes t ON iam.materialTypeID = t.typeID
           WHERE iam.typeID = ?
           ORDER BY iam.activityID, t.typeName`
        )
        .all(blueprint_type_id)
        .map((r: any) => ({ ...r, activityName: ACTIVITY_NAMES[r.activityID] ?? `Activity ${r.activityID}` }));

      const products = db
        .prepare(
          `SELECT iap.activityID, iap.productTypeID,
                  t.typeName as productName, iap.quantity
           FROM industryActivityProducts iap
           JOIN invTypes t ON iap.productTypeID = t.typeID
           WHERE iap.typeID = ?`
        )
        .all(blueprint_type_id)
        .map((r: any) => ({ ...r, activityName: ACTIVITY_NAMES[r.activityID] ?? `Activity ${r.activityID}` }));

      const skills = db
        .prepare(
          `SELECT ias.activityID, ias.skillID,
                  t.typeName as skillName, ias.level
           FROM industryActivitySkills ias
           JOIN invTypes t ON ias.skillID = t.typeID
           WHERE ias.typeID = ?`
        )
        .all(blueprint_type_id)
        .map((r: any) => ({ ...r, activityName: ACTIVITY_NAMES[r.activityID] ?? `Activity ${r.activityID}` }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ blueprint, activities, materials, products, skills }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "search_blueprints",
    "Search for Eve Online blueprints by product name. Find what blueprint makes a given item.",
    {
      product_name: z.string().describe("Name of the product to find blueprints for"),
      limit: z.number().default(10).describe("Max results"),
    },
    async ({ product_name, limit }) => {
      const db = getDatabase();
      const rows = db
        .prepare(
          `SELECT iap.typeID as blueprintTypeID, bp.typeName as blueprintName,
                  iap.productTypeID, p.typeName as productName,
                  iap.quantity, iap.activityID
           FROM industryActivityProducts iap
           JOIN invTypes bp ON iap.typeID = bp.typeID
           JOIN invTypes p ON iap.productTypeID = p.typeID
           WHERE p.typeName LIKE ?
           ORDER BY p.typeName
           LIMIT ?`
        )
        .all(`%${product_name}%`, limit);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }
  );
}
