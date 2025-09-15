# VSCode ESLint Extension – Architecture & Development Guide

> Living document describing the internal architecture, major components, data & control flows, performance characteristics, and contribution guidance for the `vscode-eslint` extension. Keep this updated when making structural changes.

## 1. High-Level Overview

The extension implements the [Language Server Protocol (LSP)](https://microsoft.github.io/language-server-protocol/) split model:

```
┌──────────────────────┐        IPC (Node IPC, JSON-RPC)        ┌────────────────────────┐
│ VS Code Extension    │  <──────────────── bi-directional ───► │ ESLint Language Server │
│ (Client, /client)    │                                        │ (/server)              │
└──────────────────────┘                                        └────────────────────────┘
				 │                                                              │
				 │ VS Code API                                                  │ Node + ESLint lib
				 ▼                                                              ▼
	User actions (open, type, save)                            Resolve config, load ESLint, lint
																																		produce diagnostics
```

Key goals:
* Defer activation until needed (lazy activation based on opened documents / settings).
* Support multiple workspace folders & dynamic working directory inference.
* Abstract ESLint version / API differences (CLIEngine vs ESLint class / flat config) transparently.
* Provide rich code actions (fix all, rule disable, suggestions) and formatting integration.
* Handle notebooks and non-file schemes where possible.

## 2. Repository Structure (Relevant Directories)

| Path | Purpose |
|------|---------|
| `package.json` | Extension manifest, contributes settings/commands/tasks, build scripts. |
| `client/` | Extension (frontend) code – activation, LSP client, task provider, status integration. |
| `server/` | LSP server implementation – lint orchestration, diagnostics, code actions. |
| `$shared/` & `client/src/shared` / `server/src/shared` | Shared protocol message & settings types (duplicated build-time copies). |
| `build/` | CI scripts, helper Node scripts (`bin/all.js`, install/link steps). |
| `playgrounds/` | Sample projects used for manual testing across ESLint versions & config styles. |
| `images/` | Assets for marketplace/readme. |

## 3. Extension Client Architecture (`client/src`)

### 3.1 Activation Flow

File: `extension.ts`

1. Registers placeholder commands while ESLint is “not yet active”.
2. Listens to:
	 * `onDidOpenTextDocument`
	 * `onDidChangeConfiguration`
3. Uses `Validator.check(document)` (see `client.ts`) to decide if any open / new document warrants activation (language / probe / validate settings logic).
4. On first qualifying document: disposes provisional listeners & commands, calls `realActivate()`.
5. `realActivate()` creates LSP `LanguageClient` via `ESLintClient.create()` and wires real commands.

Lazy activation minimizes overhead for workspaces not using ESLint.

### 3.2 Validator
Determines validation state per document:
* Returns `Validate.on`, `Validate.probe`, or `Validate.off` based on settings:
	* `eslint.validate` explicit list overrides probe logic.
	* `eslint.probe` language array for auto-detection.
	* Tracks probe failures -> future openings disabled.

### 3.3 ESLintClient.create()
Responsibilities (in `client.ts`):

```
┌───────────────────────────────────────────────────────────────┐
│ create():                                                     │
│  • Build server options (runtime / exec args / env).          │
│  • Construct LanguageClient (document + notebook sync).       │
│  • Install middleware:                                        │
│     - Document open/close gating (sync only relevant docs).   │
│     - CodeActions filtering (only ESLint diagnostics).        │
│     - Dynamic configuration resolution (readConfiguration).   │
│     - Notebook cell filtering.                                │
│  • Register custom protocol notifications & requests:         │
│     StatusNotification, ShowOutputChannel, custom error flows.│
│  • Track performance (validation / fix timings) -> status bar.│
└───────────────────────────────────────────────────────────────┘
```

#### Document Sync Strategy
The client only syncs documents meeting validation criteria OR matching config file patterns (ESLint config / `package.json`). This keeps server memory & CPU usage lean.

#### Performance Tracking
Per-language timing for validation and fix-all operations is collected. Warnings escalate severity in `LanguageStatusItem` when user budgets (`eslint.timeBudget.*`) are exceeded.

#### Settings Migration
Implements interactive migration for deprecated `eslint.autoFixOnSave` to the VS Code `codeActionsOnSave` model (`Migration` class in `settings.ts`). A semaphore prevents concurrent prompts.

### 3.4 Commands
Registered commands include:
* `eslint.executeAutofix` – triggers server `applyAllFixes` command via `ExecuteCommandRequest`.
* `eslint.createConfig` – launches `eslint --init` in selected folder.
* `eslint.restart`, `eslint.revalidate`, `eslint.migrateSettings`, `eslint.showOutputChannel`.

### 3.5 Tasks Integration
`TaskProvider` exposes optional lint workspace task (enabled via `eslint.lintTask.*` settings) by producing a VS Code task definition `type: eslint`.

### 3.6 Notebooks Support
Notebook cells are registered & filtered so only relevant languages are synced. Rule customizations for notebook text cells use `eslint.notebooks.rules.customizations`.

## 4. Language Server Architecture (`server/src`)

### 4.1 Entry (`eslintServer.ts`)
* Creates LSP connection with `cancelUndispatched` logic to fast-cancel code action requests.
* Registers capabilities: diagnostics pull provider (no push), code actions, executeCommand provider, formatting (conditional), workspace folder support.
* Sets up global exception / process exit interception -> notifies client (`ExitCalled`).
* Delegates core lint orchestration to `eslint.ts` module.

### 4.2 Core ESLint Abstraction (`eslint.ts`)

Responsibilities:
* Resolve per-document `TextDocumentSettings` combining VS Code config and dynamic workspace probing.
* Locate & load ESLint library supporting versions:
	* <7 (CLIEngine), 7 (dual), >=8 (ESLint class; optional flat config), >=10 (flat config only).
* Handle transient states: probe mode, silent failures, fallback to global installs (npm/yarn/pnpm resolution logic).
* Determine working directory via `workingDirectory` mode (`auto` / `location`) or explicit lists, factoring in flat config presence.
* Provide version-aware instantiation (`withClass`, `newClass`, honoring `useESLintClass`, `useFlatConfig`, `experimental.useFlatConfig`).
* Compute diagnostics & capture code action metadata (fixes, suggestions, disable directives).
* Manage rule metadata caching (URLs for docs), rule severity overrides (`eslint.rules.customizations`), save rule config filtering, and performance / error classification.
* Provide formatting edits by computing full fix output and diff-minimizing to granular LSP edits.

### 4.3 Code Actions Pipeline

Flow (simplified):
```
Client request -> server onCodeAction:
	 fetch Problems (captured during last validate)
	 filter by diagnostics range/kind
	 group by ruleId -> build actions:
			 - Single fix
			 - Suggestions (rule-provided)
			 - Disable line / file
			 - Show rule docs
			 - Fix all for rule
			 - Global Fix All (source.fixAll.eslint)
```
Fix application uses precomputed `WorkspaceChange` objects keyed by command + rule/sequence.

### 4.4 “Fix All” Strategies
* `onSave` with `codeActionsOnSave.mode = problems`: apply only already-computed non-overlapping fixes (fast, no re-lint run).
* `onSave` / command / format with full mode: re-run ESLint with `fix: true` to leverage all rule fixers; produce minimal diff for LSP.
* Optionally temporarily disables specified rules (save rule offRules) to narrow fix scope.

### 4.5 Working Directory & Config Detection
`ESLint.findWorkingDirectory(workspaceFolder, file)` ascends directory tree detecting config sentinel files (flat & eslintrc). Influences library resolution & parser heuristics for probe validation.

### 4.6 Error Handling & Status Reporting
`ErrorHandlers` classify common failure modes:
* No config -> warn + suggest init.
* Config parse errors, missing plugins/modules -> logged + warned.
* Generic errors -> escalate to error status.
Server sends `StatusNotification` allowing client UI status severity adaptation.

### 4.7 Performance & Budgets
Server timestamps validation; client aggregates and compares against `eslint.timeBudget.onValidation` and `eslint.timeBudget.onFixes`. Out-of-budget durations escalate from info → warning → error.

### 4.8 Notebook Handling
Server uses `NotebookDocuments` from LSP proposed features; inference logic adjusts virtual file paths to map cell documents to plausible file extensions enabling ESLint parsing.

## 5. Custom Protocol Extensions

Defined in `shared/customMessages.ts` (mirrored on both sides). Examples:
* `StatusNotification` – per-document lint state & timings.
* `ExitCalled` – capture unexpected `process.exit` invocations.
* `NoConfigRequest`, `NoESLintLibraryRequest`, `ProbeFailedRequest` – user guidance & state adjustments.
* `OpenESLintDocRequest` – open rule documentation URL.

These are strongly typed and extend beyond base LSP to convey ESLint-specific lifecycle and UX events.

## 6. Settings & Configuration Lifecycle

1. Client intercepts configuration changes; re-syncs / prunes validated documents.
2. Server `resolveSettings()` fetches merged configuration scope via `workspace.getConfiguration()` (scoped per document URI) => `ConfigurationSettings`.
3. Dynamic inference:
	 * Probe mode checks parser / plugin presence for non-default languages.
	 * Applies rule severity overrides & working directory heuristics.
	 * Chooses flat vs eslintrc based on detected files and version capabilities.
4. Caches settings per document; clears caches on environment-affecting events (config file changes, workspace folder changes, file watchers).

## 7. Formatting Integration

If `eslint.format.enable` is true and document not ignored, server registers a *document formatting provider* specific to that resource (narrow pattern) rather than a broad selector, minimizing conflicts. Formatting delegates to the same “compute all fixes” infrastructure with `AllFixesMode.format`.

## 8. Build & Tooling

### 8.1 TypeScript Project References
Root `tsconfig.json` references `client/tsconfig.json` and `server/tsconfig.json` enabling `tsc -b` incremental builds and watch mode.

### 8.2 Bundling
* Primary production build: Webpack bundles client & server (`webpack` / `webpack:dev` scripts) – reduces startup I/O.
* Alternative: `esbuild.js` script (experimental / faster local iteration) – not default publish path.
* Output entrypoints: `client/out/extension.js`, `server/out/eslintServer.js` referenced by extension `main` field.

### 8.3 Development Scripts
* `watch` – incremental TS build (not bundled) for rapid iteration.
* `vscode:prepublish` – production bundle before packaging.
* `test` – currently runs client-side Mocha tests (add server tests separately if needed).
* `lint` – invokes internal task runner to run ESLint against code.

## 9. Performance Considerations

Key tactics:
* Deferred activation & selective document synchronization.
* Caching: ESLint library resolution, settings, rule metadata, save rule configurations, severity overrides.
* Minimal diff calculation for fix-all formatting rather than wholesale text replace.
* Parallelism limited (`maxParallelism: 1`) to avoid overlapping lint operations for same doc (ensures deterministic code actions ordering).

Potential optimization areas (future):
* Idle-time preloading of common parser packages.
* Telemetry-guided adaptive probe lists.
* Streaming diagnostics (progress) for very large files.

## 10. Error & Edge Case Handling

Edge cases covered:
* Missing ESLint dependency – instruct install (local vs global) with package manager detection (`npm.packageManager` command).
* Invalid / corrupt config – surfaces once per file until resolved.
* Ignored files: optional warnings based on `eslint.onIgnoredFiles` severity setting.
* Notebook cells without extension – synthetic path inference adds correct extension so ESLint rules apply.
* Performance regressions – surfaced via language status item details.

## 11. Adding Features / Making Changes

Workflow:
1. Add / modify server logic first (lint, diagnostics, commands). Export new custom request/notification types in shared layer.
2. Mirror types in both `client/src/shared` & `server/src/shared` (consider DRY improvements via a generated shared package in future).
3. Update client: register handler or invoke new request (avoid blocking UI). Respect lazy activation boundaries.
4. Add configuration surface: declare setting in root `package.json` under `contributes.configuration.properties`. Provide schema & markdownDescription.
5. Update `ConfigurationSettings` typing and mapping logic in server `shared/settings.ts` and client counterpart if needed.
6. Include tests (client `glob.test.ts` pattern; consider adding server-focused unit tests via extracted pure functions or integration harness).
7. Run `npm run watch` and manual QA using `playgrounds/` sample workspaces (flat, legacy eslintrc, notebooks).

## 12. Testing Strategy

Current: limited Mocha tests for client utilities.
Recommended additions:
* Abstract pure helpers (e.g., diffing, working directory inference) into testable modules.
* Add server tests invoking `eslint.ts` logic with fixture projects (mock ESLint module where feasible).
* Snapshot test code action generation for representative rule sets.
* Performance guard tests comparing elapsed times vs budget thresholds (non-failing, informational).

## 13. Security & Trust Model

The extension is disabled in untrusted & virtual workspaces because it executes workspace code (loading ESLint plugins, config, and transitive code). `capabilities.untrustedWorkspaces.supported = false` expresses this requirement.

## 14. Telemetry / Data Collection

No user telemetry is emitted by default (verify corporate guidelines before adding). Performance feedback only appears locally in UI; not sent externally.

## 15. Known Limitations / TODOs

| Area | Limitation | Potential Improvement |
|------|------------|-----------------------|
| Shared types | Duplication of `shared/` between client & server | Generate from single source (build step or published internal package). |
| Flat Config rollout | Transitional complexity with `experimental.useFlatConfig` | Remove flag post ESLint 10 adoption window. |
| Testing | Sparse server tests | Introduce integration harness with fixture workspaces. |
| Performance budgets | Static thresholds | Adaptive budgets (history-based) or user prompt suggestions. |
| Large monorepos | Repeated library resolution | Pre-resolve & cache per workspace root cluster. |

## 16. Quick Reference (Cheat Sheet)

| Task | Command |
|------|---------|
| Dev build (incremental) | `npm run watch` |
| Production bundle | `npm run webpack` |
| Run tests | `npm test` |
| Clean | `npm run clean` |
| Lint extension code | `npm run lint` |
| Link LSP symlink (if needed) | `npm run symlink:lsp` |

## 17. Data Flow Summary

```
User edits file ─► VS Code fires didChange ─► Client middleware checks eligibility ─►
	If tracked: send to server ─► Server resolveSettings() ─► ESLint lintText() ─►
	Diagnostics + fix metadata ─► Server StatusNotification ─► Client updates status item /
	caches performance ─► User triggers code action ─► Client requests code actions ─►
	Server constructs actions (WorkspaceEdit commands) ─► ExecuteCommandRequest apply edits ─► Document updates ─► Repeat
```

## 18. Adding a New Setting (Example Steps)

1. Add schema in root `package.json` under `contributes.configuration.properties`.
2. Extend `ConfigurationSettings` (server `shared/settings.ts`).
3. Map retrieval in `client/src/client.ts` `readConfiguration()` if client needs early awareness; otherwise only server.
4. Use setting inside `eslint.ts` logic (e.g., adapt `validate()` or `resolveSettings()`).
5. Update this document if behavior impacts architecture or flows.

## 19. Future Enhancements (Backlog Concepts)
* Unified shared protocol/types package.
* Web extension (browser) compatibility (remove Node-only modules; dynamic import strategies, ESM full support).
* Progressive diagnostics (partial results streaming for huge files).
* Rule performance telemetry (opt-in) to help identify slow rules.
* Inline rule doc rendering (custom CodeLens / hover) leveraging existing metadata.

---
Maintainers: Update sections 3–5 & 8–11 when modifying activation logic, server validation strategy, code actions, or build process.

