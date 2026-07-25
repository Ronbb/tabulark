#![cfg_attr(all(fuzzing, unix), no_main)]

#[cfg(all(fuzzing, unix))]
libfuzzer_sys::fuzz_target!(|input: &[u8]| {
    tabulark_fuzz::exercise_arrow(input);
});

// Stable-Cargo lifecycle smoke for hosts without libFuzzer instrumentation.
#[cfg(not(all(fuzzing, unix)))]
fn main() {
    tabulark_fuzz::exercise_arrow(&[]);
    for seed in [
        include_bytes!("../corpus/arrow_lifecycle/m4-sample.arrow").as_slice(),
        include_bytes!("../corpus/arrow_lifecycle/m4-file-zstd.arrow").as_slice(),
        include_bytes!("../corpus/arrow_lifecycle/m4-stream-lz4.arrows").as_slice(),
        include_bytes!("../corpus/arrow_lifecycle/apache-generated-nested.arrow").as_slice(),
        include_bytes!("../corpus/arrow_lifecycle/truncated-footer.arrow").as_slice(),
    ] {
        tabulark_fuzz::exercise_arrow(seed);
    }
}
