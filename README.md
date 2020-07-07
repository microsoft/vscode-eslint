# VS Code ESLint extension

[![Build Status](https://dev.azure.com/ms/vscode-eslint/_apis/build/status/Microsoft.vscode-eslint)](https://dev.azure.com/ms/vscode-eslint/_build/latest?definitionId=18)

Integrates [ESLint](http://eslint.org/) into VS Code. If you are new to ESLint check the [documentation](http://eslint.org/).

The extension uses the ESLint library installed in the opened workspace folder. If the folder doesn't provide one the extension looks for a global install version. If you haven't installed ESLint either locally or globally do so by running `npm install eslint` in the workspace folder for a local install or `npm install -g eslint` for a global install.

On new folders you might also need to create a `.eslintrc` configuration file. You can do this by either using the VS Code command `Create ESLint configuration` or by running the `eslint` command in a terminal. If you have installed ESLint globally (see above) then run [`eslint --init`](http://eslint.org/docs/user-guide/command-line-interface) in a terminal. If you have installed ESLint locally then run [`.\node_modules\.bin\eslint --init`](http://eslint.org/docs/user-guide/command-line-interface) under Windows and [`./node_modules/.bin/eslint --init`](http://eslint.org/docs/user-guide/command-line-interface) under Linux and Mac.

## Release Notes

The 2.0.4 version of the extension contains the following major improvements:

* Improved TypeScript detection - As soon as TypeScript is correctly configured inside ESLint, you no longer need additional configuration through VS Code's `eslint.validate` setting. The same is true for HTML and Vue.js files.
* Glob working directory support - Projects that have a complex folder structure and need to customize the working directories via `eslint.workingDirectories` can now use glob patterns instead of listing every project folder. For example, `{ "pattern": "code-*" }` will match all project folders starting with `code-`. In addition, the extension now changes the working directory by default. You can disable this feature with the new `!cwd` property.
* Formatter support: ESLint can now be used as a formatter. To enable this feature use the `eslint.format.enable` setting.
* Improved Auto Fix on Save - Auto Fix on Save is now part of VS Code's Code Action on Save infrastructure and computes all possible fixes in one round. It is customized via the `editor.codeActionsOnSave` setting. The setting supports the ESLint specific property `source.fixAll.eslint`. The extension also respects the generic property `source.fixAll`.

The setting below turns on Auto Fix for all providers including ESLint:

```json
    "editor.codeActionsOnSave": {
        "source.fixAll": true
    }
```

In contrast, this configuration only turns it on for ESLint:

```json
    "editor.codeActionsOnSave": {
        "source.fixAll.eslint": true
    }
```

You can also selectively disable ESLint via:

```json
    "editor.codeActionsOnSave": {
        "source.fixAll": true,
        "source.fixAll.eslint": false
    }
```

Also note that there is a time budget of 750ms to run code actions on save which might not be enough for large JavaScript / TypeScript file. You can increase the time budget using the `editor.codeActionsOnSaveTimeout` setting.

The old `eslint.autoFixOnSave` setting is now deprecated and can safely be removed.

## Settings Options

If you are using an ESLint extension version < 2.x then please refer to the settings options [here](https://github.com/microsoft/vscode-eslint/blob/master/history/settings_1_9_x.md).

This extension contributes the following variables to the [settings](https://code.visualstudio.com/docs/customization/userandworkspace):

- `eslint.enable`: enable/disable ESLint. Is enabled by default.
- `eslint.debug`: enables ESLint's debug mode (same as --debug  command line option). Please see the ESLint output channel for the debug output. This options is very helpful to track down configuration and installation problems with ESLint since it provides verbose information about how ESLint is validating a file.
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
- `eslint.quiet` - ignore warnings.
- `eslint.runtime` - use this setting to set the path of the node runtime to run ESLint under.
- `eslint.nodePath` - use this setting if an installed ESLint package can't be detected, for example `/myGlobalNodePackages/node_modules`.
- `eslint.probe` = an array for language identifiers for which the ESLint extension should be activated and should try to validate the file. If validation fails for probed languages the extension says silent. Defaults to `["javascript", "javascriptreact", "typescript", "typescriptreact", "html", "vue"]`.
- `eslint.validate` - an array of language identifiers specifying the files for which validation is to be enforced. This is an old legacy setting and should in normal cases not be necessary anymore. Defaults to `["javascript", "javascriptreact"]`.
- `eslint.format.enable`: enables ESLint as a formatter for validated files. Although you can also use the formatter on save using the setting `editor.formatOnSave` it is recommended to use the `editor.codeActionsOnSave` feature since it allows for better configurability.
- `eslint.workingDirectories` - specifies how the working directories ESLint is using are computed. ESLint resolves configuration files (e.g. `eslintrc`, `.eslintignore`) relative to a working directory so it is important to configure this correctly. If executing ESLint in the terminal requires you to change the working directory in the terminal into a sub folder then it is usually necessary to tweak this setting. (see also [CLIEngine options#cwd](https://eslint.org/docs/developer-guide/nodejs-api#cliengine)). Please also keep in mind that the `.eslintrc*` file is resolved considering the parent directories whereas the `.eslintignore` file is only honored in the current working directory. The following values can be used:
  - `[{ "mode": "location" }]` (@since 2.0.0): instructs ESLint to uses the workspace folder location or the file location (if no workspace folder is open) as the working directory. This is the default and is the same strategy as used in older versions of the ESLint extension (1.9.x versions).
  - `[{ "mode": "auto" }]` (@since 2.0.0): instructs ESLint to infer a working directory based on the location of `package.json`, `.eslintignore` and `.eslintrc*` files. This might work in many cases but can lead to unexpected results as well.
  - `string[]`: an array of working directories to use.
  Consider the following directory layout:
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
    "eslint.workingDirectories": [ "./client", "./server" ]
  ```
  will validate files inside the server directory with the server directory as the current eslint working directory. Same for files in the client directory. The ESLint extension will also change the process's working directory to the provided directories. If this is not wanted a literal with the `!cwd` property can be used (e.g. `{ "directory: "./client", "!cwd": true }`). This will use the client directory as the ESLint working directory but will not change the process`s working directory.
  - `{ "pattern": glob pattern }` (@since 2.0.0): Allows to specify a pattern to detect the working directory. This is basically a short cut for listing every directory. If you have a mono repository with all your projects being below a packages folder you can use `{ "pattern": "./packages/*/" }` to make all these folders working directories.
- `eslint.codeAction.disableRuleComment` - object with properties:
  - `enable` - show disable lint rule in the quick fix menu. `true` by default.
  - `location` - choose to either add the `eslint-disable` comment on the `separateLine` or `sameLine`. `separateLine` is the default.
  Example:
  ```json
  { "enable": true, "location": "sameLine" }
  ```
- `eslint.codeAction.showDocumentation` - object with properties:
  - `enable` - show open lint rule documentation web page in the quick fix menu. `true` by default.

- `eslint.codeActionsOnSave.mode` (@since 2.0.12): controls which problems are fix when running code actions on save
  - `all`: fixes all possible problems by revalidating the file's content. This executes the same code path as running eslint with the `--fix` option in the terminal and therefore can take some time. This is the default value.
  - `problems`: fixes only the currently known fixable problems as long as their textual edits are non overlapping. This mode is a lot faster but very likely only fixes parts of the problems.

- `eslint.format.enable` (@since 2.0.0): uses ESlint as a formatter for files that are validated by ESLint. If enabled please ensure to disable other formatters if you want to make this the default. A good way to do so is to add the following setting `"[javascript]": { "editor.defaultFormatter": "dbaeumer.vscode-eslint" }` for JavaScript. For TypeScript you need to add `"[typescript]": { "editor.defaultFormatter": "dbaeumer.vscode-eslint" }`.
- `eslint.onIgnoredFiles` (@since 2.0.10): used to control whether warings should be generated when trying to lint ignored files. Default is `off`. Can be set to `warn`.
- `editor.codeActionsOnSave` (@since 2.0.0): this setting now supports an entry `source.fixAll.eslint`. If set to true all auto-fixable ESLint errors from all plugins will be fixed on save. You can also selectively enable and disabled specific languages using VS Code's language scoped settings. To disable `codeActionsOnSave` for HTML files use the following setting:

```json
  "[html]": {
    "editor.codeActionsOnSave": {
      "source.fixAll.eslint": false
    }
  }
```

The old `eslint.autoFixOnSave` setting is now deprecated and can safely be removed. Please also note that if you use ESLint as your default formatter you should turn off `editor.formatOnSave` when you have turned on `editor.codeActionsOnSave`. Otherwise you file gets fixed twice which in unnecessary.

## Settings Migration

If the old `eslint.autoFixOnSave` option is set to true ESLint will prompt to convert it to the new `editor.codeActionsOnSave` format. If you want to avoid the migration you can respond in the dialog in the following ways:

- Not now: the setting will not be migrated by ESLint prompts again the next time you open the workspace
- Never migrate Settings: the settings migration will be disabled by changing the user setting `eslint.migration.2_x` to `off`

The migration can always be triggered manually using the command `ESLint: Migrate Settings`

## Commands:

This extension contributes the following commands to the Command palette.

- `Create '.eslintrc.json' file`: creates a new `.eslintrc.json` file.
- `Fix all auto-fixable problems`: applies ESLint auto-fix resolutions to all fixable problems.
- `Disable ESLint for this Workspace`: disables ESLint extension for this workspace.
- `Enable ESLint for this Workspace`: enable ESLint extension for this workspace.
- `Reset Library Decisions`: Resets the ESLint library validation confirmations.

## Using the extension with VS Code's task running

The extension is linting an individual file only on typing. If you want to lint the whole workspace set `eslint.lintTask.enable` to `true` and the extension will also contribute the `eslint: lint whole folder` task. There is no need anymore to define a custom task in `tasks.json`.

## Using ESLint to validate TypeScript files

A great introduction on how to lint TypeScript using ESlint can be found in the [TypeScript - ESLint](https://github.com/typescript-eslint/typescript-eslint). Please make yourself familiar with the introduction before using the VS Code ESLint extension in a TypeScript setup. Especially make sure that you can validate TypeScript files successfully in a terminal using the `eslint` command.

This project itself uses ESLint to validate its TypeScript files. So it can be used as a blueprint to get started.

To avoid validation from any TSLint installation disable TSLint using `"tslint.enable": false`.

### Mono repository setup

As with JavaScript validating TypeScript in a mono repository requires that you tell the VS Code ESLint extension what the current working directories are. Use the `eslint.workingDirectories` setting to do so. For this repository the working directory setup looks as follows:

```json
	"eslint.workingDirectories": [ "./client", "./server" ]
```

## ESLint 6.x

Migrating from ESLint 5.x to ESLint 6.x might need some adaption (see the [ESLint Migration Guide](https://eslint.org/docs/user-guide/migrating-to-6.0.0) for details). Before filing an issue against the VS Code ESLint extension please ensure that you can successfully validate your files in a terminal using the eslint command.

