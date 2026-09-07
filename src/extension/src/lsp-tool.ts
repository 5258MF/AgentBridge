import { realpath } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";

const HARD_MAX_RESULTS = 500;
const MAX_OUTPUT_CHARS = 64_000;
const MAX_HOVER_ITEM_CHARS = 16_000;
const WORKSPACE_SYMBOL_WARMUP_MAX_CANDIDATES = 64;
const WORKSPACE_SYMBOL_WARMUP_MAX_DOCUMENTS = 3;
const WORKSPACE_SYMBOL_SOURCE_EXTENSIONS = "{ts,tsx,js,jsx,mts,cts,mjs,cjs,py,pyi,go,rs,java,kt,kts,cs,c,cc,cpp,cxx,h,hpp,hxx,rb,php,swift,scala,lua}";
const WORKSPACE_SYMBOL_EXCLUDE_GLOB = "{**/.git/**,**/.carrier/**,**/node_modules/**,**/dist/**,**/build/**,**/coverage/**,**/.next/**,**/target/**,**/vendor/**}";

type LspOperation =
  | "workspace_symbols"
  | "document_symbols"
  | "definition"
  | "references"
  | "implementation"
  | "hover";

type LspProviderState = "ready" | "warming" | "unavailable" | "unknown";

type LspProjectAnchorSource = "explicit" | "warmup_candidate" | "none";

interface LspProviderMetadata {
  providerState: LspProviderState;
  providerStateBasis: "semantic_results" | "public_api_ambiguous_empty_result" | "explicit_unavailable";
  projectAnchor?: string;
  projectAnchorSource: LspProjectAnchorSource;
  warmupPerformed: boolean;
  semanticResultInconclusive: boolean;
}

interface LspLocationRow {
  uri: vscode.Uri;
  range: vscode.Range;
  selectionRange?: vscode.Range;
  originSelectionRange?: vscode.Range;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, Number(value)));
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("No workspace folder is open.");
  return folder.uri.fsPath;
}

function isInside(root: string, candidate: string): boolean {
  const rootResolved = path.resolve(root);
  const candidateResolved = path.resolve(candidate);
  const rootCmp = process.platform === "win32" ? rootResolved.toLowerCase() : rootResolved;
  const candidateCmp = process.platform === "win32" ? candidateResolved.toLowerCase() : candidateResolved;
  return candidateCmp === rootCmp || candidateCmp.startsWith(`${rootCmp}${path.sep}`);
}

async function canonicalWorkspaceRoot(): Promise<string> {
  return realpath(workspaceRoot());
}

async function resolveWorkspaceFile(inputPath: string): Promise<{ root: string; relative: string; uri: vscode.Uri }> {
  const lexicalRoot = workspaceRoot();
  const raw = inputPath.trim();
  if (!raw) throw new Error("path must be a non-empty workspace path");
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  const absolute = path.isAbsolute(raw) || path.isAbsolute(normalized)
    ? path.resolve(raw)
    : path.resolve(lexicalRoot, normalized);
  if (!isInside(lexicalRoot, absolute)) throw new Error(`Path is outside the workspace: ${inputPath}`);
  const [root, target] = await Promise.all([realpath(lexicalRoot), realpath(absolute)]);
  if (!isInside(root, target)) throw new Error(`Path is outside the workspace: ${inputPath}`);
  const relative = path.relative(root, target).replace(/\\/g, "/") || ".";
  return {
    root,
    relative,
    uri: vscode.Uri.file(target),
  };
}

async function resolveWorkspaceCandidate(root: string, uri: vscode.Uri): Promise<{ relative: string; uri: vscode.Uri } | undefined> {
  if (uri.scheme !== "file") return undefined;
  try {
    const target = await realpath(uri.fsPath);
    if (!isInside(root, target)) return undefined;
    return {
      relative: path.relative(root, target).replace(/\\/g, "/") || ".",
      uri: vscode.Uri.file(target),
    };
  } catch {
    return undefined;
  }
}

function symbolQueryTokens(query: string): string[] {
  const expanded = query.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return [...new Set(expanded.split(/[^A-Za-z0-9]+/).map((part) => part.toLowerCase()).filter((part) => part.length >= 3))];
}

function warmupCandidateScore(relativePath: string, query: string, tokens: string[]): number {
  const lowerPath = relativePath.toLowerCase();
  const lowerBase = path.basename(relativePath).toLowerCase();
  const lowerQuery = query.toLowerCase();
  let score = 0;
  if (lowerBase.includes(lowerQuery)) score += 200;
  if (lowerPath.includes(lowerQuery)) score += 100;
  for (const token of tokens) {
    if (lowerBase.includes(token)) score += 30;
    else if (lowerPath.includes(token)) score += 10;
  }
  return score;
}

async function warmWorkspaceSymbolProjects(query: string, anchorPath?: string): Promise<string[]> {
  const root = await canonicalWorkspaceRoot();
  const candidates = new Map<string, vscode.Uri>();
  let searchBase: vscode.Uri | undefined;
  if (anchorPath?.trim()) {
    const anchor = await resolveWorkspaceFile(anchorPath);
    try {
      const stat = await vscode.workspace.fs.stat(anchor.uri);
      if (stat.type & vscode.FileType.Directory) searchBase = anchor.uri;
      else candidates.set(anchor.relative, anchor.uri);
    } catch {
      // Keep the anchor as a project hint even if it disappeared; discovery below may still succeed.
    }
  }

  const tokens = symbolQueryTokens(query);
  for (const token of tokens.slice(0, 3)) {
    const pattern = `**/*${token}*.${WORKSPACE_SYMBOL_SOURCE_EXTENSIONS}`;
    const matches = await vscode.workspace.findFiles(
      searchBase ? new vscode.RelativePattern(searchBase, pattern) : pattern,
      WORKSPACE_SYMBOL_EXCLUDE_GLOB,
      16,
    );
    for (const uri of matches) {
      const candidate = await resolveWorkspaceCandidate(root, uri);
      if (!candidate) continue;
      candidates.set(candidate.relative, candidate.uri);
      if (candidates.size >= WORKSPACE_SYMBOL_WARMUP_MAX_CANDIDATES) break;
    }
    if (candidates.size >= WORKSPACE_SYMBOL_WARMUP_MAX_CANDIDATES) break;
  }

  if (candidates.size < WORKSPACE_SYMBOL_WARMUP_MAX_DOCUMENTS) {
    const broadPattern = `**/*.${WORKSPACE_SYMBOL_SOURCE_EXTENSIONS}`;
    const broadMatches = await vscode.workspace.findFiles(
      searchBase ? new vscode.RelativePattern(searchBase, broadPattern) : broadPattern,
      WORKSPACE_SYMBOL_EXCLUDE_GLOB,
      WORKSPACE_SYMBOL_WARMUP_MAX_CANDIDATES,
    );
    for (const uri of broadMatches) {
      const candidate = await resolveWorkspaceCandidate(root, uri);
      if (!candidate) continue;
      candidates.set(candidate.relative, candidate.uri);
      if (candidates.size >= WORKSPACE_SYMBOL_WARMUP_MAX_CANDIDATES) break;
    }
  }

  const ranked = [...candidates.entries()]
    .map(([relative, uri]) => ({ relative, uri, score: warmupCandidateScore(relative, query, tokens) }))
    .sort((a, b) => b.score - a.score || a.relative.localeCompare(b.relative));
  const warmupLimit = ranked[0]?.score > 0 ? 1 : WORKSPACE_SYMBOL_WARMUP_MAX_DOCUMENTS;

  const opened: string[] = [];
  for (const { relative, uri } of ranked.slice(0, warmupLimit)) {
    try {
      await vscode.workspace.openTextDocument(uri);
      opened.push(relative);
    } catch {
      // A warm-up candidate may become unavailable between discovery and opening.
    }
  }
  return opened;
}

async function resolvePosition(input: Record<string, unknown>): Promise<{ root: string; relative: string; uri: vscode.Uri; position: vscode.Position; languageId: string }> {
  const file = await resolveWorkspaceFile(asString(input.path));
  if (!Number.isInteger(input.line) || Number(input.line) < 1) throw new Error("line must be a 1-based integer >= 1");
  if (!Number.isInteger(input.column) || Number(input.column) < 1) throw new Error("column must be a 1-based integer >= 1");

  const document = await vscode.workspace.openTextDocument(file.uri);
  const lineIndex = Number(input.line) - 1;
  if (lineIndex >= document.lineCount) {
    throw new Error(`line ${input.line} is outside ${file.relative} (line count: ${document.lineCount})`);
  }
  const line = document.lineAt(lineIndex);
  const character = Number(input.column) - 1;
  if (character > line.text.length) {
    throw new Error(`column ${input.column} is outside ${file.relative}:${input.line} (line length: ${line.text.length})`);
  }

  return {
    ...file,
    position: new vscode.Position(lineIndex, character),
    languageId: document.languageId,
  };
}

function operationDefaultMax(operation: LspOperation): number {
  switch (operation) {
    case "definition": return 20;
    case "implementation": return 50;
    case "workspace_symbols": return 50;
    case "hover": return 20;
    case "document_symbols": return 100;
    case "references": return 100;
  }
}

function symbolKindName(kind: vscode.SymbolKind): string {
  const row = Object.entries(vscode.SymbolKind).find(([, value]) => value === kind);
  return row?.[0] ?? String(kind);
}

function uriDisplay(root: string, uri: vscode.Uri): { path: string; workspace: boolean } {
  if (uri.scheme === "file" && isInside(root, uri.fsPath)) {
    return { path: path.relative(root, uri.fsPath).replace(/\\/g, "/"), workspace: true };
  }
  return { path: uri.toString(), workspace: false };
}

function positionText(position: vscode.Position): string {
  return `${position.line + 1}:${position.character + 1}`;
}

function rangeText(range: vscode.Range): string {
  return `${positionText(range.start)}-${positionText(range.end)}`;
}

function locationRow(value: vscode.Location | vscode.LocationLink): LspLocationRow {
  if ("targetUri" in value) {
    return {
      uri: value.targetUri,
      range: value.targetRange,
      selectionRange: value.targetSelectionRange,
      originSelectionRange: value.originSelectionRange,
    };
  }
  return { uri: value.uri, range: value.range };
}

function locationKey(value: LspLocationRow, preferSelection = false): string {
  const range = preferSelection && value.selectionRange ? value.selectionRange : value.range;
  return `${value.uri.toString()}#${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
}

function markdownText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof vscode.MarkdownString) return value.value;
  if (value && typeof value === "object") {
    const row = value as { language?: unknown; value?: unknown };
    if (typeof row.value === "string") {
      return typeof row.language === "string" && row.language
        ? `\`\`\`${row.language}\n${row.value}\n\`\`\``
        : row.value;
    }
  }
  return String(value ?? "");
}

function boundedText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const marker = "\n...[truncated]...\n";
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.floor(budget * 0.4);
  return { text: `${text.slice(0, head)}${marker}${text.slice(-(budget - head))}`, truncated: true };
}

function providerMetadataLines(metadata: LspProviderMetadata): string[] {
  return [
    `provider_state: ${metadata.providerState}`,
    `provider_state_basis: ${metadata.providerStateBasis}`,
    `project_anchor: ${JSON.stringify(metadata.projectAnchor ?? null)}`,
    `project_anchor_source: ${metadata.projectAnchorSource}`,
    `warmup_performed: ${metadata.warmupPerformed}`,
    `semantic_result_inconclusive: ${metadata.semanticResultInconclusive}`,
  ];
}

function resultProviderMetadata(
  resultCount: number,
  projectAnchor?: string,
  projectAnchorSource: LspProjectAnchorSource = projectAnchor ? "explicit" : "none",
): LspProviderMetadata {
  return {
    providerState: resultCount > 0 ? "ready" : "unknown",
    providerStateBasis: resultCount > 0 ? "semantic_results" : "public_api_ambiguous_empty_result",
    projectAnchor,
    projectAnchorSource,
    warmupPerformed: false,
    semanticResultInconclusive: resultCount === 0,
  };
}

function emitEnvelope(
  operation: LspOperation,
  metadata: string[],
  blocks: string[],
  totalResults: number,
  maxResults: number,
): string {
  const selected = blocks.slice(0, maxResults);
  const lines = [
    "=== LSP BEGIN ===",
    `operation: ${operation}`,
    ...metadata,
    `total_results: ${totalResults}`,
    `max_results: ${maxResults}`,
  ];
  let truncated = totalResults > selected.length;
  let used = lines.join("\n").length;
  const emitted: string[] = [];
  for (const block of selected) {
    if (used + block.length + 1 > MAX_OUTPUT_CHARS) {
      truncated = true;
      break;
    }
    emitted.push(block);
    used += block.length + 1;
  }
  return [
    ...lines,
    `returned_results: ${emitted.length}`,
    `truncated: ${truncated}`,
    "--- RESULTS ---",
    ...emitted,
    "=== LSP END ===",
  ].join("\n");
}

function formatLocations(root: string, operation: LspOperation, rows: LspLocationRow[], maxResults: number, metadata: string[]): string {
  const blocks = rows.map((row, index) => {
    const display = uriDisplay(root, row.uri);
    return [
      `--- RESULT ${index + 1} ---`,
      `path: ${JSON.stringify(display.path)}`,
      `workspace: ${display.workspace}`,
      `range: ${rangeText(row.range)}`,
      ...(row.selectionRange ? [`selection_range: ${rangeText(row.selectionRange)}`] : []),
      ...(row.originSelectionRange ? [`origin_selection_range: ${rangeText(row.originSelectionRange)}`] : []),
    ].join("\n");
  });
  return emitEnvelope(operation, metadata, blocks, rows.length, maxResults);
}

async function locationOperation(
  operation: "definition" | "references" | "implementation",
  input: Record<string, unknown>,
  maxResults: number,
): Promise<string> {
  const source = await resolvePosition(input);
  const command = operation === "definition"
    ? "vscode.executeDefinitionProvider"
    : operation === "references"
      ? "vscode.executeReferenceProvider"
      : "vscode.executeImplementationProvider";
  const raw = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(command, source.uri, source.position);
  let rows = (raw ?? []).map(locationRow);
  const providerMetadata = resultProviderMetadata(rows.length, source.relative);

  if (operation === "references" && !asBoolean(input.include_declaration, true) && rows.length > 0) {
    const definitions = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(
      "vscode.executeDefinitionProvider",
      source.uri,
      source.position,
    );
    const definitionKeys = new Set((definitions ?? []).map((value) => locationKey(locationRow(value), true)));
    rows = rows.filter((row) => !definitionKeys.has(locationKey(row)));
  }

  return formatLocations(source.root, operation, rows, maxResults, [
    `source: ${JSON.stringify(source.relative)}`,
    `position: ${positionText(source.position)}`,
    `language_id: ${JSON.stringify(source.languageId)}`,
    ...providerMetadataLines(providerMetadata),
    ...(operation === "references" ? [`include_declaration: ${asBoolean(input.include_declaration, true)}`] : []),
  ]);
}

async function workspaceSymbols(input: Record<string, unknown>, maxResults: number): Promise<string> {
  const root = await canonicalWorkspaceRoot();
  const query = asString(input.query).trim();
  if (!query) throw new Error("workspace_symbols requires a non-empty query");

  const anchorPath = asString(input.path).trim();
  const explicitAnchor = anchorPath ? await resolveWorkspaceFile(anchorPath) : undefined;
  let warmupDocuments: string[] = [];

  let symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>("vscode.executeWorkspaceSymbolProvider", query) ?? [];
  const initialResults = symbols.length;
  if (symbols.length === 0) {
    warmupDocuments = await warmWorkspaceSymbolProjects(query, explicitAnchor?.relative);
    if (warmupDocuments.length > 0) {
      symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>("vscode.executeWorkspaceSymbolProvider", query) ?? [];
    }
  }

  const inconclusive = symbols.length === 0;
  const projectAnchor = explicitAnchor?.relative || warmupDocuments[0];
  const projectAnchorSource: LspProjectAnchorSource = explicitAnchor
    ? "explicit"
    : warmupDocuments[0]
      ? "warmup_candidate"
      : "none";
  const providerMetadata: LspProviderMetadata = {
    providerState: symbols.length > 0 ? "ready" : "unknown",
    providerStateBasis: symbols.length > 0 ? "semantic_results" : "public_api_ambiguous_empty_result",
    projectAnchor,
    projectAnchorSource,
    warmupPerformed: warmupDocuments.length > 0,
    semanticResultInconclusive: inconclusive,
  };
  const blocks = symbols.map((symbol, index) => {
    const display = uriDisplay(root, symbol.location.uri);
    return [
      `--- RESULT ${index + 1} ---`,
      `name: ${JSON.stringify(symbol.name)}`,
      `kind: ${symbolKindName(symbol.kind)}`,
      `container: ${JSON.stringify(symbol.containerName || null)}`,
      `path: ${JSON.stringify(display.path)}`,
      `workspace: ${display.workspace}`,
      `range: ${rangeText(symbol.location.range)}`,
    ].join("\n");
  });
  return emitEnvelope("workspace_symbols", [
    `query: ${JSON.stringify(query)}`,
    `anchor_path: ${JSON.stringify(explicitAnchor?.relative ?? null)}`,
    `initial_results: ${initialResults}`,
    `provider_state_before_retry: ${initialResults === 0 && warmupDocuments.length > 0 ? "warming" : "null"}`,
    ...providerMetadataLines(providerMetadata),
    `warmup_attempted: ${warmupDocuments.length > 0}`,
    `warmup_documents: ${JSON.stringify(warmupDocuments)}`,
    ...(inconclusive ? [
      "note: Empty workspace-symbol results do not prove that the symbol is absent. Language providers may only index active/open projects. Fall back to search_files for exact symbol text, or retry with path as a project/file anchor.",
    ] : []),
  ], blocks, symbols.length, maxResults);
}

async function documentSymbols(input: Record<string, unknown>, maxResults: number): Promise<string> {
  const file = await resolveWorkspaceFile(asString(input.path));
  const document = await vscode.workspace.openTextDocument(file.uri);
  const symbols = await vscode.commands.executeCommand<Array<vscode.SymbolInformation | vscode.DocumentSymbol> | undefined>(
    "vscode.executeDocumentSymbolProvider",
    file.uri,
  ) ?? [];
  const blocks = symbols.map((symbol, index) => {
    if ("location" in symbol) {
      const display = uriDisplay(file.root, symbol.location.uri);
      return [
        `--- RESULT ${index + 1} ---`,
        `name: ${JSON.stringify(symbol.name)}`,
        `kind: ${symbolKindName(symbol.kind)}`,
        `container: ${JSON.stringify(symbol.containerName || null)}`,
        `path: ${JSON.stringify(display.path)}`,
        `workspace: ${display.workspace}`,
        `range: ${rangeText(symbol.location.range)}`,
      ].join("\n");
    }
    return [
      `--- RESULT ${index + 1} ---`,
      `name: ${JSON.stringify(symbol.name)}`,
      `kind: ${symbolKindName(symbol.kind)}`,
      `detail: ${JSON.stringify(symbol.detail || null)}`,
      `path: ${JSON.stringify(file.relative)}`,
      "workspace: true",
      `range: ${rangeText(symbol.range)}`,
      `selection_range: ${rangeText(symbol.selectionRange)}`,
    ].join("\n");
  });
  return emitEnvelope("document_symbols", [
    `path: ${JSON.stringify(file.relative)}`,
    `language_id: ${JSON.stringify(document.languageId)}`,
    ...providerMetadataLines(resultProviderMetadata(symbols.length, file.relative)),
  ], blocks, symbols.length, maxResults);
}

async function hover(input: Record<string, unknown>, maxResults: number): Promise<string> {
  const source = await resolvePosition(input);
  const hovers = await vscode.commands.executeCommand<vscode.Hover[] | undefined>("vscode.executeHoverProvider", source.uri, source.position) ?? [];
  let contentTruncated = false;
  const blocks = hovers.map((item, index) => {
    const bounded = boundedText(item.contents.map(markdownText).filter(Boolean).join("\n\n"), MAX_HOVER_ITEM_CHARS);
    contentTruncated ||= bounded.truncated;
    return [
      `--- RESULT ${index + 1} ---`,
      ...(item.range ? [`range: ${rangeText(item.range)}`] : []),
      "--- CONTENT BEGIN ---",
      bounded.text,
      "--- CONTENT END ---",
    ].join("\n");
  });
  return emitEnvelope("hover", [
    `source: ${JSON.stringify(source.relative)}`,
    `position: ${positionText(source.position)}`,
    `language_id: ${JSON.stringify(source.languageId)}`,
    ...providerMetadataLines(resultProviderMetadata(hovers.length, source.relative)),
    `content_truncated: ${contentTruncated}`,
  ], blocks, hovers.length, maxResults);
}

export async function invokeLspTool(input: Record<string, unknown>): Promise<string> {
  const operation = asString(input.operation) as LspOperation;
  const validOperations = new Set<LspOperation>([
    "workspace_symbols",
    "document_symbols",
    "definition",
    "references",
    "implementation",
    "hover",
  ]);
  if (!validOperations.has(operation)) {
    throw new Error(`Unsupported lsp operation: ${JSON.stringify(input.operation)}`);
  }
  const maxResults = asInteger(input.max_results, operationDefaultMax(operation), 1, HARD_MAX_RESULTS);
  switch (operation) {
    case "workspace_symbols": return workspaceSymbols(input, maxResults);
    case "document_symbols": return documentSymbols(input, maxResults);
    case "definition": return locationOperation("definition", input, maxResults);
    case "references": return locationOperation("references", input, maxResults);
    case "implementation": return locationOperation("implementation", input, maxResults);
    case "hover": return hover(input, maxResults);
  }
}

