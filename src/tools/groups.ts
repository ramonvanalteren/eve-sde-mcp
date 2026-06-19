import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatabase } from "../database.js";

export function registerGroupTools(server: McpServer): void {
  server.tool(
    "get_group",
    "Get an Eve Online inventory group by ID or name, with all types in that group.",
    {
      group_id: z.number().optional().describe("groupID to look up"),
      name: z.string().optional().describe("Group name to search for (if group_id not provided)"),
      include_types: z.boolean().default(true).describe("Include all types in this group"),
    },
    async ({ group_id, name, include_types }) => {
      const db = getDatabase();

      let group: unknown;
      if (group_id) {
        group = db
          .prepare(
            `SELECT g.*, c.categoryName
             FROM invGroups g
             JOIN invCategories c ON g.categoryID = c.categoryID
             WHERE g.groupID = ?`
          )
          .get(group_id);
      } else if (name) {
        group = db
          .prepare(
            `SELECT g.*, c.categoryName
             FROM invGroups g
             JOIN invCategories c ON g.categoryID = c.categoryID
             WHERE g.groupName LIKE ?`
          )
          .get(`%${name}%`);
      } else {
        return { content: [{ type: "text", text: "Provide either group_id or name." }] };
      }

      if (!group) {
        return { content: [{ type: "text", text: "Group not found." }] };
      }

      const result: Record<string, unknown> = { group };

      if (include_types) {
        const types = db
          .prepare(
            `SELECT typeID, typeName, published
             FROM invTypes
             WHERE groupID = ? AND published = 1
             ORDER BY typeName`
          )
          .all((group as any).groupID);
        result.types = types;
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_category",
    "Get an Eve Online inventory category (e.g. Ship, Module, Drone, Charge) with its child groups.",
    {
      category_id: z.number().optional().describe("categoryID to look up"),
      name: z
        .string()
        .optional()
        .describe("Category name to search for (if category_id not provided)"),
    },
    async ({ category_id, name }) => {
      const db = getDatabase();

      let category: unknown;
      if (category_id) {
        category = db.prepare("SELECT * FROM invCategories WHERE categoryID = ?").get(category_id);
      } else if (name) {
        category = db
          .prepare("SELECT * FROM invCategories WHERE categoryName LIKE ?")
          .get(`%${name}%`);
      } else {
        return { content: [{ type: "text", text: "Provide either category_id or name." }] };
      }

      if (!category) {
        return { content: [{ type: "text", text: "Category not found." }] };
      }

      const groups = db
        .prepare(
          `SELECT groupID, groupName, published
           FROM invGroups
           WHERE categoryID = ? AND published = 1
           ORDER BY groupName`
        )
        .all((category as any).categoryID);

      return {
        content: [{ type: "text", text: JSON.stringify({ category, groups }, null, 2) }],
      };
    }
  );

  server.tool(
    "get_market_group",
    "Navigate the Eve Online market group tree. Returns group info and children (subgroups or types).",
    {
      market_group_id: z
        .number()
        .optional()
        .describe("marketGroupID. Omit to get top-level market groups."),
    },
    async ({ market_group_id }) => {
      const db = getDatabase();

      if (market_group_id === undefined) {
        const topLevel = db
          .prepare(
            `SELECT marketGroupID, marketGroupName, description
             FROM invMarketGroups
             WHERE parentGroupID IS NULL
             ORDER BY marketGroupName`
          )
          .all();
        return { content: [{ type: "text", text: JSON.stringify(topLevel, null, 2) }] };
      }

      const group = db
        .prepare("SELECT * FROM invMarketGroups WHERE marketGroupID = ?")
        .get(market_group_id);

      if (!group) {
        return { content: [{ type: "text", text: "Market group not found." }] };
      }

      const children = db
        .prepare(
          `SELECT marketGroupID, marketGroupName, description
           FROM invMarketGroups
           WHERE parentGroupID = ?
           ORDER BY marketGroupName`
        )
        .all(market_group_id);

      const types = db
        .prepare(
          `SELECT typeID, typeName
           FROM invTypes
           WHERE marketGroupID = ? AND published = 1
           ORDER BY typeName`
        )
        .all(market_group_id);

      return {
        content: [
          { type: "text", text: JSON.stringify({ group, childGroups: children, types }, null, 2) },
        ],
      };
    }
  );
}
