function bar() {
	if (foo) {
		let str = 'hallo';
		foo(str);
	}
	console.log("aha!");
}

function foo(str) {
	return str;
}