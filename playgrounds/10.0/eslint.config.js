const globals = require('globals');

module.exports = [
	{
		ignores: ['dist/**']
	},
	{
		files: ["**/*.js"],
		languageOptions: {
			sourceType: "module",
			globals: {
				...globals.browser,
				...globals.node,
				...globals.es6,
				...globals.commonjs
			}
		},
		rules: {
			"no-use-before-define": "error",
			"no-useless-escape": "error",
			"no-const-assign": "warn",
			"no-this-before-super": "warn",
			"no-undef": "warn",
			"no-unreachable": "warn",
			"no-unused-vars": "warn",
			"constructor-super": "warn",
			"valid-typeof": "warn",
			"no-extra-semi": "warn",
			"curly": "warn",
			"no-console": [
				2,
				{
					"allow": [
						"warn",
						"error"
					]
				}
			],
			"eqeqeq": [
				"error",
				"always",
				{
					"null": "ignore"
				}
			],
			"indent": [
				"warn",
				"tab",
				{
					"VariableDeclarator": {
						"var": 2,
						"let": 2,
						"const": 3
					},
					"MemberExpression": 1,
					"SwitchCase": 1
				}
			]
		}
	}
]