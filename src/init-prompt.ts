export const INIT_PROMPT = `
Initialize project-level agent instructions in AGENTS.md in this session's current filesystem working directory. Use the current agent and its authorized tools; do not invoke another agent or Codex CLI.

Check the exact target before inspecting the project. If AGENTS.md already exists, stop without changing it and report that it was preserved. Treat a symlink, directory, permission error, or uncertain existence as a reason to stop, not as absence. Do not write global instructions, CLAUDE.md, parent-directory instructions, or project source files. Do not move the target to the Git root when this session is in a subdirectory.

Read applicable instructions and inspect only enough repository files to establish project-specific facts: structure, package/build configuration, README, tests, formatting configuration, and recent commit conventions. Skip dependencies, caches, unrelated files, and secrets. Do not install dependencies, start services, run a full test suite, commit, or push.

Generate concise Markdown titled "Repository Guidelines", following the project's language conventions. Include relevant sections for project structure, build/test/development commands, coding style, testing, commit conventions, and security. Omit unsupported requirements rather than inventing coverage thresholds or PR rules. Commands listed from configuration are not evidence that you ran them successfully. Prefer roughly 200–400 words for English, or a similarly concise document in another language. Keep guidance actionable and specific; do not duplicate entire global instructions.

Check the target again immediately before creation. Use the existing write tool and the host's guarded creation path; respect sandbox, approval, and plan-mode restrictions. If the target exists or creation conflicts, stop and preserve the other file. Never read a conflicting file and then retry an overwrite; never use edit, shell redirection, or another writing path to bypass a refusal.

Only after successful creation, read the file back and report the actual location and verification result. If blocked, cancelled, or refused, report that condition without claiming the file was generated. Instruction loading depends on the session's enabled host components; do not claim automatic activation without evidence.
`
