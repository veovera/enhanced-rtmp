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
