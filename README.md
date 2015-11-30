# VSCode ESLint

[![Build Status](https://travis-ci.org/Microsoft/vscode-eslint.svg?branch=master)](https://travis-ci.org/Microsoft/vscode-eslint)

Extension to integrate [ESLint](http://eslint.org/) into VSCode.

## Development setup
- run npm install inside the `eslint` and `eslint-server` folders
- open VS Code on `eslint` and `eslint-server`

## Developing the server
- open VS Code on `eslint-server`
- run `npm run compile` or `npm run watch` to build the server and copy it into the `eslint` folder
- to debug press F5 which attaches a debugger to the server

## Developing the extension/client
- open VS Code on `eslint`
- run F5 to build and debug the extension