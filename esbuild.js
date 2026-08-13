/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
//@ts-check
const esbuild = require('esbuild');

/**
 * @typedef {import('esbuild').BuildOptions} BuildOptions
 */

/** @type BuildOptions */
const clientOptions = {
	bundle: true,
	external: ['vscode'],
	target: 'ES2022',
	platform: 'node',
	sourcemap: false,
	entryPoints: ['client/src/extension.ts'],
	outfile: 'client/out/extension.js',
	preserveSymlinks: true,
	format: 'cjs',
};

/** @type BuildOptions */
const serverOptions = {
	bundle: true,
	target: 'ES2022',
	platform: 'node',
	sourcemap: false,
	entryPoints: ['server/src/eslintServer.ts'],
	outfile: 'server/out/eslintServer.js',
	preserveSymlinks: true,
	format: 'cjs',
};

const path = require('path');

/** @type {Record<string, string>} */
const browserNodePolyfills = {
	'node:path': path.resolve('./browser-stubs/path.js'),
	'node:util': path.resolve('./browser-stubs/util.js'),
	'path': path.resolve('./browser-stubs/path.js'),
	'util': path.resolve('./browser-stubs/util.js'),
};

/** @type BuildOptions */
const browserClientOptions = {
	bundle: true,
	external: ['vscode'],
	target: 'ES2022',
	platform: 'browser',
	sourcemap: false,
	entryPoints: ['client/src/browserExtension.ts'],
	outfile: 'client/out/browserExtension.js',
	preserveSymlinks: true,
	format: 'cjs',
	alias: browserNodePolyfills,
};

/** @type BuildOptions */
const browserServerOptions = {
	bundle: true,
	target: 'ES2022',
	platform: 'browser',
	sourcemap: false,
	entryPoints: ['server/src/browserServer.ts'],
	outfile: 'server/out/browserServer.js',
	preserveSymlinks: true,
	format: 'iife',
	alias: browserNodePolyfills,
};

function createContexts() {
	return Promise.all([
		esbuild.context(clientOptions),
		esbuild.context(serverOptions),
		esbuild.context(browserClientOptions),
		esbuild.context(browserServerOptions),
	]);
}

createContexts().then(contexts => {
	if (process.argv[2] === '--watch') {
		const promises = [];
		for (const context of contexts) {
			promises.push(context.watch());
		}
		return Promise.all(promises).then(() => { return undefined; });
	} else {
		const promises = [];
		for (const context of contexts) {
			promises.push(context.rebuild());
		}
		Promise.all(promises).then(async () => {
			for (const context of contexts) {
				await context.dispose();
			}
		}).then(() => { return undefined; }).catch(console.error);
	}
}).catch(console.error);