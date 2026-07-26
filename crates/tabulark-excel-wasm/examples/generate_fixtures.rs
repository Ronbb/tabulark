//! Generates deterministic BIFF8 XLS and OOXML XLSX smoke fixtures.

use std::fs;
use std::io::{Cursor, Write};
use std::path::Path;

use cfb::Version;
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = Path::new("test/fixtures/excel/v1");
    fs::create_dir_all(root)?;
    fs::write(root.join("tabulark-biff8.xls"), fixture_xls()?)?;
    fs::write(root.join("tabulark-ooxml.xlsx"), fixture_xlsx()?)?;
    println!("generated Excel fixtures in {}", root.display());
    Ok(())
}

fn fixture_xlsx() -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let cursor = Cursor::new(Vec::new());
    let mut zip = ZipWriter::new(cursor);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    add(
        &mut zip,
        "[Content_Types].xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="xml" ContentType="application/xml"/>
 <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
 <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
 <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
 <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
 <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#,
        options,
    )?;
    add(
        &mut zip,
        "_rels/.rels",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#,
        options,
    )?;
    add(
        &mut zip,
        "xl/workbook.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
 <workbookPr date1904="1"/>
 <sheets>
  <sheet name="Visible" sheetId="1" r:id="rId1"/>
  <sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/>
  <sheet name="VeryHidden" sheetId="3" state="veryHidden" r:id="rId3"/>
 </sheets>
</workbook>"#,
        options,
    )?;
    add(
        &mut zip,
        "xl/_rels/workbook.xml.rels",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
 <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
 <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
 <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#,
        options,
    )?;
    add(
        &mut zip,
        "xl/styles.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
 <numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>
 <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><i/><color rgb="FFFFFFFF"/><sz val="14"/><name val="Calibri"/></font></fonts>
 <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1D4ED8"/><bgColor indexed="64"/></patternFill></fill></fills>
 <borders count="2"><border/><border><left style="thin"><color rgb="FF0F172A"/></left><right style="thin"><color rgb="FF0F172A"/></right><top style="thin"><color rgb="FF0F172A"/></top><bottom style="thin"><color rgb="FF0F172A"/></bottom></border></borders>
 <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
 <cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
 <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>"#,
        options,
    )?;
    add(
        &mut zip,
        "xl/worksheets/sheet1.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
 <dimension ref="A1:D4"/>
 <sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>
 <cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="12" customWidth="1"/><col min="4" max="4" hidden="1" width="10" customWidth="1"/></cols>
 <sheetData>
  <row r="1" ht="26" customHeight="1"><c r="A1" s="1" t="inlineStr"><is><t>城市数据</t></is></c></row>
  <row r="2"><c r="A2" t="inlineStr"><is><t>上海</t></is></c><c r="B2"><v>1</v></c><c r="C2" s="2"><v>43831</v></c></row>
  <row r="3" hidden="1"><c r="A3" t="inlineStr"><is><t>Hidden row</t></is></c><c r="B3"><v>2</v></c></row>
  <row r="4"><c r="A4" t="inlineStr"><is><t>Formula</t></is></c><c r="B4"><f>SUM(B2:B3)</f><v>3</v></c></row>
 </sheetData>
 <mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>
</worksheet>"#,
        options,
    )?;
    add(
        &mut zip,
        "xl/worksheets/sheet2.xml",
        sheet("Hidden"),
        options,
    )?;
    add(
        &mut zip,
        "xl/worksheets/sheet3.xml",
        sheet("Very hidden"),
        options,
    )?;
    Ok(zip.finish()?.into_inner())
}

fn sheet(value: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>{value}</t></is></c></row></sheetData></worksheet>"#
    )
}

fn add(
    zip: &mut ZipWriter<Cursor<Vec<u8>>>,
    name: &str,
    contents: impl AsRef<str>,
    options: SimpleFileOptions,
) -> Result<(), Box<dyn std::error::Error>> {
    zip.start_file(name, options)?;
    zip.write_all(contents.as_ref().as_bytes())?;
    Ok(())
}

fn fixture_xls() -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut workbook = Vec::new();
    workbook.extend(biff_record(0x0809, &[0x00, 0x06, 0x05, 0x00]));

    let mut font = Vec::new();
    font.extend_from_slice(&240_u16.to_le_bytes());
    font.extend_from_slice(&0x0002_u16.to_le_bytes());
    font.extend_from_slice(&10_u16.to_le_bytes());
    font.extend_from_slice(&700_u16.to_le_bytes());
    font.extend_from_slice(&0_u16.to_le_bytes());
    font.extend_from_slice(&[1, 2, 0, 0]);
    font.extend_from_slice(&[5, 1]);
    for unit in "Aptos".encode_utf16() {
        font.extend_from_slice(&unit.to_le_bytes());
    }
    workbook.extend(biff_record(0x0031, &font));

    let mut palette = Vec::new();
    palette.extend_from_slice(&56_u16.to_le_bytes());
    for index in 0..56_u8 {
        let (red, green, blue) = match index {
            0 => (255, 204, 0),
            1 => (68, 85, 102),
            2 => (17, 34, 51),
            _ => (0, 0, 0),
        };
        palette.extend_from_slice(&[red, green, blue, 0]);
    }
    workbook.extend(biff_record(0x0092, &palette));

    let mut number_format = Vec::new();
    number_format.extend_from_slice(&164_u16.to_le_bytes());
    number_format.extend_from_slice(&5_u16.to_le_bytes());
    number_format.push(0);
    number_format.extend_from_slice(b"0.000");
    workbook.extend(biff_record(0x041E, &number_format));

    let mut style_xf = vec![0_u8; 20];
    style_xf[0..2].copy_from_slice(&0_u16.to_le_bytes());
    style_xf[2..4].copy_from_slice(&164_u16.to_le_bytes());
    style_xf[4..6].copy_from_slice(&0x0004_u16.to_le_bytes());
    style_xf[6] = 0x0A;
    style_xf[10..12].copy_from_slice(&1_u16.to_le_bytes());
    style_xf[12..14].copy_from_slice(&9_u16.to_le_bytes());
    style_xf[14..18].copy_from_slice(&(1_u32 << 26).to_le_bytes());
    style_xf[18..20].copy_from_slice(&(8_u16 | (9_u16 << 7)).to_le_bytes());
    workbook.extend(biff_record(0x00E0, &style_xf));

    let mut cell_xf = style_xf.clone();
    cell_xf[4..6].copy_from_slice(&0_u16.to_le_bytes());
    cell_xf[9] = 0x7C;
    workbook.extend(biff_record(0x00E0, &cell_xf));

    let sheet_name = b"Visible";
    let bound_sheet_len = 6 + 2 + sheet_name.len();
    let sheet_offset = workbook.len() + 4 + bound_sheet_len + 4;
    let mut bound_sheet = Vec::new();
    bound_sheet.extend_from_slice(&(sheet_offset as u32).to_le_bytes());
    bound_sheet.extend_from_slice(&[0, 0, sheet_name.len() as u8, 0]);
    bound_sheet.extend_from_slice(sheet_name);
    workbook.extend(biff_record(0x0085, &bound_sheet));
    workbook.extend(biff_record(0x000A, &[]));
    workbook.extend(biff_record(0x0809, &[0x00, 0x06, 0x10, 0x00]));
    let mut label = Vec::new();
    label.extend_from_slice(&0_u16.to_le_bytes());
    label.extend_from_slice(&0_u16.to_le_bytes());
    label.extend_from_slice(&1_u16.to_le_bytes());
    label.extend_from_slice(&11_u16.to_le_bytes());
    label.push(0);
    label.extend_from_slice(b"BIFF8 smoke");
    workbook.extend(biff_record(0x0204, &label));
    workbook.extend(biff_record(0x000A, &[]));

    let cursor = Cursor::new(Vec::new());
    let mut compound = cfb::CompoundFile::create_with_version(Version::V3, cursor)?;
    {
        let mut stream = compound.create_stream("/Workbook")?;
        stream.write_all(&workbook)?;
    }
    compound.flush()?;
    Ok(compound.into_inner().into_inner())
}

fn biff_record(record_type: u16, data: &[u8]) -> Vec<u8> {
    let mut record = Vec::with_capacity(4 + data.len());
    record.extend_from_slice(&record_type.to_le_bytes());
    record.extend_from_slice(&(data.len() as u16).to_le_bytes());
    record.extend_from_slice(data);
    record
}
