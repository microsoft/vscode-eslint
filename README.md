# VS Code ESLint extension

[![Build Status](https://dev.azure.com/ms/vscode-eslint/_apis/build/status/Microsoft.vscode-eslint)](https://dev.azure.com/ms/vscode-eslint/_build/latest?definitionId=18)

Integrates [ESLint](http://eslint.org/) into VS Code. If you are new to ESLint check the [documentation](http://eslint.org/).

The extension uses the ESLint library installed in the opened workspace folder. If the folder doesn't provide one the extension looks for a global install version. If you haven't installed ESLint either locally or globally do so by running `npm install eslint` in the workspace folder for a local install or `npm install -g eslint` for a global install.

On new folders you might also need to create a `.eslintrc` configuration file. You can do this by either using the VS Code command `Create ESLint configuration` or by running the `eslint` command in a terminal. If you have installed ESLint globally (see above) then run [`eslint --init`](http://eslint.org/docs/user-guide/command-line-interface) in a terminal. If you have installed ESLint locally then run [`.\node_modules\.bin\eslint --init`](http://eslint.org/docs/user-guide/command-line-interface) under Windows and [`./node_modules/.bin/eslint --init`](http://eslint.org/docs/user-guide/command-line-interface) under Linux and Mac.

## Settings Options

This extension contributes the following variables to the [settings](https://code.visualstudio.com/docs/customization/userandworkspace):

- `eslint.enable`: enable/disable ESLint. Is enabled by default.
- `eslint.provideLintTask`: whether the extension contributes a lint task to lint a whole workspace folder.
- `eslint.packageManager`: controls the package manager to be used to resolve the ESLint library. This has only an influence if the ESLint library is resolved globally. Valid values are `"npm"` or `"yarn"` or `"pnpm"`.
- `eslint.options`: options to configure how ESLint is started using the [ESLint CLI Engine API](http://eslint.org/docs/developer-guide/nodejs-api#cliengine). Defaults to an empty option bag.
  An example to point to a custom `.eslintrc.json` file is:
  ```json
  {
    "eslint.options": { "configFile": "C:/mydirectory/.eslintrc.json" }
  }
  ```
- `eslint.run` - run the linter `onSave` or `onType`, default is `onType`.
- `eslint.autoFixOnSave` - enables auto fix on save. Please note auto fix on save is only available if VS Code's `files.autoSave` is either `off`, `onFocusChange` or `onWindowChange`. It will not work with `afterDelay`.
- `eslint.runtime` - use this setting to set the path of the node runtime to run ESLint under.
- `eslint.nodePath` - use this setting if an installed ESLint package can't be detected, for example `/myGlobalNodePackages/node_modules`.
- `eslint.validate` - an array of language identifiers specify the files to be validated. Something like `"eslint.validate": [ "javascript", "javascriptreact", "html" ]`. If the setting is missing, it defaults to `["javascript", "javascriptreact"]`. You can also control which plugins should provide auto fix support. To do so simply provide an object literal in the validate setting with the properties `language` and `autoFix` instead of a simple `string`. An example is:
  ```json
  "eslint.validate": [ "javascript", "javascriptreact", { "language": "html", "autoFix": true } ]
  ```

- `eslint.workingDirectories` - an array for working directories to be used. ESLint resolves configuration files relative to a working directory. This new settings allows users to control which working directory is used for which files. Consider the following setups:
  ```
  client/
    .eslintignore
    .eslintrc.json
    client.js
  server/
    .eslintignore
    .eslintrc.json
    server.js
  ```
  Then using the setting:
  ```json
    "eslint.workingDirectories": [
      "./client", "./server"
    ]
  ```
  will validate files inside the server directory with the server directory as the current working directory. Same for files in the client directory. If the setting is omitted the working directory is the workspace folder.

  The setting also supports literals of the form `{ "directory": string, "changeProcessCWD": boolean }` as elements. Use this form if you want to instruct ESLint to change the current working directory of the ESLint validation process to the value of `directory` as well. This is for example necessary if ESLint is used to validate relative import statements like `import A from 'components/A';` which would otherwise be resolved to the workspace folder root.
- `eslint.codeAction.disableRuleComment` - object with properties:
  - `enable` - show disable lint rule in the quick fix menu. `true` by default.
  - `location` - choose to either add the `eslint-disable` comment on the `separateLine` or `sameLine`. `separateLine` is the default.
  Example:
  ```json
  { "enable": true, "location": "sameLine" }
  ```
- `eslint.codeAction.showDocumentation` - object with properties:
  - `enable` - show open lint rule documentation web page in the quick fix menu. `true` by default.

## Commands:

This extension contributes the following commands to the Command palette.

- `Create '.eslintrc.json' file`: creates a new `.eslintrc.json` file.
- `Fix all auto-fixable problems`: applies ESLint auto-fix resolutions to all fixable problems.
- `Disable ESLint for this Workspace`: disables ESLint extension for this workspace.
- `Enable ESLint for this Workspace`: enable ESLint extension for this workspace.

## Using the extension with VS Code's task running

The extension is linting an individual file only on typing. If you want to lint the whole workspace set `eslint.provideLintTask` to `true` and the extension will also contribute the `eslint: lint whole folder` task. There is no need anymore to define a custom task in `tasks.json`.
