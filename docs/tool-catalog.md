# AgentBridge MCP tool catalog

<!-- Generated from the tool definitions by `npm run tool-catalog`. Do not edit by hand: tests/tool-catalog.test.ts fails when this file is stale. -->

This is exactly what MCP clients receive from `tools/list`. In `run_command`, `${RUNTIME_SHELL_DESCRIPTION}` and `${RUNTIME_SHELL_SYNTAX_HINT}` are replaced at runtime with the configured managed shell. In `load_skill`, `${RUNTIME_SKILL_CATALOG}` is replaced with the skills found on this machine.

15 tools, listed in both Plan and Build mode. In Plan mode (read-only), 3 are blocked at call time and `run_command` only runs allowlisted read-only commands.

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
| [`load_skill`](#load_skill) | available | (none) |
| [`set_todos`](#set_todos) | available | `todos` |
| [`report_progress`](#report_progress) | available | `message` |

<a id="apply_patch"></a>
## `apply_patch`

```text
Create, edit, move, or delete workspace files with a patch.

*** Begin Patch
*** Add File: src/util.ts
+export const answer = 42;
*** Update File: src/app.ts
*** Move to: src/main.ts
@@
 function greet() {
-  print("Hi")
+  print("Hello")
*** Delete File: old.txt
*** End Patch

- Put related edits to several files in one patch.
- In Update hunks, context lines start with a space, removed lines with -, added lines with +. Old and context lines must match the file exactly and only once, or nothing is applied; re-read the file and regenerate the patch.
- To replace a whole file, write *** Delete File: X immediately followed by *** Add File: X; the file keeps its line endings. Add File alone fails with FILE_ALREADY_EXISTS on an existing file.
- Missing parent directories are created.
- Pass the version hashes returned by read_files in expected_versions; a file changed since it was read fails with STALE_FILE instead of being edited.
- Returns the applied unified diff.
```

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `patch` | string | yes |  | min length 1 | Patch text from *** Begin Patch to *** End Patch. |
| `expected_versions` | map<string, string> | no |  | values match `^sha256:` | Map from file path to the sha256:... version returned by read_files for that file. Recommended whenever available. |

<a id="find_files"></a>
## `find_files`

```text
Find workspace files whose paths match glob patterns. Matches names and paths, not contents; use search_files for contents.

- Pass several patterns in one call (at most 20), e.g. ["**/*.test.ts", "**/package.json"].
- Returns files only, never directories, newest first by default; sort=path_asc gives a stable order.
- Matching is case-insensitive by default. Ignored, generated, and hidden paths are skipped unless no_ignore or include_hidden is set.
- Returns 100 paths by default (max_results up to 500). If truncated=true, narrow path or patterns first.
```

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `patterns` | array<string> | yes |  | min items 1; max items 20 | Glob patterns matched against paths under path. |
| `path` | string | no |  |  | Optional directory scope relative to the workspace root. Defaults to '.'. |
| `exclude` | array<string> | no |  | max items 50 | Glob patterns for paths to leave out. |
| `case_sensitive` | boolean | no |  |  | Whether glob matching is case-sensitive. Defaults to false. |
| `no_ignore` | boolean | no |  |  | Set true to bypass ignore files/common generated-directory excludes. Defaults to false. |
| `include_hidden` | boolean | no |  |  | Set true to include hidden files/directories. Defaults to false. |
| `max_results` | integer | no |  | min 1; max 500 | Maximum file paths returned. Defaults to 100; hard maximum 500. |
| `sort` | string | no |  | one of: `modified_desc`, `path_asc` | Result order. Defaults to modified_desc (newest first); path_asc gives deterministic lexical order. |

<a id="read_files"></a>
## `read_files`

```text
Read UTF-8 text files from the workspace. Each file comes back with line numbers and a version hash.

- Read several files in one call, at most 20 files per call.
- Omit start_line/end_line to read a whole file; set them (1-based, inclusive) to read part of a large file.
- Long files are cut off at about 2000 lines or 64 KB per file; continue from next_start_line. Files of 2 MB or more need an explicit range.
- Pass the version hashes to apply_patch expected_versions so a file changed in the meantime is not overwritten.
- When you do not know where something is, use search_files first instead of reading many files.
```

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `files` | array<object> | yes |  | min items 1; max items 20 | Files to read in this call. |
| `files[].path` | string | yes |  |  | File path relative to the workspace root. |
| `files[].start_line` | integer | no |  | min 1 | Optional 1-based inclusive first line. |
| `files[].end_line` | integer | no |  | min 1 | Optional 1-based inclusive last line. |

<a id="read_image_file"></a>
## `read_image_file`

```text
Read a raster image (PNG, JPEG, GIF, WebP, BMP) from the workspace and show it to you.

- For screenshots, charts, UI mockups, and diagrams. For SVG use read_files.
- Large images are downscaled to a 2000 px long edge and at most 4.50 MB of base64; small images are sent unchanged. Images over 64 megapixels are rejected.
- The text before the image gives the source and sent size; if scaled, divide coordinates by the reported scale to map them to the source file.
- GIF shows only its first frame.
```

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `path` | string | yes |  | min length 1 | Image path, relative to the workspace root. |

<a id="search_files"></a>
## `search_files`

```text
Search text file contents in the workspace. Returns matching lines with paths and line numbers.

- Literal text by default; set is_regex=true for a regular expression.
- Smart case by default: an all-lowercase pattern ignores case, any uppercase letter makes it case-sensitive.
- Narrow with path and include/exclude globs, e.g. include=["**/*.ts"].
- Returns up to 100 matches (max_results up to 500; 20 per file by default) with 1 line of context (context_lines up to 5). If truncated=true, narrow the search.
- Ignored, generated, and hidden paths are skipped unless no_ignore or include_hidden is set.
- Read the surrounding code with read_files; use lsp for definitions and references.
```

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

```text
List the entries of a workspace directory.

- depth 1 (default) or 2; for deeper or pattern-based discovery use find_files.
- Dot entries and generated or ignored directories (node_modules, dist, .git) are hidden unless include_hidden or no_ignore is set.
- Returns up to 200 entries by default (max_entries up to 500).
```

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `path` | string | no |  |  | Workspace-relative directory path. Defaults to the workspace root. |
| `depth` | integer | no | `1` | one of: `1`, `2` | 1 lists the directory itself; 2 also lists its subdirectories. |
| `include_hidden` | boolean | no | `false` |  | Include dot-prefixed entries. |
| `no_ignore` | boolean | no | `false` |  | Include common generated/ignored directories such as node_modules, dist and .git. |
| `max_entries` | integer | no | `200` | min 1; max 500 | Maximum entries returned. |

<a id="run_command"></a>
## `run_command`

```text
Run a shell command in a persistent terminal managed by AgentBridge: ${RUNTIME_SHELL_DESCRIPTION}.

- Set background explicitly: false to wait for the result, true for servers and watchers that keep running (returns at once with a command_id).
- A foreground command still running after timeout_ms (default and maximum 90000) returns status=running with a command_id; it is not killed. Continue with get_command_output.
- Terminal state (cwd, environment variables, functions) persists between calls. Omit cwd to continue in the last idle terminal's directory; a new terminal starts at the workspace root.
- Up to 8 terminals run at once; when all are busy the call fails until one finishes or is terminated.
- Interactive programs work; answer prompts with send_command_input.
- Syntax: ${RUNTIME_SHELL_SYNTAX_HINT}
```

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `command` | string | yes |  | min length 1 | Command line to run. |
| `cwd` | string | no |  |  | Working directory relative to the workspace root. Omit to continue in the last idle terminal's directory. |
| `background` | boolean | yes |  |  | true for commands that keep running (servers, watchers); false to wait for the result. |
| `timeout_ms` | integer | no | `90000` | min 1000; max 90000 | Foreground only: how long to wait before returning status=running. The command keeps running. |

<a id="get_command_output"></a>
## `get_command_output`

```text
Read new output and the status of a command started with run_command.

- Pass the previous next_offset as offset to get only new output.
- To wait for a running command, set wait_ms (at most 60000) instead of calling repeatedly or running sleep: wait_until=exit (default) returns when it finishes, wait_until=output as soon as new output arrives; otherwise it returns at the deadline with wait_result=timeout and the command keeps running.
- Only the 32 most recent finished commands are kept.
```

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `command_id` | string | yes |  | min length 1 | Id returned by run_command. |
| `offset` | integer | no | `0` | min 0 | Byte offset to read from; pass the previous next_offset. |
| `max_bytes` | integer | no | `32768` | min 1; max 131072 | Maximum output bytes returned in this call. |
| `wait_ms` | integer | no | `0` | min 0; max 60000 | How long to wait while the command is running; 0 returns immediately. The result then includes wait_result and waited_ms. |
| `wait_until` | string | no | `"exit"` | one of: `exit`, `output` | exit: return when the command finishes. output: return as soon as new output arrives (useful for servers). |

<a id="send_command_input"></a>
## `send_command_input`

```text
Type input into a running command's terminal: answers to prompts, REPL lines, or control keys.

- A newline is appended unless append_newline=false.
- Ctrl+C: input="\u0003" with append_newline=false. It may not stop the command; check with get_command_output and use terminate_command for a hard stop.
```

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `command_id` | string | yes |  | min length 1 | Id returned by run_command. |
| `input` | string | yes |  |  | Text to send. Use \u0003 for Ctrl+C. |
| `append_newline` | boolean | no | `true` |  | Press Enter after the input. |

<a id="terminate_command"></a>
## `terminate_command`

```text
Force-stop a running command by closing its terminal.

- Use when Ctrl+C through send_command_input did not stop it.
- The terminal's state (cwd, environment variables, history) is lost.
- Safe to call on a finished command; it returns the current status.
```

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `command_id` | string | yes |  | min length 1 | Id returned by run_command. |

<a id="get_diagnostics"></a>
## `get_diagnostics`

```text
Read the errors and warnings VS Code currently reports (the Problems panel), including for unsaved edits.

- Use after edits or builds instead of parsing compiler output.
- Filter with path and severity; returns up to 100 results by default (max_results up to 500).
- Language services may only report files they have analyzed; run the build or tests to check everything.
```

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `path` | string | no |  |  | File or directory to limit results to, relative to the workspace root. |
| `severity` | array<string> | no |  | items one of: `error`, `warning`, `information`, `hint`; unique items | Severities to include. Defaults to all. |
| `max_results` | integer | no | `100` | min 1; max 500 | Maximum diagnostics returned. |

<a id="lsp"></a>
## `lsp`

```text
Navigate code by symbols using the language services running in VS Code.

- operation: workspace_symbols (needs query), document_symbols (needs path), or definition, references, implementation, hover (need path, line, and column, all 1-based).
- Use search_files for plain text and read_files to read the code lsp finds.
- An empty result can mean the language service is not ready or does not cover the file; check provider_state and semantic_result_inconclusive before concluding a symbol does not exist.
```

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `operation` | string | yes |  | one of: `workspace_symbols`, `document_symbols`, `definition`, `references`, `implementation`, `hover` | What to look up. |
| `path` | string | no |  |  | Source file relative to the workspace root. Required except for workspace_symbols, where it optionally points at the project to search. |
| `line` | integer | no |  | min 1 | 1-based source line. Required for definition/references/implementation/hover. |
| `column` | integer | no |  | min 1 | 1-based UTF-16 source column. Required for definition/references/implementation/hover. |
| `query` | string | no |  |  | Symbol query. Required for workspace_symbols. |
| `include_declaration` | boolean | no | `true` |  | For references, include the symbol declaration/definition when present. |
| `max_results` | integer | no |  | min 1; max 500 | Maximum returned semantic results. Operation-specific defaults are used when omitted. |

<a id="load_skill"></a>
## `load_skill`

```text
Load an Agent Skill: task-specific instructions kept in a SKILL.md file on this machine.

- When the task matches a skill listed below, load it before starting and follow its instructions.
- When the user names a skill, for example /deploy, $deploy, or "use the deploy skill", load that skill first.
- Returns the SKILL.md instructions, the skill directory, and the other files in it. Relative paths in a skill are relative to that directory.
- Pass file to read another text file of the skill, such as a reference document; run its scripts with run_command.
- Omit name to list the skills again, including ones added after this list was sent.
- Skills come from .agents/skills in each workspace folder and from ~/.agents/skills; a workspace skill wins over a user skill with the same name.

${RUNTIME_SKILL_CATALOG}
```

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `name` | string | no |  | min length 1; max length 64 | Skill name from the list. Omit to list all skills. |
| `file` | string | no |  | min length 1 | Optional path of another file inside the skill, relative to the skill directory, e.g. references/api.md. Requires name. |

<a id="set_todos"></a>
## `set_todos`

```text
Show your task list for the current job to the user in the AgentBridge panel.

- Send the complete list each time it changes, at most 24 items with at most one in_progress.
- Use goal-level items, not one per tool call; use report_progress for what you are doing right now.
- An empty list clears it. The result echoes the stored list.
```

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `todos` | array<object> | yes |  | max items 24 | The complete, ordered task list. |
| `todos[].id` | string | yes |  | min length 1; max length 80 | Stable id reused across later set_todos updates. |
| `todos[].title` | string | yes |  | min length 1; max length 400 | Goal-level task title, not an individual tool call. |
| `todos[].status` | string | yes |  | one of: `pending`, `in_progress`, `completed` | Task state. |

<a id="report_progress"></a>
## `report_progress`

```text
Show a short status update in the AgentBridge panel about what you are doing now.

- Use it at meaningful steps of long work, not after every tool call.
- todo_id links the update to a set_todos item; when omitted it attaches to the single in_progress item.
- Does not change any files.
```

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `message` | string | yes |  | min length 1; max length 2000 | One or two sentences for the user. |
| `phase` | string | no |  | max length 160 | Short label such as Reading, Editing, Testing, or Done. |
| `percent` | integer | no |  | min 0; max 100 | Completion estimate for the current task. |
| `todo_id` | string | no |  | min length 1; max length 80 | Id of the set_todos item this update belongs to. |
