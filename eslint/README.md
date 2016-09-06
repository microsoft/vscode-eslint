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

- `eslint.enable`: enable/diable eslint. Is enabled by default.
- `eslint.options`: options to configure how eslint is started using the [ESLint CLI Engine API](http://eslint.org/docs/developer-guide/nodejs-api#cliengin). Defaults to an empty option bag.
- `eslint.run` - run the linter `onSave` or `onType`, default is `onType`.

## Commands:

This extension contributes the following commands to the Command palette.

- `Create '.eslintrc.json' file`: creates a new `.eslintrc.json` file.
- `Fix all auto-fixable problems`: applies ESLint auto-fix resolutions to all fixable problems.