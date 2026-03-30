/* Browser stub for the 'util' module used by ESLint's Linter class */
'use strict';

function deprecate(fn, _message) {
	return fn;
}

function inspect(value) {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function format(fmt, ...args) {
	if (typeof fmt !== 'string') {
		return [fmt, ...args].map(String).join(' ');
	}
	let i = 0;
	return fmt.replace(/%[sdifjoO%]/g, (match) => {
		if (match === '%%') { return '%'; }
		if (i >= args.length) { return match; }
		const arg = args[i++];
		switch (match) {
			case '%s': return String(arg);
			case '%d': case '%i': case '%f': return Number(arg).toString();
			case '%j': return JSON.stringify(arg);
			case '%o': case '%O': return inspect(arg);
			default: return match;
		}
	});
}

module.exports = {
	deprecate,
	inspect,
	format,
};
