/**
 * Integration tests for the ListTools handler logic.
 *
 * These tests compose the extracted lib functions with the context-loader
 * to replicate the ListTools handler behavior from index.js, verifying
 * the full integration between HTTP client, schema conversion, and context system.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchUnrealTools,
  checkUnrealConnection,
  convertToMCPSchema,
  convertAnnotations,
} from "../../lib.js";
import {
  installFetchMock,
  installFetchReject,
} from "../helpers/mock-fetch.js";
import {
  UNREAL_STATUS_RESPONSE,
  UNREAL_TOOLS_RESPONSE,
} from "../helpers/fixtures.js";

// Mock fs so context-loader doesn't hit disk
vi.mock("fs", () => ({
  readFileSync: vi.fn(() => "# Mock Context"),
  existsSync: vi.fn(() => true),
}));

import { listCategories } from "../../context-loader.js";

const BASE_URL = "http://localhost:3000";
const TIMEOUT_MS = 5000;

beforeEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Replicate the ListTools handler logic from index.js
 */
async function simulateListTools() {
  const status = await checkUnrealConnection(BASE_URL, TIMEOUT_MS);

  if (!status.connected) {
    return {
      tools: [
        {
          name: "unreal_status",
          description:
            "Check if Unreal Editor is running with the plugin. Currently: NOT CONNECTED. Please start Unreal Editor with the plugin enabled.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  }

  const unrealTools = await fetchUnrealTools(BASE_URL, TIMEOUT_MS);

  const mcpTools = unrealTools.map((tool) => ({
    name: `unreal_${tool.name}`,
    description: `[Unreal Editor] ${tool.description}`,
    inputSchema: convertToMCPSchema(tool.parameters),
    annotations: convertAnnotations(tool.annotations),
  }));

  mcpTools.unshift({
    name: "unreal_status",
    description: `Check Unreal Editor connection status. Currently: CONNECTED to ${status.projectName || "Unknown Project"} (${status.engineVersion || "Unknown"})`,
    inputSchema: { type: "object", properties: {} },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  });

  mcpTools.push({
    name: "unreal_get_ue_context",
    description: `Get Unreal Engine 5.7 API context/documentation. Categories: ${listCategories().join(", ")}.`,
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string" },
        query: { type: "string" },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  });

  return { tools: mcpTools };
}

// ─── Disconnected state ──────────────────────────────────────────────

describe("ListTools — disconnected", () => {
  it("returns only unreal_status tool when Unreal is not connected", async () => {
    installFetchReject(new Error("ECONNREFUSED"));
    const result = await simulateListTools();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("unreal_status");
    expect(result.tools[0].description).toContain("NOT CONNECTED");
  });
});

// ─── Connected state ─────────────────────────────────────────────────

describe("ListTools — connected", () => {
  beforeEach(() => {
    installFetchMock([
      { pattern: "/mcp/status", body: UNREAL_STATUS_RESPONSE },
      { pattern: "/mcp/tools", body: UNREAL_TOOLS_RESPONSE },
    ]);
  });

  it("puts unreal_status first", async () => {
    const result = await simulateListTools();
    expect(result.tools[0].name).toBe("unreal_status");
  });

  it("includes unreal_status description with project info", async () => {
    const result = await simulateListTools();
    expect(result.tools[0].description).toContain("CONNECTED");
    expect(result.tools[0].description).toContain("MyGame");
  });

  it("maps Unreal tools with unreal_ prefix and [Unreal Editor] description", async () => {
    const result = await simulateListTools();
    const spawnTool = result.tools.find((t) => t.name === "unreal_spawn_actor");
    expect(spawnTool).toBeDefined();
    expect(spawnTool.description).toMatch(/^\[Unreal Editor\]/);
  });

  it("puts unreal_get_ue_context last", async () => {
    const result = await simulateListTools();
    const last = result.tools[result.tools.length - 1];
    expect(last.name).toBe("unreal_get_ue_context");
  });

  it("total count = Unreal tools + 2 (status + context)", async () => {
    const result = await simulateListTools();
    const unrealToolCount = UNREAL_TOOLS_RESPONSE.tools.length;
    expect(result.tools).toHaveLength(unrealToolCount + 2);
  });

  it("converts tool parameters to MCP inputSchema", async () => {
    const result = await simulateListTools();
    const spawnTool = result.tools.find((t) => t.name === "unreal_spawn_actor");
    expect(spawnTool.inputSchema.type).toBe("object");
    expect(spawnTool.inputSchema.properties.class_name.type).toBe("string");
    expect(spawnTool.inputSchema.required).toContain("class_name");
  });

  it("converts tool annotations", async () => {
    const result = await simulateListTools();
    const getActors = result.tools.find((t) => t.name === "unreal_get_actors");
    expect(getActors.annotations.readOnlyHint).toBe(true);
    expect(getActors.annotations.destructiveHint).toBe(false);
  });
});

// ─── Empty tools ─────────────────────────────────────────────────────

describe("ListTools — empty tool list from Unreal", () => {
  it("returns just status + context tools when Unreal has no tools", async () => {
    installFetchMock([
      { pattern: "/mcp/status", body: UNREAL_STATUS_RESPONSE },
      { pattern: "/mcp/tools", body: { tools: [] } },
    ]);
    const result = await simulateListTools();
    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe("unreal_status");
    expect(result.tools[1].name).toBe("unreal_get_ue_context");
  });
});
