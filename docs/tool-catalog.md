# AgentBridge MCP tool catalog

<!-- Generated from the tool definitions by `npm run tool-catalog`. Do not edit by hand: tests/tool-catalog.test.ts fails when this file is stale. -->

This is exactly what MCP clients receive from `tools/list`. In `run_command`, `${RUNTIME_SHELL_DESCRIPTION}` and `${RUNTIME_SHELL_SYNTAX_HINT}` are replaced at runtime with the configured managed shell.

14 tools, listed in both Plan and Build mode. In Plan mode (read-only), 3 are blocked at call time and `run_command` only runs allowlisted read-only commands.

| Tool | Plan mode | Required parameters |
|---|---|---|
| [`apply_patch`](#apply_patch) | blocked | `patch` |
| [`find_files`](#find_files) | available | `patterns` |
| [`read_files`](#read_files) | available | `files` |
| [`read_image_file`](#read_image_file) | available | `path` |
| [`search_files`](#search_files) | available | `pattern` |
| [`list_directory`](#list_directory) | available | (none) |
| [`run_command`](#run_command) | allowlisted commands only | `command`, `background` |
| [`get_command_output`](#get_command_output) | available | `command_id` |
| [`send_command_input`](#send_command_input) | blocked | `command_id`, `input` |
| [`terminate_command`](#terminate_command) | blocked | `command_id` |
| [`get_diagnostics`](#get_diagnostics) | available | (none) |
| [`lsp`](#lsp) | available | `operation` |
| [`set_todos`](#set_todos) | available | `todos` |
| [`report_progress`](#report_progress) | available | `message` |

<a id="apply_patch"></a>
## `apply_patch`

Apply a structured multi-file patch directly inside the current workspace. Use this as the primary workspace edit tool. Prefer one apply_patch call containing related file edits instead of many small write calls. Patch syntax starts with '*** Begin Patch' and ends with '*** End Patch'. Supported directives are '*** Update File:', optional immediate '*** Move to:', '*** Add File:', and '*** Delete File:'. Update hunks start with '@@' and use unchanged lines prefixed by one space, removed lines prefixed by '-', and added lines prefixed by '+'. Update hunk old/context lines must match exactly and uniquely. If context is stale or ambiguous the patch fails without partial application; re-read the file and regenerate the patch. When read_files has returned version hashes for files you are modifying, pass them in expected_versions keyed by file path. A mismatch returns STALE_FILE instead of editing a file that changed after it was read. Returns the actual unified diff produced by the applied workspace changes.

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `patch` | string | yes |  | min length 1 | Structured patch text using *** Begin Patch / *** End Patch and Add/Update/Delete/Move directives. |
| `expected_versions` | map<string, string> | no |  | values match `^sha256:` | Optional map from existing file paths to sha256:... versions previously returned by read_files. Strongly recommended whenever those versions are available. |

<a id="find_files"></a>
## `find_files`

Find files by path/name glob patterns inside the current workspace; this does not search file contents. Use find_files when you know a filename, extension, or path shape but not the exact path. Use search_files when you need to search file contents. Batch independent file patterns together in the patterns array (at most 20 patterns) instead of making separate calls. Patterns are evaluated within path, which defaults to the workspace root. Results are files only, never directories. By default matching is case-insensitive, ignored/common generated directories and hidden paths are skipped, and results are sorted by modification time newest first. Use exclude for additional path globs, include_hidden/no_ignore only when those files are intentionally needed, and sort='path_asc' when deterministic path order matters. Results are hard-bounded: at most 5000 candidate paths are collected internally before sorting, and by default only 100 paths are returned (hard maximum 500). If truncated=true, narrow path/patterns before increasing max_results.

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `patterns` | array<string> | yes |  | min items 1; max items 20 | One or more glob patterns to find in a single call, e.g. ['**/*-files.ts', '**/mcp-server.ts']. |
| `path` | string | no |  |  | Optional directory scope relative to the workspace root. Defaults to '.'. |
| `exclude` | array<string> | no |  | max items 50 | Optional glob patterns to exclude from the result. |
| `case_sensitive` | boolean | no |  |  | Whether glob matching is case-sensitive. Defaults to false. |
| `no_ignore` | boolean | no |  |  | Set true to bypass ignore files/common generated-directory excludes. Defaults to false. |
| `include_hidden` | boolean | no |  |  | Set true to include hidden files/directories. Defaults to false. |
| `max_results` | integer | no |  | min 1; max 500 | Maximum file paths returned. Defaults to 100; hard maximum 500. |
| `sort` | string | no |  | one of: `modified_desc`, `path_asc` | Result order. Defaults to modified_desc (newest first); path_asc gives deterministic lexical order. |

<a id="read_files"></a>
## `read_files`

Read one or more UTF-8 text files from the current workspace. Batch independent files together in one call, at most 20 files per call; split larger batches into several calls. For small files, omit start_line/end_line to read the complete file. For large files, results may be truncated and include next_start_line. A satisfied explicit range can still report has_more=true when the file continues afterward. Use 1-based inclusive start_line/end_line for targeted reads. Files at or above the very-large-file threshold require an explicit range. Smaller files may still be automatically truncated by per-file line/byte/token budgets; prefer search_files before targeted reads when location is unknown.

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `files` | array<object> | yes |  | min items 1; max items 20 | Files to read. Independent files should be requested together. |
| `files[].path` | string | yes |  |  | File path relative to the workspace root. |
| `files[].start_line` | integer | no |  | min 1 | Optional 1-based inclusive first line. |
| `files[].end_line` | integer | no |  | min 1 | Optional 1-based inclusive last line. |

<a id="read_image_file"></a>
## `read_image_file`

Read a single raster image file (PNG/JPEG/GIF/WebP/BMP) from the workspace and return an MCP image content block containing the base64-encoded file data. Use this to inspect or reason about screenshots, charts, UI designs, exported diagrams, error dialogs, or other raster images. Supported MIME types: image/png, image/jpeg, image/gif, image/webp, image/bmp. SVG is XML text — use read_files for SVG, not this tool. Hard file-size limit: 5 MB. Larger images must be reduced before reading. Returns a short text summary (path, MIME, size) followed by one image content item for clients that support image input. Paths are workspace-relative; absolute paths are accepted only when they resolve inside the workspace.

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `path` | string | yes |  | min length 1 | Workspace-relative image file path (or absolute path that resolves inside the workspace). |

<a id="search_files"></a>
## `search_files`

Search UTF-8 text file contents inside the current workspace and return bounded path/line/snippet matches. Use this to locate relevant code before calling read_files. Literal search is the default; set is_regex=true only when regular-expression semantics are required. Omit case_sensitive for smart-case (lowercase patterns are case-insensitive; uppercase makes the search case-sensitive). Use path to narrow the directory/file scope and include/exclude glob arrays to filter files. context_lines returns nearby lines for disambiguation; keep it small because search is for locating code, not reading whole files. Results are hard-bounded by per-file/global/output budgets. If truncated=true, narrow the query and search again. By default ignored/common generated directories and hidden paths are skipped.

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `pattern` | string | yes |  | min length 1 | Text or regex pattern to search for. Literal text by default. |
| `path` | string | no |  |  | Optional file or directory scope relative to the workspace root. Defaults to '.'. |
| `is_regex` | boolean | no |  |  | Set true to interpret pattern as a regular expression. Defaults to false (literal search). |
| `case_sensitive` | boolean | no |  |  | Optional case mode. true=sensitive, false=insensitive, omitted=smart-case. |
| `include` | array<string> | no |  |  | Optional glob filters for files to include, e.g. ['**/*.ts', '**/*.tsx']. |
| `exclude` | array<string> | no |  |  | Optional glob filters for files to exclude, e.g. ['**/*.test.ts']. |
| `context_lines` | integer | no |  | min 0; max 5 | Surrounding lines on each side of each match. Defaults to 1, maximum 5. |
| `max_results` | integer | no |  | min 1; max 500 | Maximum matches returned across the call. Defaults to 100; hard maximum 500. |
| `max_matches_per_file` | integer | no |  | min 1; max 100 | Maximum matches returned from one file. Defaults to 20; hard maximum 100. |
| `no_ignore` | boolean | no |  |  | Set true to ignore .gitignore/common excludes. Defaults to false. |
| `include_hidden` | boolean | no |  |  | Set true to include hidden files/directories. Defaults to false. |

<a id="list_directory"></a>
## `list_directory`

List the immediate contents of a workspace directory. Use this to understand what is in a known directory; use find_files when searching by filename/path pattern. Depth is intentionally limited to 1 or 2.

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `path` | string | no |  |  | Workspace-relative directory path. Defaults to the workspace root. |
| `depth` | integer | no | `1` | one of: `1`, `2` | Directory depth to list. Keep this small; use find_files for recursive discovery. |
| `include_hidden` | boolean | no | `false` |  | Include dot-prefixed entries. |
| `no_ignore` | boolean | no | `false` |  | Include common generated/ignored directories such as node_modules, dist and .git. |
| `max_entries` | integer | no | `200` | min 1; max 500 | Maximum returned entries. |

<a id="run_command"></a>
## `run_command`

Run a shell command in an AgentBridge-managed persistent real PTY that is independent of the user's terminal profiles and VS Code Shell Integration. ${RUNTIME_SHELL_DESCRIPTION}. ${RUNTIME_SHELL_SYNTAX_HINT} Shell state such as environment variables, functions and the current directory persists when the same terminal is reused. Omit cwd to continue from the most recently used idle AgentBridge terminal's current directory; a new terminal starts at the workspace root. Interactive input, resize, and TTY-aware CLI behavior are supported. Concurrent commands may use additional managed terminals, up to 8 live terminals total; when all are busy, additional run_command calls fail until a terminal becomes available or a stuck command is terminated. Explicitly choose background=true for long-running servers/watchers and background=false for commands whose result should be awaited. Returns a command_id for later output inspection or interactive input.

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `command` | string | yes |  | min length 1 | Shell command to run. |
| `cwd` | string | no |  |  | Optional workspace-relative working directory. When omitted, reuse the most recently used idle AgentBridge terminal and continue from its current directory; a new terminal starts at the workspace root. |
| `background` | boolean | yes |  |  | Whether this is expected to keep running. Must be chosen explicitly. |
| `timeout_ms` | integer | no | `90000` | min 1000; max 90000 | For foreground commands, maximum time to wait before returning status=running. The command is not killed on timeout; continue with get_command_output using the returned command_id and wait_ms. Capped below common proxy response deadlines. |

<a id="get_command_output"></a>
## `get_command_output`

Read new output and status from a previously started run_command using its command_id. Pass the previous next_offset as offset to avoid repeating old output. To wait for a still-running command, set wait_ms (at most 60000) instead of calling this tool repeatedly: with wait_until=exit (default) it returns as soon as the command finishes, with wait_until=output as soon as any output past offset arrives, otherwise at the deadline with wait_result=timeout while the command keeps running. Do not poll in a tight loop and do not run sleep commands to wait. Only the 32 most recent finished commands are retained.

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `command_id` | string | yes |  | min length 1 |  |
| `offset` | integer | no | `0` | min 0 | Absolute UTF-8 byte offset into captured output. |
| `max_bytes` | integer | no | `32768` | min 1; max 131072 |  |
| `wait_ms` | integer | no | `0` | min 0; max 60000 | Optional time to block while the command is still running. 0 returns immediately. The result then includes wait_result (exited, output, timeout, or cancelled) and waited_ms. |
| `wait_until` | string | no | `"exit"` | one of: `exit`, `output` | With wait_ms: exit returns when the command finishes; output returns as soon as new output past offset arrives (useful for servers and watchers). |

<a id="send_command_input"></a>
## `send_command_input`

Send text to a running managed terminal for prompts, REPLs, or other interactive input. A newline is appended by default. To request Ctrl+C, send \u0003 with append_newline=false. Ctrl+C is cooperative and may leave the command running; check with get_command_output and use terminate_command when a hard stop is required.

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `command_id` | string | yes |  | min length 1 |  |
| `input` | string | yes |  |  |  |
| `append_newline` | boolean | no | `true` |  |  |

<a id="terminate_command"></a>
## `terminate_command`

Hard-stop a running AgentBridge command by terminating its managed shell and closing that terminal. Terminal-local state such as cwd, environment changes, and history is discarded. Use when cooperative Ctrl+C did not stop the command and get_command_output still reports status=running. To try Ctrl+C first, call send_command_input with input="\u0003" and append_newline=false. Calling this for an already-finished command is idempotent and returns its current status.

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `command_id` | string | yes |  | min length 1 |  |

<a id="get_diagnostics"></a>
## `get_diagnostics`

Read current diagnostics from VS Code and active language services, including unsaved editor state when providers report it. Use after edits/builds to inspect errors and warnings structurally instead of parsing compiler output when diagnostics are available.

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `path` | string | no |  |  | Optional workspace-relative file or directory scope. |
| `severity` | array<string> | no |  | items one of: `error`, `warning`, `information`, `hint`; unique items | Optional severity filter. Defaults to all severities. |
| `max_results` | integer | no | `100` | min 1; max 500 |  |

<a id="lsp"></a>
## `lsp`

Navigate code semantically through the language services already active in VS Code. Use this for code symbols rather than text search: workspace/document symbols, go-to-definition, references, implementations, and hover/type information. Results include provider_state, project_anchor, project_anchor_source, warmup_performed, and semantic_result_inconclusive metadata so empty semantic results and heuristic warm-up anchors are not over-interpreted. Use search_files for raw text and read_files after lsp locates the relevant implementation.

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `operation` | string | yes |  | one of: `workspace_symbols`, `document_symbols`, `definition`, `references`, `implementation`, `hover` | Semantic operation to execute through VS Code language feature providers. |
| `path` | string | no |  |  | Workspace source path. Workspace-relative is preferred; absolute paths are accepted only when they remain inside the workspace. Required for document_symbols/definition/references/implementation/hover. Optional for workspace_symbols as a project/file/directory anchor to activate the relevant language project before semantic search. |
| `line` | integer | no |  | min 1 | 1-based source line. Required for definition/references/implementation/hover. |
| `column` | integer | no |  | min 1 | 1-based UTF-16 source column. Required for definition/references/implementation/hover. |
| `query` | string | no |  |  | Symbol query. Required for workspace_symbols. |
| `include_declaration` | boolean | no | `true` |  | For references, include the symbol declaration/definition when present. |
| `max_results` | integer | no |  | min 1; max 500 | Maximum returned semantic results. Operation-specific defaults are used when omitted. |

<a id="set_todos"></a>
## `set_todos`

Set the complete durable task list for the current remote-agent job in AgentBridge. Use this for multi-step work so the local user can see what is done, in progress, and still pending. Send the full list whenever the plan changes; keep at most one item in_progress and at most 24 items. Use report_progress for transient details about the current step instead of creating tool-call-sized todos. Send an empty list to clear task state. The result echoes the stored list.

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `todos` | array<object> | yes |  | max items 24 | Complete ordered todo snapshot for the current job. |
| `todos[].id` | string | yes |  | min length 1; max length 80 | Stable id reused across later set_todos updates. |
| `todos[].title` | string | yes |  | min length 1; max length 400 | Goal-level task title, not an individual tool call. |
| `todos[].status` | string | yes |  | one of: `pending`, `in_progress`, `completed` |  |

<a id="report_progress"></a>
## `report_progress`

Report concise transient progress from the remote MCP agent to the AgentBridge UI. For multi-step work, maintain durable task state with set_todos and use report_progress for what you are doing right now. todo_id is optional: when omitted, AgentBridge automatically associates progress with the sole in_progress todo. This tool does not modify workspace files.

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `message` | string | yes |  | min length 1; max length 2000 | Human-readable progress update. |
| `phase` | string | no |  | max length 160 | Optional short phase label, such as Reading, Editing, Testing, or Done. |
| `percent` | integer | no |  | min 0; max 100 | Optional completion estimate from 0 to 100 for the current activity/todo. |
| `todo_id` | string | no |  | min length 1; max length 80 | Optional todo id from set_todos. Omit when there is exactly one in_progress todo; AgentBridge will link it automatically. |
