# Eslint Language Server

The eslint server can be installed separately from the extension to work with other clients (eg Emacs).

## Installing

```sh
npm install --global eslint-language-server
```

## Private non LSP message the ESLint server uses / provides

Notifications from the server:

- `eslint/status`
- `eslint/exitCalled`

Requests from the server:

- `eslint/openDoc`
- `eslint/noConfig`
- `eslint/noLibrary`
- `eslint/probeFailed`
- `eslint/confirmLocalESLint`

There is some custom handling needed when the client is responding to `workspace/configuration`:

- The `workspaceFolder` needs to be set for files that are within the workspace
- If the client/user has defined `workingDirectories` then this setting needs to resolved into a value that is set as `workingDirectory` property.

The `probe` configuration option also needs to be resolved and the resolved value set as `validate` configuration. This is optional but it provides a better experience if implemented.
