/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as fs from 'fs';

import { URI } from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-textdocument';

import * as Is from './is';

/**
 * Special functions to deal with path conversions in the context of ESLint
 */

/**
 * Normalizes the drive letter to upper case which is the default in Node but not in
 * VS Code.
 */
export function normalizeDriveLetter(path: string): string {
	if (process.platform !== 'win32' || path.length < 2 || path[1] !== ':') {
		return path;
	}
	return path[0].toUpperCase() + path.substring(1);
}

const enum CharCode {
	/**
	 * The `\` character.
	 */
	Backslash = 92,
}

/**
 * Check if the path follows this pattern: `\\hostname\sharename`.
 *
 * @see https://msdn.microsoft.com/en-us/library/gg465305.aspx
 * @return A boolean indication if the path is a UNC path, on none-windows
 * always false.
 */
export function isUNC(path: string): boolean {
	if (process.platform !== 'win32') {
		// UNC is a windows concept
		return false;
	}

	if (!path || path.length < 5) {
		// at least \\a\b
		return false;
	}

	let code = path.charCodeAt(0);
	if (code !== CharCode.Backslash) {
		return false;
	}
	code = path.charCodeAt(1);
	if (code !== CharCode.Backslash) {
		return false;
	}
	let pos = 2;
	const start = pos;
	for (; pos < path.length; pos++) {
		code = path.charCodeAt(pos);
		if (code === CharCode.Backslash) {
			break;
		}
	}
	if (start === pos) {
		return false;
	}
	code = path.charCodeAt(pos + 1);
	if (isNaN(code) || code === CharCode.Backslash) {
		return false;
	}
	return true;
}

export function getFileSystemPath(uri: URI): string {
	let result = uri.fsPath;
	if (process.platform === 'win32' && result.length >= 2 && result[1] === ':') {
		// Node by default uses an upper case drive letter and ESLint uses
		// === to compare paths which results in the equal check failing
		// if the drive letter is lower case in th URI. Ensure upper case.
		result = result[0].toUpperCase() + result.substr(1);
	}
	if (process.platform === 'win32' || process.platform === 'darwin') {
		try {
			const realpath = fs.realpathSync.native(result);
			// Only use the real path if only the casing has changed.
			if (realpath.toLowerCase() === result.toLowerCase()) {
				result = realpath;
			}
		} catch {
			// Silently ignore errors from `fs.realpathSync` to handle scenarios where
			// the file being linted is not yet written to disk. This occurs in editors
			// such as Neovim for non-written buffers.
		}
	}
	return result;
}

export function normalizePath(path: string): string;
export function normalizePath(path: undefined): undefined;
export function normalizePath(path: string | undefined): string | undefined {
	if (path === undefined) {
		return undefined;
	}
	if (process.platform === 'win32') {
		return path.replace(/\\/g, '/');
	}
	return path;
}

export function getUri(documentOrUri: string | TextDocument | URI): URI {
	return Is.string(documentOrUri)
		? URI.parse(documentOrUri)
		: documentOrUri instanceof URI
			? documentOrUri
			: URI.parse(documentOrUri.uri);
}
