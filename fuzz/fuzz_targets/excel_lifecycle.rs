#![cfg_attr(all(fuzzing, unix), no_main)]

#[cfg(all(fuzzing, unix))]
libfuzzer_sys::fuzz_target!(|input: &[u8]| {
    tabulark_fuzz::exercise_excel(input);
});

#[cfg(not(all(fuzzing, unix)))]
fn main() {
    tabulark_fuzz::exercise_excel(&[]);
    for seed in [
        include_bytes!("../corpus/excel_lifecycle/tabulark-biff8.xls").as_slice(),
        include_bytes!("../corpus/excel_lifecycle/tabulark-ooxml.xlsx").as_slice(),
        include_bytes!("../corpus/excel_lifecycle/xlsxwriter-merge-range01.xlsx").as_slice(),
        include_bytes!("../corpus/excel_lifecycle/invalid-container.bin").as_slice(),
    ] {
        tabulark_fuzz::exercise_excel(seed);
    }
}
