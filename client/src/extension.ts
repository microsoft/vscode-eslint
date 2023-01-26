/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import * as fs from 'fs';
import {
	workspace as Workspace, window as Window, commands as Commands, Disposable, ExtensionContext, TextDocument
} from 'vscode';

import {
	LanguageClient
} from 'vscode-languageclient/node';

import { Validate } from './shared/settings';

import { findEslint } from './node-utils';
import { pickFolder } from './vscode-utils';
import { TaskProvider } from './tasks';
import { ESLintClient, Validator } from './client';

function createDefaultConfiguration(): void {
	const folders = Workspace.workspaceFolders;
	if (!folders) {
		void Window.showErrorMessage('An ESLint configuration can only be generated if VS Code is opened on a workspace folder.');
		return;
	}
	const noConfigFolders = folders.filter(folder => {
		const configFiles = ['.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yaml', '.eslintrc.yml', '.eslintrc', '.eslintrc.json'];
		for (const configFile of configFiles) {
			if (fs.existsSync(path.join(folder.uri.fsPath, configFile))) {
				return false;
			}
		}
		return true;
	});
	if (noConfigFolders.length === 0) {
		if (folders.length === 1) {
			void Window.showInformationMessage('The workspace already contains an ESLint configuration file.');
		} else {
			void Window.showInformationMessage('All workspace folders already contain an ESLint configuration file.');
		}
		return;
	}
	void pickFolder(noConfigFolders, 'Select a workspace folder to generate a ESLint configuration for').then(async (folder) => {
		if (!folder) {
			return;
		}
		const folderRootPath = folder.uri.fsPath;
		const terminal = Window.createTerminal({
			name: `ESLint init`,
			cwd: folderRootPath
		});
		const eslintCommand = await findEslint(folderRootPath);
		terminal.sendText(`${eslintCommand} --init`);
		terminal.show();
	});
}

let onActivateCommands: Disposable[] | undefined;
let client: LanguageClient;
const taskProvider: TaskProvider = new TaskProvider();
const validator: Validator = new Validator();

export function activate(context: ExtensionContext) {

	function didOpenTextDocument(textDocument: TextDocument) {
		if (activated) {
			return;
		}
		if (validator.check(textDocument) !== Validate.off) {
			openListener.dispose();
			configurationListener.dispose();
			activated = true;
			realActivate(context);
		}
	}

	function configurationChanged() {
		if (activated) {
			return;
		}
		for (const textDocument of Workspace.textDocuments) {
			if (validator.check(textDocument) !== Validate.off) {
				openListener.dispose();
				configurationListener.dispose();
				activated = true;
				realActivate(context);
				return;
			}
		}
	}

	let activated: boolean = false;
	const openListener: Disposable = Workspace.onDidOpenTextDocument(didOpenTextDocument);
	const configurationListener: Disposable = Workspace.onDidChangeConfiguration(configurationChanged);

	const notValidating = () => {
		const enabled = Workspace.getConfiguration('eslint', Window.activeTextEditor?.document).get('enable', true);
		if (!enabled) {
			void Window.showInformationMessage(`ESLint is not running because the deprecated setting 'eslint.enable' is set to false. Remove the setting and use the extension disablement feature.`);
		} else {
			void Window.showInformationMessage('ESLint is not running. By default only TypeScript and JavaScript files are validated. If you want to validate other file types please specify them in the \'eslint.probe\' setting.');
		}
	};
	onActivateCommands = [
		Commands.registerCommand('eslint.executeAutofix', notValidating),
		Commands.registerCommand('eslint.showOutputChannel', notValidating),
		Commands.registerCommand('eslint.migrateSettings', notValidating),
		Commands.registerCommand('eslint.restart', notValidating)
	];

	context.subscriptions.push(
		Commands.registerCommand('eslint.createConfig', createDefaultConfiguration)
	);

	taskProvider.start();
	configurationChanged();
}

function realActivate(context: ExtensionContext): void {

	if (onActivateCommands) {
		onActivateCommands.forEach(command => command.dispose());
		onActivateCommands = undefined;
	}

	let acknowledgePerformanceStatus: () => void;
	[client, acknowledgePerformanceStatus] = ESLintClient.create(context, validator);

	context.subscriptions.push(
		Commands.registerCommand('eslint.showOutputChannel', async () => {
			client.outputChannel.show();
			acknowledgePerformanceStatus();
		}),
		Commands.registerCommand('eslint.migrateSettings', () => {
			void ESLintClient.migrateSettings(client);
		}),
		Commands.registerCommand('eslint.restart', () => {
			client.restart().catch((error) => client.error(`Restarting client failed`, error, 'force'));
		})
	);

	client.start().catch((error) => client.error(`Starting the server failed.`, error, 'force'));
}

export function deactivate(): Promise<void> {
	if (onActivateCommands !== undefined) {
		onActivateCommands.forEach(command => command.dispose());
	}
	taskProvider.dispose();
	return client !== undefined ? client.stop() : Promise.resolve();
}