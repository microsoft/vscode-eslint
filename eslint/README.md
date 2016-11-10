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
- `eslint.options`: options to configure how eslint is started using the [ESLint CLI Engine API](http://eslint.org/docs/developer-guide/nodejs-api#cliengin). Defaults to an empty option bag.
- `eslint.run` - run the linter `onSave` or `onType`, default is `onType`.
- `eslint.nodePath` - use this setting if an installed ESLint package can't be detected, for example `/myGlobalNodePackages/node_modules`.

## Commands:

This extension contributes the following commands to the Command palette.

- `Create '.eslintrc.json' file`: creates a new `.eslintrc.json` file.
- `Fix all auto-fixable problems`: applies ESLint auto-fix resolutions to all fixable problems.

## Release Notes:

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
