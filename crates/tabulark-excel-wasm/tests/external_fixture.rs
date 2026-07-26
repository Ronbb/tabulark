//! Cross-producer OOXML fixture compatibility.

use tabulark::RangeRequest;
use tabulark_excel::{ExcelOptions, ExcelRuntime};

#[test]
fn opens_the_pinned_microsoft_excel_merge_workbook() {
    let mut runtime = ExcelRuntime::default();
    let source = runtime
        .open_source(
            include_bytes!("../../../test/fixtures/excel/v1/xlsxwriter-merge-range01.xlsx")
                .to_vec(),
            ExcelOptions::default(),
        )
        .expect("open upstream Microsoft Excel workbook");

    let tables = runtime.list_tables(source).expect("list worksheets");
    assert_eq!(tables.len(), 1);
    assert_eq!(tables[0].id(), "sheet-0");
    assert_eq!(tables[0].name(), "Sheet1");

    let table = runtime
        .open_table(source, "sheet-0")
        .expect("open upstream worksheet");
    let batch = runtime
        .read_range(
            table.table_handle,
            RangeRequest::new(0, 2, 0, 4).expect("bounded source range"),
        )
        .expect("read merged workbook range");

    assert_eq!(batch.columns().len(), 4);
    assert_eq!(batch.columns()[1].value(1), Some(Some("Foo")));
    assert!(runtime.close_table(table.table_handle));
    assert!(runtime.close_source(source));
    assert_eq!(runtime.retained_bytes(), 0);
}

#[test]
fn honors_the_1904_date_epoch_in_the_pinned_ooxml_fixture() {
    let mut runtime = ExcelRuntime::default();
    let source = runtime
        .open_source(
            include_bytes!("../../../test/fixtures/excel/v1/tabulark-ooxml.xlsx").to_vec(),
            ExcelOptions::default(),
        )
        .expect("open pinned OOXML fixture");
    let table = runtime
        .open_table(source, "sheet-0")
        .expect("open dated worksheet");
    let batch = runtime
        .read_range(
            table.table_handle,
            RangeRequest::new(1, 1, 2, 1).expect("date cell range"),
        )
        .expect("read date cell");
    assert_eq!(batch.columns()[0].value(0), Some(Some("2024-01-02")));
}
