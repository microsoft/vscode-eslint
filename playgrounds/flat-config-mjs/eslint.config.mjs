/** Globals is commonjs */
import globals from 'globals';
const { browser, node, es6, commonjs } = globals;
import typescriptParser from '@typescript-eslint/parser';
import typescriptPlugin from '@typescript-eslint/eslint-plugin';

export default [
	"eslint:recommended",
	{
		files: ["**/*.js"],
		languageOptions: {
			sourceType: "module",
			globals: {
				...browser,
				...node,
				...es6,
				...commonjs
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