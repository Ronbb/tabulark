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
