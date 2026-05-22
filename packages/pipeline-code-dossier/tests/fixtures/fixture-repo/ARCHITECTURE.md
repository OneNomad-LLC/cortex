# Widgetron architecture

Widgetron is a single-process library. Two modules:

- `parse` — accepts a string or buffer and returns a `Widget`.
- `convert` — accepts a `Widget` and returns a `Wodget`.

The public entry point `convertWidgetString` composes the two so callers
don't have to.

```
input string ──> parse ──> Widget ──> convert ──> Wodget
```

There is no I/O. There is no persistent state. Calling code is
responsible for reading input and writing output.
