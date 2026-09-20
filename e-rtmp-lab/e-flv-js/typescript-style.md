# TypeScript Style

This project follows and mimics the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html).

## Nullability

Prefer optional syntax over explicit `| undefined` for properties and fields:

```ts
interface Options {
  foo?: T;
}

class Example {
  foo?: T = undefined;
}
```

An optional member means it may never receive a value. By codebase convention, it is not explicitly assigned `null` or `undefined` during normal operation.

Generally avoid `T | undefined` for properties and fields. It remains appropriate where optional syntax is unavailable, such as return types.

## Intentional null state

Use `T | null` when `null` is an intentional assignable state. The value may start as `null`, remain `null` forever, become `T`, and later be reset to `null`.

## Legacy code

Do not change existing legacy style solely for conformance. When modifying nearby code, adopt the current style naturally. A module may therefore contain a mix of current Google-style code and legacy code that does not conform to the current style.

All new and future code follows the Google style.

## Private member naming

Use the `private` modifier to mark non-public members. Do not use a leading underscore (as in `_name`); the modifier already enforces privacy, so the prefix is redundant. New modules should not use underscore prefixes.

The one exception is the backing field of an accessor pair, which may use a leading underscore to distinguish it from the accessor:

```ts
private _duration = 0;
get duration() { return this._duration; }
```

Legacy `.ts` files were ported from JavaScript with `private` added but their underscore prefixes kept. If you remove the underscore prefix from any private member in a file, remove it from all private members in that file, other than accessor backing fields, in the same change. Legacy `.js` files have no `private` modifier and keep underscore prefixes until they are converted to TypeScript.
