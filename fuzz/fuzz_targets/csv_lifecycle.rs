#![cfg_attr(all(fuzzing, unix), no_main)]

#[cfg(all(fuzzing, unix))]
libfuzzer_sys::fuzz_target!(|input: &[u8]| {
    tabulark_fuzz::exercise(input);
});

// Keep a useful, deterministic local validation path even when cargo-fuzz is
// not installed or the host is not configured for sanitizer-backed fuzzing.
#[cfg(not(all(fuzzing, unix)))]
fn main() {
    tabulark_fuzz::exercise(&[]);
    for seed in [
        include_bytes!("../corpus/csv_lifecycle/bom-multiline-quotes.csv").as_slice(),
        include_bytes!("../corpus/csv_lifecycle/malformed-quotes.csv").as_slice(),
        include_bytes!("../corpus/csv_lifecycle/ragged-and-empty.csv").as_slice(),
        include_bytes!("../corpus/csv_lifecycle/semicolon-headerless.csv").as_slice(),
        include_bytes!("../corpus/csv_lifecycle/tsv-and-unicode.tsv").as_slice(),
    ] {
        tabulark_fuzz::exercise(seed);
    }
}
