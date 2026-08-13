/* Browser stub for the 'path' module used by ESLint's Linter class */
'use strict';

const sep = '/';
const delimiter = ':';

function normalize(p) {
	const parts = p.split('/').filter((part, i) => part !== '' || i === 0);
	const result = [];
	for (const part of parts) {
		if (part === '..') {
			result.pop();
		} else if (part !== '.') {
			result.push(part);
		}
	}
	return result.join('/') || '.';
}

function join(...args) {
	return normalize(args.join('/'));
}

function extname(p) {
	const base = basename(p);
	const dotIndex = base.lastIndexOf('.');
	return dotIndex <= 0 ? '' : base.slice(dotIndex);
}

function basename(p, ext) {
	const base = p.split('/').pop() || '';
	if (ext && base.endsWith(ext)) {
		return base.slice(0, base.length - ext.length);
	}
	return base;
}

function dirname(p) {
	const parts = p.split('/');
	parts.pop();
	return parts.join('/') || '/';
}

function resolve(...args) {
	let resolved = '';
	for (let i = args.length - 1; i >= 0; i--) {
		const arg = args[i];
		if (arg) {
			resolved = arg.startsWith('/') ? normalize(arg + '/' + resolved) : normalize(arg + '/' + resolved);
			if (arg.startsWith('/')) {
				break;
			}
		}
	}
	return resolved || '/';
}

function isAbsolute(p) {
	return p.startsWith('/');
}

function relative(from, to) {
	const fromParts = normalize(from).split('/');
	const toParts = normalize(to).split('/');
	while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
		fromParts.shift();
		toParts.shift();
	}
	return [...fromParts.map(() => '..'), ...toParts].join('/') || '.';
}

module.exports = {
	sep,
	delimiter,
	normalize,
	join,
	extname,
	basename,
	dirname,
	resolve,
	isAbsolute,
	relative,
	posix: {
		sep,
		delimiter,
		normalize,
		join,
		extname,
		basename,
		dirname,
		resolve,
		isAbsolute,
		relative,
	},
};
