/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check

'use strict';

const path = require('path');

/** @type {import('webpack').Configuration} */
module.exports = {
	mode: 'none',
	target: 'webworker',
	resolve: {
		mainFields: ['browser', 'module', 'main'],
		extensions: ['.ts', '.js'],
		conditionNames: ['browser', 'import', 'require'],
		symlinks: false,
		fallback: {
			path: require.resolve('path-browserify'),
		}
	},
	module: {
		rules: [{
			test: /\.ts$/,
			exclude: /node_modules/,
			use: [{
				loader: 'ts-loader',
				options: {
					compilerOptions: {
						sourceMap: true,
					}
				}
			}]
		}]
	},
	output: {
		filename: 'browserServer.js',
		path: path.join(__dirname, 'out'),
		libraryTarget: 'var',
		library: 'serverExportVar',
	},
	entry: {
		browserServer: './src/browserServer.ts',
	},
	context: path.join(__dirname),
	devtool: 'source-map',
};
