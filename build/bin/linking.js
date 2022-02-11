/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
 "use strict";
//@ts-check

const path  = require('path');
const shell = require('shelljs');

const fs = require('fs');
const promisify = require('util').promisify;
const stat = promisify(fs.stat);
const readdir = promisify(fs.readdir);
const mkdir = promisify(fs.mkdir);
const exists = promisify(fs.exists);
const unlink = promisify(fs.unlink);

/**
 * @param {string} source
 * @param {string} dest
 */
const hardLink = exports.hardLink = async function(source, dest) {
	const sourceStat = await stat(source);
	if (sourceStat.isFile()) {
		shell.ln('-f', source, dest);
	} else {
		await mkdir(dest);
		const files = await readdir(source);
		for (const file of files) {
			if (file === '.' || file === '..') {
				continue;
			}
			await hardLink(path.join(source, file), path.join(dest, file));
		}
	}
}

const tryHardLink = exports.tryHardLink = async function(source, dest) {
	console.log(`Linking recusively ${source} -> ${dest}`);
	if (await exists(dest)) {
		shell.rm('-rf', dest);
	}
	await hardLink(source, dest)
}

exports.softLink = async function(source, dest) {
	if (await exists(dest)) {
		shell.rm('-rf', dest);
	}
	const parent = path.dirname(dest);
	if (!await exists(parent)) {
		await mkdir(parent, { recursive: true });
	}
	shell.ln('-s', source, dest);
}

/**
 * @param {string} module
 * @param {string} name
 * @param {string} source
 */
const tryLink = exports.tryLink = async function(module, name, source) {
	const current = process.cwd();
	try {
		const nodeModules = path.join(module, 'node_modules');
		if (!await exists(nodeModules)) {
			await mkdir(nodeModules);
		}
		process.chdir(nodeModules);
		if (await exists(name)) {
			shell.rm('-rf' , name);
		}
		shell.ln('-s', source, name);
	} finally {
		process.chdir(current);
	}
}

exports.tryLinkTextDocument = async function(module, languageServerDirectory) {
	return tryLink(module, 'vscode-languageserver-textdocument', path.join(languageServerDirectory, 'textDocument'));
}

exports.tryLinkJsonRpc = async function(module, languageServerDirectory) {
	return tryLink(module, 'vscode-jsonrpc', path.join(languageServerDirectory, 'jsonrpc'));
}

exports.tryLinkTypes = async function(module, languageServerDirectory) {
	return tryLink(module, 'vscode-languageserver-types', path.join(languageServerDirectory, 'types'));
}

exports.tryLinkProtocol = async function(module, languageServerDirectory) {
	return tryLink(module, 'vscode-languageserver-protocol', path.join(languageServerDirectory, 'protocol'));
}

exports.tryLinkServer = async function(module, languageServerDirectory) {
	return tryLink(module, 'vscode-languageserver', path.join(languageServerDirectory, 'server'));
}

exports.tryLinkClient = async function(module, languageServerDirectory) {
	return tryLink(module, 'vscode-languageclient', path.join(languageServerDirectory, 'client'));
}