import * as fs from 'fs';
import * as path from 'path';

function exists(file: string): Promise<boolean> {
	return new Promise<boolean>((resolve, _reject) => {
		fs.exists(file, (value) => {
			resolve(value);
		});
	});
}

export async function findEslint(rootPath: string): Promise<string> {
	const platform = process.platform;
	if (platform === 'win32' && await exists(path.join(rootPath, 'node_modules', '.bin', 'eslint.cmd'))) {
		return path.join('.', 'node_modules', '.bin', 'eslint.cmd');
	} else if ((platform === 'linux' || platform === 'darwin') && await exists(path.join(rootPath, 'node_modules', '.bin', 'eslint'))) {
		return path.join('.', 'node_modules', '.bin', 'eslint');
	} else {
		return 'eslint';
	}
}

const GLOBSTAR = '**';
const GLOB_SPLIT = '/';
const PATH_REGEX = '[/\\\\]';		// any slash or backslash
const NO_PATH_REGEX = '[^/\\\\]';	// any non-slash and non-backslash

export function glob2RegExp(pattern: string): string {
	if (!pattern) {
		return '';
	}

	let regEx = '';

	// Split up into segments for each slash found
	const segments = splitGlobAware(pattern, GLOB_SPLIT);

	// Special case where we only have globstars
	if (segments.every(s => s === GLOBSTAR)) {
		regEx = '.*';
	}

	// Build regex over segments
	else {
		let previousSegmentWasGlobStar = false;
		segments.forEach((segment, index) => {

			// Globstar is special
			if (segment === GLOBSTAR) {

				// if we have more than one globstar after another, just ignore it
				if (!previousSegmentWasGlobStar) {
					regEx += starsToRegExp(2);
					previousSegmentWasGlobStar = true;
				}

				return;
			}

			// States
			let inBraces = false;
			let braceVal = '';

			let inBrackets = false;
			let bracketVal = '';

			for (const char of segment) {
				// Support brace expansion
				if (char !== '}' && inBraces) {
					braceVal += char;
					continue;
				}

				// Support brackets
				if (inBrackets && (char !== ']' || !bracketVal) /* ] is literally only allowed as first character in brackets to match it */) {
					let res: string;

					// range operator
					if (char === '-') {
						res = char;
					}

					// negation operator (only valid on first index in bracket)
					else if ((char === '^' || char === '!') && !bracketVal) {
						res = '^';
					}

					// glob split matching is not allowed within character ranges
					// see http://man7.org/linux/man-pages/man7/glob.7.html
					else if (char === GLOB_SPLIT) {
						res = '';
					}

					// anything else gets escaped
					else {
						res = escapeRegExpCharacters(char);
					}

					bracketVal += res;
					continue;
				}

				switch (char) {
					case '{':
						inBraces = true;
						continue;

					case '[':
						inBrackets = true;
						continue;

					case '}':
						const choices = splitGlobAware(braceVal, ',');

						// Converts {foo,bar} => [foo|bar]
						const braceRegExp = `(?:${choices.map(c => glob2RegExp(c)).join('|')})`;

						regEx += braceRegExp;

						inBraces = false;
						braceVal = '';

						break;

					case ']':
						regEx += ('[' + bracketVal + ']');

						inBrackets = false;
						bracketVal = '';

						break;


					case '?':
						regEx += NO_PATH_REGEX; // 1 ? matches any single character except path separator (/ and \)
						continue;

					case '*':
						regEx += starsToRegExp(1);
						continue;

					default:
						regEx += escapeRegExpCharacters(char);
				}
			}

			// Tail: Add the slash we had split on if there is more to come and the remaining pattern is not a globstar
			// For example if pattern: some/**/*.js we want the "/" after some to be included in the RegEx to prevent
			// a folder called "something" to match as well.
			// However, if pattern: some/**, we tolerate that we also match on "something" because our globstar behaviour
			// is to match 0-N segments.
			if (index < segments.length - 1 && (segments[index + 1] !== GLOBSTAR || index + 2 < segments.length)) {
				regEx += PATH_REGEX;
			}

			// reset state
			previousSegmentWasGlobStar = false;
		});
	}

	return regEx;
}

function splitGlobAware(pattern: string, splitChar: string): string[] {
	if (!pattern) {
		return [];
	}

	const segments: string[] = [];

	let inBraces = false;
	let inBrackets = false;

	let curVal = '';
	for (const char of pattern) {
		switch (char) {
			case splitChar:
				if (!inBraces && !inBrackets) {
					segments.push(curVal);
					curVal = '';

					continue;
				}
				break;
			case '{':
				inBraces = true;
				break;
			case '}':
				inBraces = false;
				break;
			case '[':
				inBrackets = true;
				break;
			case ']':
				inBrackets = false;
				break;
		}

		curVal += char;
	}

	// Tail
	if (curVal) {
		segments.push(curVal);
	}

	return segments;
}

function starsToRegExp(starCount: number): string {
	switch (starCount) {
		case 0:
			return '';
		case 1:
			return `${NO_PATH_REGEX}*?`; // 1 star matches any number of characters except path separator (/ and \) - non greedy (?)
		default:
			// Matches:  (Path Sep OR Path Val followed by Path Sep OR Path Sep followed by Path Val) 0-many times
			// Group is non capturing because we don't need to capture at all (?:...)
			// Overall we use non-greedy matching because it could be that we match too much
			return `(?:${PATH_REGEX}|${NO_PATH_REGEX}+${PATH_REGEX}|${PATH_REGEX}${NO_PATH_REGEX}+)*?`;
	}
}

function escapeRegExpCharacters(value: string): string {
	return value.replace(/[\\\{\}\*\+\?\|\^\$\.\[\]\(\)]/g, '\\$&');
}

export function toOSPath(path: string): string {
	if (process.platform === 'win32') {
		path = path.replace(/^\/(\w)\//, '$1:\\');
		return path.replace(/\//g, '\\');
	} else {
		return path;
	}
}