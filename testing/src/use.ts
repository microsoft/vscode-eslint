function foo(): number {
	return 10;
}

function bar(): void {
	{
		function foo() {
		}
		foo();
	}
	foo();
}