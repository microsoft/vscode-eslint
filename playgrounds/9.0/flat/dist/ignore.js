function bar() {
	if (foo) {
		foo++;
	}
}

function foo(x) {
	console.log(x);
	bar();
	var x = 10;;;;
	console.log(undef);
}