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

enum NodeType {
	text = 'text',
	separator = 'separator',
	brace = 'brace',
	bracket = 'bracket',
	questionMark = 'questionMark',
	star = 'star',
	globStar = 'globStar'
}

interface TextNode {
	type: NodeType.text;
	value: string;
}

interface SeparatorNode {
	type: NodeType.separator;
}

interface QuestionMarkNode {
	type: NodeType.questionMark;
}

interface StarNode {
	type: NodeType.star;
}

interface GlobStarNode {
	type: NodeType.globStar;
}

interface BracketNode {
	type: NodeType.bracket;
	value: string;
}

type BraceAlternative = (TextNode | QuestionMarkNode | StarNode | BracketNode | BraceNode);
interface BraceNode {
	type: NodeType.brace;
	alternatives: BraceAlternative[];
}

type Node = TextNode | SeparatorNode | QuestionMarkNode | StarNode | GlobStarNode | BracketNode | BraceNode;

function escapeRegExpCharacters(value: string): string {
	return value.replace(/[\\\{\}\*\+\?\|\^\$\.\[\]\(\)]/g, '\\$&');
}

class PatternParser {

	private value: string;
	private index: number;

	private mode: 'pattern' | 'brace';
	private stopChar: string | undefined;

	constructor(value: string, mode: 'pattern' | 'brace' = 'pattern') {
		this.value = value;
		this.index = 0;
		this.mode = mode;
		this.stopChar = mode === 'pattern' ? undefined :  '}';
	}

	private makeTextNode(start: number): Node {
		return { type: NodeType.text, value: escapeRegExpCharacters(this.value.substring(start, this.index)) };
	}

	next(): Node | undefined {
		let start = this.index;
		let ch: string | undefined;
		while((ch = this.value[this.index]) !== this.stopChar) {
			switch (ch) {
				case '/':
					if (start < this.index) {
						return this.makeTextNode(start);
					} else {
						this.index++;
						return { type: NodeType.separator };
					}
				case '?':
					this.index++;
					return { type: NodeType.questionMark };
				case '*':
					if (this.value[this.index + 1] === '*') {
						this.index += 2;
						return { type: NodeType.globStar };
					} else {
						this.index++;
						return {type: NodeType.star };
					}
				case '{':
					if (start < this.index) {
						return this.makeTextNode(start);
					} else {
						const bracketParser = new PatternParser(this.value.substring(this.index + 1), 'brace');
						const alternatives: BraceAlternative[] = [];
						let node: Node | undefined;
						while ((node = bracketParser.next()) !== undefined) {
							if (node.type === NodeType.globStar || node.type === NodeType.separator) {
								throw new Error(`Invalid glob pattern ${this.index}. Stopped at ${this.index}`);
							}
							alternatives.push(node);
						}
						this.index= this.index + bracketParser.index + 2;
						return { type: NodeType.brace, alternatives: alternatives };
					}
					break;
				case ',':
					if (this.mode === 'brace') {
						if (start < this.index) {
							let result = this.makeTextNode(start);
							this.index++;
							return result;
						}
					}
					this.index++;
					break;
				case '[':
					const buffer: string[] = [];
					this.index++;
					const firstIndex = this.index;
					while (this.index < this.value.length) {
						const ch = this.value[this.index];
						if (this.index === firstIndex) {
							switch (ch) {
								case ']':
									buffer.push(ch);
									break;
								case '!':
								case '^':
									buffer.push('^');
									break;
								default:
									buffer.push(escapeRegExpCharacters(ch));
									break;
							}
						} else if (ch === '-') {
							buffer.push(ch);
						} else if (ch === ']') {
							this.index++;
							return { type: NodeType.bracket, value: buffer.join('') };
						} else {
							buffer.push(escapeRegExpCharacters(ch));
						}
						this.index++;
					}
					throw new Error(`Invalid glob pattern ${this.index}. Stopped at ${this.index}`);
				default:
					this.index++;
			}
		}
		return start === this.index ? undefined : this.makeTextNode(start);
	}
}

export function convert2RegExp(pattern: string): RegExp | undefined {
	const separator = process.platform === 'win32' ? '\\\\' : '\\/';
	const fileChar = `[^${separator}]`;
	function convertNode(node: Node): string {
		switch (node.type) {
			case NodeType.separator:
				return separator;
				break;
			case NodeType.text:
				return node.value;
				break;
			case NodeType.questionMark:
				return fileChar;
				break;
			case NodeType.star:
				return `${fileChar}*?`;
				break;
			case NodeType.globStar:
				return `(?:${fileChar}|(?:(?:${fileChar}${separator})+${fileChar}))*?`;
			case NodeType.bracket:
				return `[${node.value}]`;
			case NodeType.brace: {
				let buffer: string[] = [];
				for (const child of node.alternatives) {
					buffer.push(convertNode(child));
				}
				return `(?:${buffer.join('|')})`;
			}
		}
	}

	try {
		const buffer: string[] = ['^'];

		let parser = new PatternParser(pattern);
		let node: Node | undefined;
		while ((node = parser.next()) !== undefined) {
			buffer.push(convertNode(node));
		}
		return buffer.length > 0 ? new RegExp(buffer.join('')) : undefined;
	} catch (err) {
		console.error(err);
		return undefined;
	}
}

export function toOSPath(path: string): string {
	if (process.platform === 'win32') {
		path = path.replace(/^\/(\w)\//, '$1:\\');
		return path.replace(/\//g, '\\');
	} else {
		return path;
	}
}