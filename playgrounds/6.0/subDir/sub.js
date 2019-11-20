function bar() {
	foo();
	if (foo) {foo++;}
}

function foo(x) {
	// console.log(x);
	bar();
	console.log();
	var x = 10;
}