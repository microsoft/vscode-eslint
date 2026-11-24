/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

// Metadata variants for the documentation-action language-server test.
function createRule(docs) {
	return {
		meta: {
			type: 'problem',
			fixable: 'code',
			schema: [],
			...(docs === undefined ? {} : { docs })
		},
		create(context) {
			return {
				Program(node) {
					context.report({
						node,
						message: 'Use let instead of var.',
						fix: fixer => fixer.replaceTextRange([0, 3], 'let')
					});
				}
			};
		}
	};
}

module.exports = [{
	plugins: {
		test: {
			rules: {
				missing: createRule(),
				empty: createRule({ url: '' }),
				invalid: createRule({ url: 42 }),
				valid: createRule({ url: 'https://example.com/rule' })
			}
		}
	},
	rules: {
		'test/missing': 'error',
		'test/empty': 'error',
		'test/invalid': 'error',
		'test/valid': 'error'
	}
}];
