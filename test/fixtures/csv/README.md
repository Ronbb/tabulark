# Delimited compatibility corpus

`v1/manifest.json` is the stable, human-readable contract for the CSV/TSV
compatibility tests in `src/csv.rs`. Source files remain ordinary UTF-8 text.
The manifest can request byte-level transforms such as CRLF line endings, a
UTF-8 BOM, or removal of the final newline so those cases stay visible during
review.

Add compatible cases to the current version. Create a new version directory
when an existing expected result must change intentionally.

The `tsv-cjk-crlf-bom` case is also consumed by the Chromium CJK regression. It
keeps Chinese, Japanese, Korean, mixed Latin/CJK text, and full-width punctuation
in one shared parser, Canvas, semantic-grid, and clipboard contract.

## External compatibility subset

Three fixtures are vendored from
[`BurntSushi/rust-csv`](https://github.com/BurntSushi/rust-csv) at exact
revision `4a3997e91d668ea1d8595bdef15625a77cf2308a`. The upstream `LICENSE-MIT` is
copied byte-for-byte as `v1/RUST-CSV-LICENSE-MIT`.

`v1/rust-csv-provenance.json` records a revision-pinned URL, upstream path,
revision, stored SHA-256, and materialized upstream SHA-256 for every vendored
file, including the license. `strange.csv`, `uspop-null.csv`, and the license
are exact Git blob copies. Because repository fixtures remain reviewable UTF-8
text, the single Latin-1 byte in `uspop-latin1.csv` is stored as its matching
Unicode code point; the manifest's explicit `latin1` transform reconstructs
the exact upstream byte sequence before parsing. The offline provenance test
checks both stored and reconstructed hashes without network access.

The manifest captures the current parser boundary rather than claiming
features Tabulark does not support:

- `strange.csv` is rejected in strict CSV mode at its backslash-escaped quote;
  semicolon delimiters, comments, and backslash escapes are not configurable.
- `uspop-null.csv` succeeds in strict mode. Empty fields stay empty strings and
  the token `NULL` stays literal text.
- `uspop-latin1.csv` fails predictably in strict mode and succeeds in lenient
  mode with one replacement character and one `invalid-utf8` warning.

Large successful fixtures declare representative sampled rows, including the
last row. The Rust runner still scans and fully decodes all 100 rows, then
checks every sample and the last-cell checkpoint path across each declared
chunk size.
