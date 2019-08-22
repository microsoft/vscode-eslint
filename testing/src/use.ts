interface Bar {
}

let b: Bar;

class Foo {
	public do(): void {
	}
}
let f: Foo;
f.do;

var ff: Foo;
ff.do();

namespace Baz {
	export function foo(): void {
	}
}

Baz.foo();