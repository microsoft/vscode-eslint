function bar() {
	if (foo) {
		let str = 'hallo';
		foo(str);
	}
}

function foo(str) {
	return str;
}