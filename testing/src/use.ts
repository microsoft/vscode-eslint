function foo(): number {
	return 10;
}

function bar(): void {
	{
		let foo = () => {
		};
		foo();
	}
	foo();
}