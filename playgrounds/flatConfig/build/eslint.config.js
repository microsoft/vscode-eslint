module.exports = [
    ...require('../eslint.config.js'),
    {
        rules: {
            "no-const-assign": "warn",
            "no-this-before-super": "warn",
            "no-undef": "warn",
            "no-unreachable": "warn",
            "no-unused-vars": "warn",
            "constructor-super": "warn",
            "valid-typeof": "warn",
            "no-extra-semi": "warn",
            "curly": "warn",
            "no-console": ["warn", { "allow": ["warn", "error"] }],
            "eqeqeq": ["error", "always", {"null": "ignore"}]
        }
    }
];