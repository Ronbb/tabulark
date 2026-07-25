# M4 breaking migration

M4 replaces the provisional M3 CSV-only facade with an explicit built-in
adapter contract. Tabulark is still pre-alpha, so this is an intentional
breaking change rather than a deprecation cycle.

## Register the adapters an engine may use

`createEngine()` now requires a non-empty, immutable allow-list of official
adapter descriptors. The same descriptor must be passed to `open()`.

```js
import { createEngine, delimitedAdapter } from "tabulark";
import { arrowIpcAdapter } from "tabulark/arrow";

const engine = await createEngine({
  adapters: [delimitedAdapter, arrowIpcAdapter],
});
```

The only M4 IDs are `tabulark:delimited` and `tabulark:arrow-ipc`. Duplicate
registration fails. Arbitrary JavaScript adapters, module URLs, global
registries, and third-party adapter factories are deliberately not public in
M4.

## Replace `format` with `adapter` and `adapterOptions`

M3:

```js
const dataset = await engine.open(file, {
  format: "csv",
  header: "first-row",
  mode: "lenient",
});
```

M4:

```js
const dataset = await engine.open(file, {
  adapter: delimitedAdapter,
  adapterOptions: {
    dialect: "csv",
    header: "first-row",
    mode: "lenient",
  },
});
```

TSV uses `dialect: "tsv"`. Arrow IPC uses the separate entry point:

```js
const dataset = await engine.open(file, {
  adapter: arrowIpcAdapter,
  adapterOptions: {
    container: "auto", // auto | file | stream
  },
});
```

Adapter selection is always explicit. A filename or extension never selects an
adapter, and Arrow `container: "auto"` is resolved by the Rust adapter from the
IPC bytes.

## Input ownership changed

The accepted inputs remain `File`, `Blob`, and `ArrayBuffer`, but M4 retains an
`ArrayBuffer` by default. Set `transferInput: true` only when detaching the
caller's buffer is intentional:

```js
const dataset = await engine.open(buffer, {
  adapter: arrowIpcAdapter,
  transferInput: true,
});
```

`transferInput: true` with a `File` or `Blob` is invalid. The removed
`wasmModuleUrl` and `workerUrl` options have no replacement; official
descriptors own package-relative artifact URLs.

## Schema types are recursive

`ColumnSchema.logicalType` is replaced by `ColumnSchema.dataType`. The new
descriptor can express all Arrow 59.1.0 built-in data types, including nested,
dictionary, run-end encoded, decimal, temporal, interval, union, and extension
storage types. Code that only needs a label should format `dataType` instead of
switching on the old coarse string union.

## Native values and display text are separate

`TableBatch.toRows()` now returns native recursive values. Depending on the
schema, cells may include `bigint`, `Uint8Array`, decimal/temporal/interval
records, arrays, structs, maps, or union records in addition to primitive
values.

Rendering, accessible-grid text, width measurement, and copy should use
`TableBatch.toDisplayRows()`, which returns only `(string | null)[][]` using the
stable Rust display format.

```js
const nativeRows = batch.toRows();
const displayRows = batch.toDisplayRows();
```

The wire batch is layout version 1: native descriptors and display UTF-8
descriptors share a deduplicated buffer pool. Consumers should use the methods
above instead of inspecting the transport layout unless they are testing the
experimental protocol.

## Protocol compatibility

M4 speaks Worker protocol version 2, adapter API version 1, and batch layout
version 1. Protocol version 1 is rejected explicitly. A page and its installed
package artifacts must therefore be deployed together; mixing M3 and M4
workers or WASM files is unsupported.

## Lifecycle remains explicit

Views, tables, datasets, and engines still have separate lifetimes. When
switching sources, destroy the view before closing the table and dataset. Close
the engine on terminal failure or `pagehide`.

```js
view.destroy();
await table.close();
await dataset.close();
await engine.close();
```
