function bar(x) {
	foo();
	if (foo) {foo++;}
}

function foo(x) {
	// console.log(x);
	bar();
	console.log();
	var x = 10;
}

let utils;
let searchParams;
let typeID;
if (!utils.isNullOrEmpty(typeID) || typeID === "") {
	searchParams.typeID= typeID;
}

if (typeID !== "") {
	searchParams.typeID= typeID;
}