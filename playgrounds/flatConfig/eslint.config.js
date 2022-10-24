const globals = require('globals');

module.exports = [
	"eslint:recommended",
	{
		files: ["**/*.js"],
		languageOptions: {
			parserOptions: {
				sourceType: "module"
			},
			globals: {
				...globals.browser,
				...globals.node,
				...globals.es6,
				...globals.commonjs
			}
		},
	},
	{
		files: ["sub/*.js"],
		rules: {
			"no-undef": "warn",
			"no-console": "warn"
		}
	}
]