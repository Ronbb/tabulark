#![cfg_attr(all(fuzzing, unix), no_main)]

#[cfg(all(fuzzing, unix))]
libfuzzer_sys::fuzz_target!(|input: &[u8]| {
    tabulark_fuzz::exercise_parquet(input);
});

#[cfg(not(all(fuzzing, unix)))]
fn main() {
    tabulark_fuzz::exercise_parquet(&[]);
    for seed in [
        include_bytes!("../corpus/parquet_lifecycle/tabulark-rust.parquet").as_slice(),
        include_bytes!("../corpus/parquet_lifecycle/apache-alltypes-plain.parquet").as_slice(),
        include_bytes!("../corpus/parquet_lifecycle/truncated-footer.parquet").as_slice(),
    ] {
        tabulark_fuzz::exercise_parquet(seed);
    }
}
