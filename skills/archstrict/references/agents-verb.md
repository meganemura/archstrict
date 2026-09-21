# Install agent instructions

Run `archstrict agents [--json]` from the project root to add the archstrict section to `AGENTS.md`.
The section tells agents to run `archstrict rules <path>` before creating files or adding imports, and `archstrict check` after editing.
It applies only when `archstrict.config.ts` exists.
The command itself does not require or read that config.

The fixed section sits between `<!-- ARCHSTRICT_START -->` and `<!-- ARCHSTRICT_END -->`.
It contains command guidance, not module names, tags, or configured constraints.
Changing the project config does not change the section.

The command creates a missing file, appends to an unmarked file, or replaces the existing marked section.
Replacement preserves every byte outside the markers.
Repeated installation leaves the same file contents.
Appending retains existing whitespace and adds a blank-line separator before the new section.

Run `archstrict agents --remove` to remove the section and its separator.
Other content remains intact. Removing from a missing or unmarked file does not change it.
A file containing only the section becomes empty; it is not deleted.
Incomplete or duplicate markers produce an error without changing the file.

`AGENTS.md` can be a symbolic link or a chain of links, including a link whose target does not exist yet.
The command follows the links and writes the resolved target, preserving the links themselves.
It creates missing target directories when installing. A link cycle produces an error.
Other agent instruction files are not separate write targets; if they share the same target, they see its updated content.

Text output is one confirmation line.
JSON output has `state` and `path`, where `path` names the resolved target:

| State | Result |
| --- | --- |
| `created` | Created the target with the section. |
| `appended` | Added the section after existing content. |
| `replaced` | Updated an existing section, or kept an identical section. |
| `removed` | Removed the section. |
| `already-absent` | The target does not exist; no change. |
| `no-markers` | The target has no section; no change. |

Successful commands exit 0. Errors exit 1 and use `{ "error": "<message>" }` with `--json`.
