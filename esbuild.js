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

function createContexts() {
	return Promise.all([
		esbuild.context(clientOptions),
		esbuild.context(serverOptions),
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