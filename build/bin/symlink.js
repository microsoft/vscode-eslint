#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
 "use strict";
//@ts-check

const path = require('path');
const ln = require('./linking');

const root = path.dirname(path.dirname(__dirname));

(async function main() {

	const languageServerDirectory = path.normalize(path.join(root, '../../../LanguageServer/Node'));

	console.log(`Symlinking to language server libs at location ${languageServerDirectory}`);

	// protocol folder
	const clientFolder = path.join(root, 'client');
	await ln.tryLinkJsonRpc(clientFolder, languageServerDirectory);
	await ln.tryLinkTypes(clientFolder, languageServerDirectory);
	await ln.tryLinkProtocol(clientFolder, languageServerDirectory);
	// Hard link the client to have a real path from the node_modules folder
	await ln.tryHardLink(path.join(languageServerDirectory, 'client'), path.join(root, 'client', 'node_modules', 'vscode-languageclient'));

	// server folder
	const serverFolder = path.join(root, 'server');
	await ln.tryLinkTextDocument(serverFolder, languageServerDirectory);
	await ln.tryLinkJsonRpc(serverFolder, languageServerDirectory);
	await ln.tryLinkTypes(serverFolder, languageServerDirectory);
	await ln.tryLinkProtocol(serverFolder, languageServerDirectory);
	await ln.tryLinkServer(serverFolder, languageServerDirectory);
})();