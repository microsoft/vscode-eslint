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

export function getFileSystemPath(uri: URI): string;
export function getFileSystemPath(uri: URI, useRealPath?: boolean): string;
export function getFileSystemPath(uri: URI, useRealPath?: boolean): string {
	let result = uri.fsPath;
	if (process.platform === 'win32' && result.length >= 2 && result[1] === ':') {
		// Node by default uses an upper case drive letter and ESLint uses
		// === to compare paths which results in the equal check failing
		// if the drive letter is lower case in th URI. Ensure upper case.
		result = result[0].toUpperCase() + result.substr(1);
	}
	// Real path handling:
	//  - win32 / darwin (legacy): always attempt realpath; when useRealPath=false only adopt if casing differs
	//    (preserves historical behavior of normalizing drive / case); when useRealPath=true adopt full realpath.
	//  - other platforms: honor useRealPath strictly; only attempt & adopt realpath when true.
	if (process.platform === 'win32' || process.platform === 'darwin') {
		try {
			const realpath = fs.realpathSync.native(result);
			if (useRealPath === true) {
				result = realpath;
			} else if (realpath.toLowerCase() === result.toLowerCase()) {
				result = realpath; // legacy: adopt only casing change
			}
		} catch {
			// ignore
		}
	} else if (useRealPath) {
		try {
			result = fs.realpathSync.native(result);
		} catch {
			// ignore
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
