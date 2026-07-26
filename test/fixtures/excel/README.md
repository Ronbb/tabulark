# Excel fixture corpus

These deterministic, project-produced files exercise both supported Excel
containers without relying on filename detection:

- `v1/tabulark-biff8.xls`: an Excel 97–2003 BIFF8 workbook in a CFB container.
- `v1/tabulark-ooxml.xlsx`: an OOXML workbook with three visibility states,
  frozen panes, merged cells, row/column dimensions, static styles, cached
  formula output, Unicode, and the 1904 date system.

Regenerate both with:

```sh
cargo run --package tabulark-excel-wasm --example generate_fixtures --locked
```

The generator is deliberately small and audited. Format rejection, staging
budget, lifecycle, formula-cache, and malicious-container behavior are covered
by the Excel crate's native tests.

`v1/xlsxwriter-merge-range01.xlsx` is copied byte-for-byte from XlsxWriter's
comparison corpus. Its OOXML metadata identifies Microsoft Excel 12.0 as the
producer, so it exercises a second producer independently of the project ZIP
generator. It contains a styled `B2:D2` merge anchored by `Foo`; the exact
revision, blob, digest, and BSD-2-Clause license are locked in
`provenance.json`.
