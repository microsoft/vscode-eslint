const globals = require('globals');
const typescriptParser =  require('@typescript-eslint/parser');
const typescriptPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
	"eslint:recommended",
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
	},
	{
		files: ["sub/*.js"],
		rules: {
			"no-undef": "warn",
			"no-console": "warn"
		}
	},
	{
		files: ["*.ts", "**/*.ts"],
		plugins: {
			"@typescript-eslint": typescriptPlugin
		},
		languageOptions: {
			sourceType: "module",
			parser: typescriptParser,
			parserOptions: {
				project: "./tsconfig.json",
				ecmaVersion: 2020
			}
		},
		rules: {
			"semi": "off",
			"@typescript-eslint/semi": "error",
			"no-extra-semi": "warn",
			"curly": "warn",
			"quotes": ["error", "single", { "allowTemplateLiterals": true } ],
			"eqeqeq": "error",
			"indent": "off",
			"@typescript-eslint/indent": ["warn", "tab", { "SwitchCase": 1 } ],
			"@typescript-eslint/no-floating-promises": "error"
		}
	}
]