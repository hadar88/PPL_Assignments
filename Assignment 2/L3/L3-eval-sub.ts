// L3-eval.ts
import { ap, is, map, zipWith } from "ramda";
import { Binding, ClassExp, isAtomicExp, isCExp, isClassExp, isLetExp, makeBinding, makeClassExp, unparseL3 } from "./L3-ast";
import { BoolExp, CExp, Exp, IfExp, LitExp, NumExp, PrimOp, ProcExp, Program, StrExp, VarDecl } from "./L3-ast";
import { isAppExp, isBoolExp, isDefineExp, isIfExp, isLitExp, isNumExp, isPrimOp, isProcExp, isStrExp, isVarRef } from "./L3-ast";
import { makeBoolExp, makeLitExp, makeNumExp, makeProcExp, makeStrExp } from "./L3-ast";
import { parseL3Exp } from "./L3-ast";
import { applyEnv, makeEmptyEnv, makeEnv, Env } from "./L3-env-sub";
import { isClosure, makeClosure, Closure, Value, Class, makeClass, isClass, isObject, makeObject, Object, isSymbolSExp } from "./L3-value";
import { first, rest, isEmpty, List, isNonEmptyList, cons, allT, NonEmptyList } from "../shared/list";
import { isBoolean, isNumber, isString } from "../shared/type-predicates";
import { Result, makeOk, makeFailure, bind, mapResult, mapv, isFailure, isOk } from "../shared/result";
import { renameExps, substitute } from "./substitute";
import { applyPrimitive } from "./evalPrimitive";
import { parse as p } from "../shared/parser";
import { Sexp } from "s-expression";
import { format } from "../shared/format";

// ========================================================
// Eval functions

const L3applicativeEval = (exp: CExp, env: Env): Result<Value> =>
	isNumExp(exp) ? makeOk(exp.val) : 
			isBoolExp(exp) ? makeOk(exp.val) :
			isStrExp(exp) ? makeOk(exp.val) :
			isPrimOp(exp) ? makeOk(exp) :
			isVarRef(exp) ? applyEnv(env, exp.var) :
			isLitExp(exp) ? makeOk(exp.val) :
			isIfExp(exp) ? evalIf(exp, env) :
			isProcExp(exp) ? evalProc(exp, env) :
			isAppExp(exp) ? bind(L3applicativeEval(exp.rator, env), (rator: Value) =>
				bind(
					mapResult((param) => L3applicativeEval(param, env), exp.rands),
						(rands: Value[]) => L3applyProcedure(rator, rands, env)
					)
				) : 
			isLetExp(exp) ? makeFailure('"let" not supported (yet)') : 
			isClassExp(exp) ? evalClass(exp, env) : 
			makeFailure("Never");

export const isTrueValue = (x: Value): boolean => !(x === false);

const evalIf = (exp: IfExp, env: Env): Result<Value> =>
	bind(L3applicativeEval(exp.test, env), (test: Value) =>
		isTrueValue(test)
			? L3applicativeEval(exp.then, env)
			: L3applicativeEval(exp.alt, env)
	);

const evalProc = (exp: ProcExp, env: Env): Result<Closure> =>
	makeOk(makeClosure(exp.args, exp.body));

const evalClass = (exp: ClassExp, env: Env): Result<Class> =>
	makeOk(makeClass(exp));

const evalObject = (exp: Class, env: Env): Result<Object> =>
	makeOk(makeObject(exp));

const L3applyProcedure = ( proc: Value, args: Value[], env: Env): Result<Value> =>
	isPrimOp(proc) ? applyPrimitive(proc, args) : 
	isClosure(proc) ? applyClosure(proc, args, env) : 
	isClass(proc) ? applyClass(proc, args, env) :
	isObject(proc) ? isNonEmptyList<Value>(args)
			? applyClassMethod(proc, args, env) : 
			makeFailure("Bad use of class instance") : 
			makeFailure(`Bad procedure ${format(proc)}`);

const applyClassMethod = (obj: Object, args: NonEmptyList<Value>, env: Env): Result<Value> => {
	const methodName = first(args);

	if (!isSymbolSExp(methodName))
		return makeFailure("Bad method name");

	// the "?" ensures that if find returned undefined, the variavle will be undefined
	const method = obj.val.val.methods.find(
		(b: Binding) => b.var.var === methodName.val
	)?.val;

	if (method === undefined || !isProcExp(method))
		return makeFailure(`Unrecognized method: ${methodName.val}`);

	if (args.length !== method.args.length + 1)
		return makeFailure("Method called with wrong number of arguments");

	const evaluation = evalProc(method, env);

	if (isFailure(evaluation) || !isClosure(evaluation.value))
		return makeFailure("Failed to evaluate method");

	return applyClosure(evaluation.value, rest(args), env);
};

// Applications are computed by substituting computed
// values into the body of the closure.
// To make the types fit - computed values of params must be
// turned back in Literal Expressions that eval to the computed value.
const valueToLitExp = (
	v: Value
): NumExp | BoolExp | StrExp | LitExp | PrimOp | ProcExp =>
	isNumber(v)
		? makeNumExp(v)
		: isBoolean(v)
			? makeBoolExp(v)
			: isString(v)
				? makeStrExp(v)
				: isPrimOp(v)
					? v
					: isClosure(v)
						? makeProcExp(v.params, v.body)
						: makeLitExp(v);

const applyClosure = (
	proc: Closure,
	args: Value[],
	env: Env
): Result<Value> => {
	const vars = map((v: VarDecl) => v.var, proc.params);
	const body = renameExps(proc.body);
	const litArgs: CExp[] = map(valueToLitExp, args);
	return evalSequence(substitute(body, vars, litArgs), env);
	//return evalSequence(substitute(proc.body, vars, litArgs), env);
};

const applyClass = (proc: Class, args: Value[], env: Env): Result<Value> => {
	const f: (b: Binding, p: ProcExp) => Binding = (b: Binding, p: ProcExp) =>
		makeBinding(b.var.var, p);

	const cls = proc.val;
	const vars = map((v: VarDecl) => v.var, cls.fields);
	const methods = map((b: Binding) => b.val, cls.methods);
	const body = renameExps(methods);
	const litArgs: CExp[] = map(valueToLitExp, args);
	const sub: CExp[] = substitute(body, vars, litArgs);

	if (!allT(isProcExp, sub)) return makeFailure("Bad class instance");

	const bindings = zipWith(f, cls.methods, sub);

	const newclass = makeClassExp(cls.fields, bindings);

	return evalObject(makeClass(newclass), env);
};

// Evaluate a sequence of expressions (in a program)
export const evalSequence = (seq: List<Exp>, env: Env): Result<Value> =>
	isNonEmptyList<Exp>(seq)
		? isDefineExp(first(seq))
			? evalDefineExps(first(seq), rest(seq), env)
			: evalCExps(first(seq), rest(seq), env)
		: makeFailure("Empty sequence");

const evalCExps = (first: Exp, rest: Exp[], env: Env): Result<Value> =>
	isCExp(first) && isEmpty(rest)
		? L3applicativeEval(first, env)
		: isCExp(first)
			? bind(L3applicativeEval(first, env), (_) => evalSequence(rest, env))
			: makeFailure("Never");

// Eval a sequence of expressions when the first exp is a Define.
// Compute the rhs of the define, extend the env with the new binding
// then compute the rest of the exps in the new env.
const evalDefineExps = (def: Exp, exps: Exp[], env: Env): Result<Value> =>
	isDefineExp(def)
		? bind(L3applicativeEval(def.val, env), (rhs: Value) =>
			evalSequence(exps, makeEnv(def.var.var, rhs, env))
		)
		: makeFailure(`Unexpected in evalDefine: ${format(def)}`);

// Main program
export const evalL3program = (program: Program): Result<Value> =>
	evalSequence(program.exps, makeEmptyEnv());

export const evalParse = (s: string): Result<Value> =>
	bind(p(s), (sexp: Sexp) =>
		bind(parseL3Exp(sexp), (exp: Exp) => evalSequence([exp], makeEmptyEnv()))
	);
