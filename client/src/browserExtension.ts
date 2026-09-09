/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { ExtensionContext, Uri } from 'vscode';
import {
	LanguageClient, LanguageClientOptions, RevealOutputChannelOn
} from 'vscode-languageclient/browser';

let client: LanguageClient;

export function activate(context: ExtensionContext): void {
	const serverWorker = new Worker(
		Uri.joinPath(context.extensionUri, 'server', 'out', 'browserServer.js').toString()
	);

	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ scheme: 'file', language: 'javascript' },
			{ scheme: 'file', language: 'javascriptreact' },
			{ scheme: 'vscode-vfs', language: 'javascript' },
			{ scheme: 'vscode-vfs', language: 'javascriptreact' },
			{ scheme: 'untitled', language: 'javascript' },
			{ scheme: 'untitled', language: 'javascriptreact' },
		],
		revealOutputChannelOn: RevealOutputChannelOn.Never,
		diagnosticPullOptions: {
			onChange: true,
			onSave: true,
			onFocus: true,
		},
	};

	client = new LanguageClient('ESLint', 'ESLint', serverWorker, clientOptions);
	client.start();
}

export function deactivate(): Promise<void> {
	return client !== undefined ? client.stop() : Promise.resolve();
}
