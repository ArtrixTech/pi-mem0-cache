# AGENTS.md

## 1. Mindset

### Think Before Coding

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Litmus test: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### Stay Critical

- The user can be wrong; verify claims against the project's actual state before acting.
- No flattery or filler. Don't fold under pushback. Never open with "you are right".
- Challenge weak reasoning. Anticipate mistakes. When unsure, say "I don't know" or ask.
- Surface tradeoffs and evaluate their impact instead of hiding them.

## 2. Coding Style

### Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

### Goal-Driven Execution

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 3. Architecture

A system has three layers of structure that must stay aligned:

| Layer | What it answers |
|---|---|
| **Logical** | What are the conceptual components? What does each one own? |
| **Implementation** | How are those components realized in code — modules, classes, interfaces, data flow? |
| **File organization** | How are files and directories laid out on disk? |

Misalignment between any two layers is a structural defect: a logical component scattered across unrelated directories, a single file serving multiple logical owners, a directory hierarchy that implies relationships the code contradicts.

### Three-Layer Alignment

- Each logical component maps to a clear implementation boundary (module, class, service — whatever the stack uses).
- Each implementation boundary maps to a predictable file location.
- If you change one layer, verify the other two still match.

Smell test: given a logical component name, can someone unfamiliar with the codebase find its implementation and files without searching? If not, the mapping is broken.

### One-Sentence Rule

Every logical component, every module, and every directory must be describable in a single sentence: what it owns, what it does not. If you cannot write that sentence, the boundary is wrong — split, merge, or rename until you can.

### Place Before Create

Before adding a new file or directory, answer: "Which logical component does this belong to, and where does that component live?" If no boundary fits:
1. The structure may need adjustment, or
2. The new thing is poorly defined.

Never create a file with the intent to "figure out where it goes later."

### Dependency Direction

Dependencies between components flow in one direction. If A depends on B and B depends on A, the boundary between them is broken — resolve it before moving forward.

### Architecture.md

Each project maintains an `Architecture.md` at root — a living map of the current structure, not a design document.

Format:
```markdown
# Architecture

## Components
<list of logical components, each with a one-sentence description and its file-level location>

## Key Relationships (optional)
<brief prose on dependency/containment/data-flow between components, only when the component list alone is ambiguous>
```

Rules:
- Update when structure changes (component added/removed/split/merged, directory moved). Not for implementation-detail changes.
- Each entry connects the logical role to its physical location — don't describe one without the other.
- Keep it factual (what *is*), not aspirational (what *should be*).

## 4. Communication

- Evidence over assertion: back "works", "tested", "fixed" with the command, output, or file that proves it.
- Be concise. No filler. Say what matters.
- When reporting results, show the proof (command + output, test result, screenshot, etc.).

## 5. Action

- Don't assume your knowledge is current.
- Don't guess APIs, signatures, flags, or behavior — read the source or docs to confirm before relying on them.
- Batch independent operations in one pass, not one at a time.
- Fan out independent subtasks to parallel subagents when you own the overall flow and the work is genuinely parallel.

## 6. Git & Commits

### Commit Style

- Use **Gitflow** branch naming and workflow conventions.
- Commit messages in **English**.
- Format: `<type>(<scope>): <subject>` (e.g., `feat(auth): add JWT refresh token rotation`).
- Types: `feat`, `fix`, `refactor`, `docs`, `style`, `test`, `chore`, `perf`, `ci`.
- Subject line: imperative mood, no period, ≤72 chars.
- Body (optional): explain *why*, not *what*. Wrap at 72 chars.

### Commit Discipline

- Make atomic commits after each conversation turn that produces changes.
- Unless the user explicitly requests otherwise, commit on the current branch — do not create sub-branches.
- Each commit should be self-contained and the repo should remain in a buildable/runnable state after every commit.

## 7. Documentation

### devlog.md (`docs/devlog.md`)

A running development log organized in reverse-chronological blocks.

Each block represents one commit:

```markdown
## <commit title>

`<commit hash>` | <date>

- **Changes**: <what was modified, compressed>
- **Reason**: <why>
- **User feedback**: <original user request/feedback, if any>
- **Process**: <experiments, tests, iterations — if any>
- **Result**: <outcome, effect, status>
- **Notes**: <anything useful for future tracing/debugging>
```

Rules:
- One block per commit. Add the commit hash after committing (the devlog update rides with the next commit — no dedicated commit needed).
- Keep text compressed but information-complete.
- Record anything that might aid future tracing or debugging.

### Precipitation Docs (`docs/precipitation/<YYMMDD>_<brief_name>.md`)

Long-lived knowledge artifacts: reflections, lessons learned, pitfalls, reusable workflows (debugging, migration, etc.), methodology.

Decision criterion: write a precipitation doc when the content is **durable and transferable** — valuable beyond the immediate task.

File format:
```markdown
# <Title>

## Summary
<1-3 sentence overview of what this document covers and why it exists>

## Content
<detailed content>
```

Naming rules:
- `YYMMDD` date prefix for chronological sorting.
- `brief_name` uses accurate keywords for future recall (e.g., `250713_playwright_flaky_test_strategy.md`).
