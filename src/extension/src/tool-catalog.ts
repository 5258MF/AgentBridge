/**
 * Renders the MCP tool surface as Markdown for docs/tool-catalog.md.
 *
 * The catalog is generated from the same definitions that tools/list serves, so documentation
 * cannot drift from what clients actually receive. tests/tool-catalog.test.ts fails when the
 * committed file is stale; `npm run tool-catalog` regenerates it.
 */

export interface CatalogTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
}

export interface CatalogOptions {
  /** Tools blocked at call time in Plan mode (read-only mode). */
  readonly readOnlyBlocked: ReadonlySet<string>;
  /** Tools that only accept allowlisted input in Plan mode (run_command). */
  readonly planRestricted: ReadonlySet<string>;
}

function planModeCell(name: string, options: CatalogOptions): string {
  if (options.readOnlyBlocked.has(name)) return "blocked";
  if (options.planRestricted.has(name)) return "allowlisted commands only";
  return "available";
}

type JsonSchema = Record<string, unknown>;

function cell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function schemaType(schema: JsonSchema): string {
  if (schema.type === "array") {
    const items = (schema.items ?? {}) as JsonSchema;
    return `array<${schemaType(items)}>`;
  }
  if (schema.type === "object" && schema.additionalProperties && typeof schema.additionalProperties === "object") {
    return `map<string, ${schemaType(schema.additionalProperties as JsonSchema)}>`;
  }
  return typeof schema.type === "string" ? schema.type : "any";
}

function constraints(schema: JsonSchema): string {
  const parts: string[] = [];
  if (Array.isArray(schema.enum)) parts.push(`one of: ${schema.enum.map((value) => `\`${String(value)}\``).join(", ")}`);
  if (schema.type === "array" && schema.items && Array.isArray((schema.items as JsonSchema).enum)) {
    parts.push(`items one of: ${((schema.items as JsonSchema).enum as unknown[]).map((value) => `\`${String(value)}\``).join(", ")}`);
  }
  for (const [key, label] of [
    ["minimum", "min"],
    ["maximum", "max"],
    ["minLength", "min length"],
    ["maxLength", "max length"],
    ["minItems", "min items"],
    ["maxItems", "max items"],
  ] as const) {
    if (typeof schema[key] === "number") parts.push(`${label} ${String(schema[key])}`);
  }
  if (schema.uniqueItems === true) parts.push("unique items");
  if (typeof schema.pattern === "string") parts.push(`pattern \`${schema.pattern}\``);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    const valuePattern = (schema.additionalProperties as JsonSchema).pattern;
    if (typeof valuePattern === "string") parts.push(`values match \`${valuePattern}\``);
  }
  return parts.join("; ");
}

function parameterRows(schema: JsonSchema, prefix = ""): string[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const rows: string[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const qualified = `${prefix}${name}`;
    const defaultValue = property.default === undefined ? "" : `\`${JSON.stringify(property.default)}\``;
    const description = typeof property.description === "string" ? property.description : "";
    rows.push(`| \`${qualified}\` | ${cell(schemaType(property))} | ${required.has(name) ? "yes" : "no"} | ${defaultValue} | ${cell(constraints(property))} | ${cell(description)} |`);
    const items = property.type === "array" ? (property.items as JsonSchema | undefined) : undefined;
    if (items?.type === "object" && items.properties) rows.push(...parameterRows(items, `${qualified}[].`));
  }
  return rows;
}

export function renderToolCatalog(tools: readonly CatalogTool[], options: CatalogOptions): string {
  const lines: string[] = [
    "# AgentBridge MCP tool catalog",
    "",
    "<!-- Generated from the tool definitions by `npm run tool-catalog`. Do not edit by hand: tests/tool-catalog.test.ts fails when this file is stale. -->",
    "",
    "This is exactly what MCP clients receive from `tools/list`. In `run_command`, `${RUNTIME_SHELL_DESCRIPTION}` and `${RUNTIME_SHELL_SYNTAX_HINT}` are replaced at runtime with the configured managed shell.",
    "",
    `${tools.length} tools, listed in both Plan and Build mode. In Plan mode (read-only), ${tools.filter((tool) => options.readOnlyBlocked.has(tool.name)).length} are blocked at call time and ${tools.filter((tool) => options.planRestricted.has(tool.name)).map((tool) => `\`${tool.name}\``).join(", ")} only runs allowlisted read-only commands.`,
    "",
    "| Tool | Plan mode | Required parameters |",
    "|---|---|---|",
  ];
  for (const tool of tools) {
    const schema = tool.inputSchema as JsonSchema;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    lines.push(`| [\`${tool.name}\`](#${tool.name}) | ${planModeCell(tool.name, options)} | ${required.length ? required.map((name) => `\`${name}\``).join(", ") : "(none)"} |`);
  }
  for (const tool of tools) {
    const rows = parameterRows(tool.inputSchema as JsonSchema);
    lines.push(
      "",
      `<a id="${tool.name}"></a>`,
      `## \`${tool.name}\``,
      "",
      "```text",
      tool.description,
      "```",
      "",
    );
    if (rows.length) {
      lines.push("| Parameter | Type | Required | Default | Constraints | Description |", "|---|---|---|---|---|---|", ...rows);
    } else {
      lines.push("No parameters.");
    }
  }
  return `${lines.join("\n")}\n`;
}
