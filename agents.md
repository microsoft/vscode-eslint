## High-Level Overview

The extension integrates ESLint into VS Code by implementing a ESLint server using the [Language Server Protocol (LSP)](https://microsoft.github.io/language-server-protocol/).

Key goals:
* Defer activation until needed (lazy activation based on opened documents / settings).
* Support multiple workspace folders & dynamic working directory inference.
* Abstract ESLint version / API differences (CLIEngine vs ESLint class / flat config) transparently.
* Provide rich code actions (fix all, rule disable, suggestions) and formatting integration.
* Handle notebooks and non-file schemes where possible.


## Repository Structure (Relevant Directories)

| Path | Purpose |
|------|---------|
| `package.json` | Extension manifest, contributes settings/commands/tasks, build scripts. |
| `client/` | Extension (frontend) code – activation, LSP client, task provider, status integration. |
| `server/` | LSP server implementation – lint orchestration, diagnostics, code actions. |
| `$shared/` | Shared protocol message & settings types. This folder is symlinked into `./client/src/shared` and `./server/src/shared`. |
| `build/` | CI scripts, helper Node scripts (`bin/all.js`, install/link steps). |
| `playgrounds/` | Sample projects used for manual testing across ESLint versions & config styles. |
| `images/` | Assets for marketplace/readme. |

## Settings

Settings are retrieved using a scope where the scope can be global or per resource (folder or file). Therefore settings must never be stored in globals on the server side. The always need to be managed as `TextDocumentSettings` which are cached by the resource path.

To add a new settings follow these steps:

1. Add schema in root `package.json` under `contributes.configuration.properties`. New settings should default to a falsify value if not specified otherwise. All setting keys must be prefixed with `eslint`
2. Extend `ConfigurationSettings` under `$shared/settings`.
3. Map retrieval in `client/src/client.ts` `readConfiguration()`
4. Use setting inside `eslint.ts` logic (e.g., adapt `validate()` or `resolveSettings()`).

## Design Decisions