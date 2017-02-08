# VS Code ESLint extension

Integrates [ESLint](http://eslint.org/) into VS Code. If you are new to ESLint check the [documentation](http://eslint.org/).

The extension uses the ESLint library installed in the opened workspace folder. If the folder doesn't provide one the
extension looks for a global install version. If you haven't installed ESLint either locally or globally do so by running
`npm install eslint` in the workspace folder for a local install or `npm install -g eslint` for a global install.

On new folders you might also need to create a `.eslintrc` configuration file. You can do this by either running
[`eslint --init`](http://eslint.org/docs/user-guide/command-line-interface) in a terminal or by using the VS Code
command `Create '.eslintrc.json' file`.

## Settings Options

This extension contributes the following variables to the [settings](https://code.visualstudio.com/docs/customization/userandworkspace):

- `eslint.enable`: enable/disable eslint. Is enabled by default.
- `eslint.options`: options to configure how eslint is started using the [ESLint CLI Engine API](http://eslint.org/docs/developer-guide/nodejs-api#cliengine). Defaults to an empty option bag.
  An example to point to a custom `.eslintrc.json` file is:
```json
{
	"eslint.options": { "configFile": "C:/mydirectory/.eslintrc.json" }
}
```
- `eslint.run` - run the linter `onSave` or `onType`, default is `onType`.
- `eslint.autoFixOnSave` - enables auto fix on save. Please note auto fix on save is only available if VS Code's `files.autoSave` is either `off`, `onFocusChange` or `onWindowChange`. It will not work with `afterDelay`.
- `eslint.nodePath` - use this setting if an installed ESLint package can't be detected, for example `/myGlobalNodePackages/node_modules`.
- `eslint.validate` - an array of language identifiers specify the files to be validated. See [1.2.1 Release notes](#RN121) for details.
- `eslint.workingDirectories` - an array for working directories to be used. See [1.2.5 Release notes](#RN125) for details.

## Commands:

This extension contributes the following commands to the Command palette.

- `Create '.eslintrc.json' file`: creates a new `.eslintrc.json` file.
- `Fix all auto-fixable problems`: applies ESLint auto-fix resolutions to all fixable problems.
- `Disable ESLint for this Workspace`: disables ESLint extension for this workspace.
- `Enable ESLint for this Workspace`: enable ESLint extension for this workspace.

## Release Notes:

### <a name="RN125"></a>1.2.5

- Validdating a single file (no workspace folder open) will set the working directory to the directory containing the file.
- Added support for working directories. ESLint resolves configuration files relative to a working directory. This new settings allows users to control which working directory is used for which files. Consider the following setups:

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


### 1.2.4

- fixes [.eslintignore is completely ignored](https://github.com/Microsoft/vscode-eslint/issues/198)
- reverted fix for [Does not respect nested eslintignore files](https://github.com/Microsoft/vscode-eslint/issues/111) since it broke the use case of a single global .eslintrc file

### 1.2.3

- Bug fixes:
  - [Does not respect nested eslintignore files](https://github.com/Microsoft/vscode-eslint/issues/111)
  - [eslintrc configuration cascading not being honored ](https://github.com/Microsoft/vscode-eslint/issues/97)
  - [autoFixOnSave not working with eslint.run=onSave](https://github.com/Microsoft/vscode-eslint/issues/158)
  - [autoFixOnSave not listed under Settings Options in Readme](https://github.com/Microsoft/vscode-eslint/issues/188)

### 1.2.2

- Added configuration options to enable code actions and auto fix on save selectively per language. In release 1.2.1 code actions and auto fix on save very still only
available for JavaScript. In 1.2.2 you can now enable this selectively per language. For compatibility it is enabled by default for JavaScript and disabled by default for all
other languages. The reason is that I encounter cases for non JavaScript file types where the computed fixes had wrong positions resulting in 'broken' documents. To enable it simply
provide an object literal in the validate setting with the properties `language` and `autoFix` instead of a simple `string`. An example is:
```json
"eslint.validate": [ "javascript", "javascriptreact", { "language": "html", "autoFix": true } ]
```

### <a name="RN121"></a>1.2.1

- Added support to validate file types other than JavaScript. To enable this, you need to do the following:
  - Configure ESLint with an additional plugin to do the actual validation. For example, to validate HTML files install
`eslint-plugin-html` using `npm install eslint-plugin-html --save-dev` and update the eslint configuration (e.g. .eslintrc.json file)
with `"plugin": [ "html" ]`.
  - Add the corresponding language identifier to the `eslint.validate` setting. Something like `"eslint.validate": [ "javascript", "javascriptreact", "html" ]`.
If the setting is missing, it defaults to `["javascript", "javascriptreact"]`

Please note that code actions and auto fix on save is still only available for JavaScript. The reason is that I detected position problems with fixes contributed by plugins
resulting in broken source code when applied.

### 1.1.0

- Supports more than one ESLint module installation in a workspace. This eases working with typical client / server setups where ESLint is installed
in a `node_modules` folder in the `server` and the `client` directory.
- Improved error handling if a plugin can't be loaded.
- Added commands to enable and disable ESLint.

### 1.0.8

- Supports auto fix on save. Needs to be enabled via `"eslint.autoFixOnSave": true`. Please note that auto fix on save will only happen
if the save happened manually or via focus lost. This is consistent with VS Code's format on save behaviour. Auto fix on save requires
VS Code version 1.6 or newer.

### 1.0.7

- Fixed problem with validating package.json when editing .eslintrc.* files.

### 1.0.5

- Moving to official 2.5.0 language server libraries.

### 1.0.4

- Bug fixing: eslint is validating package.json files

### 1.0.3

- Errors in configuration files are only shown in a status message if the file is not open in the editor. Otherwise message are shown in the output channel only.

### 1.0.2

- Added a status bar item to inform the user about problems with ESLint. A message box only appears if the user attention is required.
- Improved handling of missing corrupted configuration files.
- The ESLint package is now loaded from parent folders as well.
- Added an action to create a .eslintrc.json file.
