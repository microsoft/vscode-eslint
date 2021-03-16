# VS Code ESLint extension

The document describes the settings and setup instructions for the previous 1.9.x version of the extension.

## Settings Options

The extension contributes the following variables to the [settings](https://code.visualstudio.com/docs/customization/userandworkspace):

- `eslint.enable`: enable/disable ESLint. Is enabled by default.
- `eslint.lintTask.enable`: whether the extension contributes a lint task to lint a whole workspace folder.
- `eslint.lintTask.options`: Command line options applied when running the task for linting the whole workspace (https://eslint.org/docs/user-guide/command-line-interface).
  An example to point to a custom `.eslintrc.json` file and a custom `.eslintignore` is:
  ```json
  {
    "eslint.lintTask.options": "-c C:/mydirectory/.eslintrc.json --ignore-path C:/mydirectory/.eslintignore ."
  }
  ```
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
- `eslint.quiet` - ignore warnings.
- `eslint.runtime` - use this setting to set the path of the node runtime to run ESLint under.
- `eslint.nodePath` - use this setting if an installed ESLint package can't be detected, for example `/myGlobalNodePackages/node_modules`.
- `eslint.validate` - an array of language identifiers specify the files to be validated. Something like `"eslint.validate": [ "javascript", "javascriptreact", "html" ]`. If the setting is missing, it defaults to `["javascript", "javascriptreact"]`. You can also control which plugins should provide auto fix support. To do so simply provide an object literal in the validate setting with the properties `language` and `autoFix` instead of a simple `string`. An example is:
  ```json
  "eslint.validate": [ "javascript", "javascriptreact", { "language": "html", "autoFix": true } ]
  ```

- `eslint.workingDirectories` - an array for working directories to be used. ESLint resolves configuration files (e.g. `eslintrc`) relative to a working directory. This new settings allows users to control which working directory is used for which files (see also [CLIEngine options#cwd](https://eslint.org/docs/developer-guide/nodejs-api#cliengine)).
  Example:
  ```
  root/
    client/
      .eslintrc.json
      client.js
    server/
      .eslintignore
      .eslintrc.json
      server.js
  ```

  Then using the setting:

  ```javascript
    "eslint.workingDirectories": [
      "./client", "./server"
    ]
  ```

  will validate files inside the server directory with the server directory as the current eslint working directory. Same for files in the client directory.

  ESLint also considers the process's working directory when resolving `.eslintignore` files or when validating relative import statements like `import A from 'components/A';` for which no base URI can be found. To make this work correctly the eslint validation process needs to switch the process's working directory as well. Since changing the processes`s working directory needs to be handled with care it must be explicitly enabled. To do so use the object literal syntax as show below for the server directory:

   ```javascript
    "eslint.workingDirectories": [
      "./client", // Does not change the process's working directory
      { "directory": "./server", "changeProcessCWD": true }
    ]
  ```
  This validates files in the client folder with the process's working directory set to the `workspace folder` and files in the server folder with the process's working directory set to the `server` folder. This is like switching to the `server` folder in a terminal if ESLint is used as a shell command.

  If the `workingDirectories` setting is omitted the eslint working directory and the process's working directory is the `workspace folder`.

- `eslint.codeAction.disableRuleComment` - object with properties:
  - `enable` - show disable lint rule in the quick fix menu. `true` by default.
  - `location` - choose to either add the `eslint-disable` comment on the `separateLine` or `sameLine`. `separateLine` is the default.
  Example:
  ```json
  { "enable": true, "location": "sameLine" }
  ```
- `eslint.codeAction.showDocumentation` - object with properties:
  - `enable` - show open lint rule documentation web page in the quick fix menu. `true` by default.

The extension is linting an individual file only on typing. If you want to lint the whole workspace set `eslint.lintTaks.enable` to `true` and the extension will also contribute the `eslint: lint whole folder` task. There is no need anymore to define a custom task in `tasks.json`.

## Using ESLint to validate TypeScript files

A great introduction on how to lint TypeScript using ESlint can be found in the [TypeScript - ESLint](https://github.com/typescript-eslint/typescript-eslint). Please make yourself familiar with the introduction before using the VS Code ESLint extension in a TypeScript setup. Especially make sure that you can validate TypeScript files successfully in a terminal using the `eslint` command.

This project itself uses ESLint to validate its TypeScript files. So it can be used as a blueprint to get started.

### Enable TypeScript file validation

To enable TypeScript file validation in the ESLint extension please add the following to your VS Code settings (either user or workspace):

```json
	"eslint.validate": [
		{ "language": "typescript", "autoFix": true }
	]
```

To avoid validation from any TSLint installation disable TSLint using `"tslint.enable": false`.

### Mono repository setup

As with JavaScript validating TypeScript in a mono repository requires that you tell the VS Code ESLint extension what the current working directories are. Use the `eslint.workingDirectories` setting to do so. For this repository the working directory setup looks as follows:

```json
	"eslint.workingDirectories": [
		{ "directory": "./client", "changeProcessCWD": true },
		{ "directory": "./server", "changeProcessCWD": true }
	]
```