# TypeScript Style

This project follows and mimics the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html).

## Legacy code

This codebase contains legacy styles that may not match this guide. New code should follow this guide. When modifying existing code, update nearby legacy style opportunistically when it remains within the change's local scope. Broader module-wide cleanup is appropriate only when the work already substantially touches that module or when it is planned as a dedicated refactor.

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

## Number initialization

Initialize a number to its intended starting value. A sentinel such as `-1` is acceptable when its meaning is clear and it cannot be confused with a valid value. Avoid `NaN` as a sentinel in new code; use it only when it is a meaningful numeric result or required by an API or format. For representing absence, follow the nullability guidance above.

## Private member naming

Use the `private` modifier to mark non-public members. Do not use a leading underscore (as in `_name`); the modifier already enforces privacy, so the prefix is redundant. New modules should not use underscore prefixes.

The one exception is the backing field of an accessor pair, which may use a leading underscore to distinguish it from the accessor:

```ts
private _duration = 0;
get duration() { return this._duration; }
```

Legacy `.ts` files were ported from JavaScript with `private` added but their underscore prefixes kept. If you remove the underscore prefix from any private member in a file, remove it from all private members in that file, other than accessor backing fields, in the same change. Legacy `.js` files have no `private` modifier and keep underscore prefixes until they are converted to TypeScript.

## Naming

### Enum members

Enum names and enum members use PascalCase, except when preserving an identifier defined by an external specification or interoperable wire format. In that case, retain the specification's casing.

```ts
enum MediaType {
  Video,
  Audio,
  Data,
}

enum PacketType {
  SequenceStart,
  CodedFrames,
  SequenceEnd,
}
```

For example, AV1 OBU types retain the identifiers used by the AV1 specification:

```ts
enum Av1ObuType {
  OBU_SEQUENCE_HEADER = 1,
  OBU_TEMPORAL_DELIMITER = 2,
}
```

This intentionally differs from the Google TypeScript Style Guide, which uses `CONSTANT_CASE` for enum members.

### Constants

A `const` declaration does not by itself imply `CONSTANT_CASE`. Use `lowerCamelCase` for ordinary variables whose bindings are not reassigned:

```ts
const currentTimeout = DEFAULT_TIMEOUT;
```

Use `CONSTANT_CASE` for values that are conceptually program-level constants:

```ts
const DEFAULT_TIMEOUT = 5000;
```

The distinction is semantic: `const` controls reassignment, while the identifier's casing communicates whether the value represents a program-level constant.
