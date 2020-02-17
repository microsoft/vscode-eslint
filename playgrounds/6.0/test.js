function bar() {
	if (foo) {
		let s = 'ho\a';
	}
}

function foo(x) {
	console.log(x);
}