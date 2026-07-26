//! Static spreadsheet presentation parsing for the Excel adapter.
//!
//! This module intentionally parses only the bounded 0.1 presentation subset.
//! It never executes formulas or follows external relationships.

use std::collections::{BTreeMap, HashMap};
use std::io::{Cursor, Read};

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use serde::Serialize;
use tabulark::model::RangeRequest;
use tabulark::{ErrorCode, Result, TabularkError};
use zip::ZipArchive;

use crate::{ExcelFormat, ExcelLimits, ExcelSheetVisibility, ExcelTableDescriptor};

const BIFF8_MAX_ROWS: u64 = 65_536;
const BIFF8_MAX_COLUMNS: u64 = 256;

/// One explicitly sized or hidden worksheet row or column.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PresentationAxisEntry {
    pub(crate) index: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) hidden: Option<bool>,
}

/// One CSS-compatible colour preserved from workbook formatting.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PresentationColor {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) css: Option<String>,
}

/// The font subset used by the stable spreadsheet presentation contract.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PresentationFont {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) underline: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) color: Option<PresentationColor>,
}

/// One supported side of a cell border.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PresentationBorderSide {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) color: Option<PresentationColor>,
}

/// The supported outer cell border sides.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PresentationBorders {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) top: Option<PresentationBorderSide>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) right: Option<PresentationBorderSide>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) bottom: Option<PresentationBorderSide>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) left: Option<PresentationBorderSide>,
}

/// A deduplicated static cell style.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PresentationStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) number_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) font: Option<PresentationFont>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) foreground_color: Option<PresentationColor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) background_color: Option<PresentationColor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) fill_color: Option<PresentationColor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) borders: Option<PresentationBorders>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) horizontal_alignment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) vertical_alignment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) wrap_text: Option<bool>,
}

impl PresentationStyle {
    fn is_empty(&self) -> bool {
        self.number_format.is_none()
            && self.font.is_none()
            && self.foreground_color.is_none()
            && self.background_color.is_none()
            && self.fill_color.is_none()
            && self.borders.is_none()
            && self.horizontal_alignment.is_none()
            && self.vertical_alignment.is_none()
            && self.wrap_text.is_none()
    }
}

/// One merged region, using zero-based exclusive end coordinates.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PresentationMergedCell {
    pub(crate) row_start: u64,
    pub(crate) row_end: u64,
    pub(crate) column_start: u64,
    pub(crate) column_end: u64,
}

/// Presentation returned by a table-level query.
#[derive(Clone, Debug)]
pub(crate) struct TablePresentation {
    pub(crate) visibility: ExcelSheetVisibility,
    pub(crate) frozen_rows: u64,
    pub(crate) frozen_columns: u64,
    pub(crate) rows: Vec<PresentationAxisEntry>,
    pub(crate) columns: Vec<PresentationAxisEntry>,
    pub(crate) styles: Vec<PresentationStyle>,
}

/// Presentation returned by a range-level query.
#[derive(Clone, Debug)]
pub(crate) struct TablePresentationRange {
    pub(crate) style_ids: Vec<Vec<Option<u32>>>,
    pub(crate) merged_cells: Vec<PresentationMergedCell>,
    pub(crate) rows: Vec<PresentationAxisEntry>,
    pub(crate) columns: Vec<PresentationAxisEntry>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct CellCoordinate {
    row: u64,
    column: u64,
}

#[derive(Clone, Debug, Default)]
struct WorksheetPresentation {
    extent_rows: u64,
    extent_columns: u64,
    frozen_rows: u64,
    frozen_columns: u64,
    rows: BTreeMap<u64, PresentationAxisEntry>,
    columns: BTreeMap<u64, PresentationAxisEntry>,
    styles: HashMap<CellCoordinate, u32>,
    merged_cells: Vec<PresentationMergedCell>,
}

/// Parsed static presentation state shared by all sheets in one workbook.
#[derive(Clone, Debug, Default)]
pub(crate) struct WorkbookPresentation {
    styles: Vec<PresentationStyle>,
    sheets: HashMap<String, WorksheetPresentation>,
}

impl WorkbookPresentation {
    pub(crate) fn parse(format: ExcelFormat, bytes: &[u8], limits: &ExcelLimits) -> Result<Self> {
        match format {
            ExcelFormat::Xlsx => Self::parse_xlsx(bytes, limits),
            ExcelFormat::Xls => Self::parse_biff8(bytes, limits),
        }
    }

    pub(crate) fn table(&self, descriptor: &ExcelTableDescriptor) -> TablePresentation {
        let layout = self.sheets.get(descriptor.name());
        TablePresentation {
            visibility: descriptor.visibility(),
            frozen_rows: layout.map_or(0, |layout| layout.frozen_rows),
            frozen_columns: layout.map_or(0, |layout| layout.frozen_columns),
            rows: layout.map_or_else(Vec::new, |layout| layout.rows.values().cloned().collect()),
            columns: layout.map_or_else(Vec::new, |layout| {
                layout.columns.values().cloned().collect()
            }),
            styles: self.styles.clone(),
        }
    }

    pub(crate) fn dimensions(&self, descriptor: &ExcelTableDescriptor) -> Option<(u64, u64)> {
        self.sheets
            .get(descriptor.name())
            .map(|layout| (layout.extent_rows, layout.extent_columns))
    }

    pub(crate) fn retained_bytes(&self) -> Result<usize> {
        // HashMap/BTreeMap do not expose allocator byte counts. Use actual
        // capacities where available and deliberately conservative per-bucket
        // estimates for retained map nodes. String payloads are counted by
        // capacity rather than length so the ledger follows allocated memory.
        const HASH_BUCKET_OVERHEAD: usize = 16;
        const BTREE_AXIS_ENTRY_BYTES: usize = 96;

        let mut bytes = std::mem::size_of::<Self>();
        add_presentation_bytes(
            &mut bytes,
            self.styles
                .capacity()
                .checked_mul(std::mem::size_of::<PresentationStyle>())
                .ok_or_else(presentation_reservation_overflow)?,
        )?;
        for style in &self.styles {
            add_style_heap_bytes(&mut bytes, style)?;
        }

        let sheet_bucket_bytes = std::mem::size_of::<String>()
            .checked_add(std::mem::size_of::<WorksheetPresentation>())
            .and_then(|value| value.checked_add(HASH_BUCKET_OVERHEAD))
            .ok_or_else(presentation_reservation_overflow)?;
        add_presentation_bytes(
            &mut bytes,
            self.sheets
                .capacity()
                .checked_mul(sheet_bucket_bytes)
                .ok_or_else(presentation_reservation_overflow)?,
        )?;
        for (name, sheet) in &self.sheets {
            add_presentation_bytes(&mut bytes, name.capacity())?;
            add_presentation_bytes(
                &mut bytes,
                sheet
                    .rows
                    .len()
                    .checked_mul(BTREE_AXIS_ENTRY_BYTES)
                    .ok_or_else(presentation_reservation_overflow)?,
            )?;
            add_presentation_bytes(
                &mut bytes,
                sheet
                    .columns
                    .len()
                    .checked_mul(BTREE_AXIS_ENTRY_BYTES)
                    .ok_or_else(presentation_reservation_overflow)?,
            )?;
            let style_bucket_bytes = std::mem::size_of::<CellCoordinate>()
                .checked_add(std::mem::size_of::<u32>())
                .and_then(|value| value.checked_add(HASH_BUCKET_OVERHEAD))
                .ok_or_else(presentation_reservation_overflow)?;
            add_presentation_bytes(
                &mut bytes,
                sheet
                    .styles
                    .capacity()
                    .checked_mul(style_bucket_bytes)
                    .ok_or_else(presentation_reservation_overflow)?,
            )?;
            add_presentation_bytes(
                &mut bytes,
                sheet
                    .merged_cells
                    .capacity()
                    .checked_mul(std::mem::size_of::<PresentationMergedCell>())
                    .ok_or_else(presentation_reservation_overflow)?,
            )?;
        }
        Ok(bytes)
    }

    pub(crate) fn range(
        &self,
        descriptor: &ExcelTableDescriptor,
        request: RangeRequest,
    ) -> Result<TablePresentationRange> {
        request.validate_public()?;
        let row_end = request.row_end()?;
        let column_end = request.column_end()?;
        let row_count = usize::try_from(request.row_count()).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel presentation row count exceeds the supported integer range",
            )
        })?;
        let column_count = usize::try_from(request.column_count()).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel presentation column count exceeds the supported integer range",
            )
        })?;
        let Some(layout) = self.sheets.get(descriptor.name()) else {
            return Ok(TablePresentationRange {
                style_ids: vec![vec![None; column_count]; row_count],
                merged_cells: Vec::new(),
                rows: Vec::new(),
                columns: Vec::new(),
            });
        };

        let mut style_ids = vec![vec![None; column_count]; row_count];
        for (coordinate, style) in &layout.styles {
            if coordinate.row < request.row_start()
                || coordinate.row >= row_end
                || coordinate.column < request.column_start()
                || coordinate.column >= column_end
            {
                continue;
            }
            let row = usize::try_from(coordinate.row - request.row_start()).map_err(|_| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Excel presentation row offset exceeds the supported integer range",
                )
            })?;
            let column =
                usize::try_from(coordinate.column - request.column_start()).map_err(|_| {
                    TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "Excel presentation column offset exceeds the supported integer range",
                    )
                })?;
            style_ids[row][column] = Some(*style);
        }
        let merged_cells = layout
            .merged_cells
            .iter()
            .filter(|region| {
                region.row_start < row_end
                    && region.row_end > request.row_start()
                    && region.column_start < column_end
                    && region.column_end > request.column_start()
            })
            .cloned()
            .collect();
        let rows = layout
            .rows
            .range(request.row_start()..row_end)
            .map(|(_, entry)| entry.clone())
            .collect();
        let columns = layout
            .columns
            .range(request.column_start()..column_end)
            .map(|(_, entry)| entry.clone())
            .collect();
        Ok(TablePresentationRange {
            style_ids,
            merged_cells,
            rows,
            columns,
        })
    }

    /// Marks cells whose stored value must be suppressed because a merged
    /// region's top-left cell is the sole logical value anchor.
    pub(crate) fn merged_non_anchor_mask(
        &self,
        descriptor: &ExcelTableDescriptor,
        request: RangeRequest,
    ) -> Result<Vec<bool>> {
        request.validate_public()?;
        let cell_count = usize::try_from(request.cell_count()?).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel merged-cell mask exceeds the supported integer range",
            )
        })?;
        let Some(layout) = self.sheets.get(descriptor.name()) else {
            return Ok(vec![false; cell_count]);
        };
        let row_end = request.row_end()?;
        let column_end = request.column_end()?;
        let column_count = usize::try_from(request.column_count()).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel merged-cell mask column count exceeds the supported integer range",
            )
        })?;
        let mut mask = vec![false; cell_count];
        let mut owners = vec![None; cell_count];

        for (region_index, region) in layout.merged_cells.iter().enumerate() {
            let intersection_row_start = region.row_start.max(request.row_start());
            let intersection_row_end = region.row_end.min(row_end);
            let intersection_column_start = region.column_start.max(request.column_start());
            let intersection_column_end = region.column_end.min(column_end);
            if intersection_row_start >= intersection_row_end
                || intersection_column_start >= intersection_column_end
            {
                continue;
            }
            for row in intersection_row_start..intersection_row_end {
                let row_offset = usize::try_from(row - request.row_start()).map_err(|_| {
                    TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "Excel merged-cell row offset exceeds the supported integer range",
                    )
                })?;
                for column in intersection_column_start..intersection_column_end {
                    let column_offset =
                        usize::try_from(column - request.column_start()).map_err(|_| {
                            TabularkError::new(
                                ErrorCode::ResourceLimit,
                                "Excel merged-cell column offset exceeds the supported integer range",
                            )
                        })?;
                    let index = row_offset
                        .checked_mul(column_count)
                        .and_then(|value| value.checked_add(column_offset))
                        .ok_or_else(|| {
                            TabularkError::new(
                                ErrorCode::ResourceLimit,
                                "Excel merged-cell mask index overflows",
                            )
                        })?;
                    if owners[index].replace(region_index).is_some() {
                        return Err(TabularkError::new(
                            ErrorCode::ParseFailed,
                            "Excel worksheet contains overlapping merged regions",
                        )
                        .with_detail("sheet", descriptor.name())
                        .with_detail("row", row)
                        .with_detail("column", column));
                    }
                    mask[index] = row != region.row_start || column != region.column_start;
                }
            }
        }
        Ok(mask)
    }
}

fn add_style_heap_bytes(bytes: &mut usize, style: &PresentationStyle) -> Result<()> {
    for value in [
        style.number_format.as_ref(),
        style.horizontal_alignment.as_ref(),
        style.vertical_alignment.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        add_presentation_bytes(bytes, value.capacity())?;
    }
    if let Some(font) = &style.font {
        if let Some(family) = &font.family {
            add_presentation_bytes(bytes, family.capacity())?;
        }
        if let Some(color) = &font.color {
            add_color_heap_bytes(bytes, color)?;
        }
    }
    for color in [
        style.foreground_color.as_ref(),
        style.background_color.as_ref(),
        style.fill_color.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        add_color_heap_bytes(bytes, color)?;
    }
    if let Some(borders) = &style.borders {
        for side in [
            borders.top.as_ref(),
            borders.right.as_ref(),
            borders.bottom.as_ref(),
            borders.left.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            if let Some(value) = &side.style {
                add_presentation_bytes(bytes, value.capacity())?;
            }
            if let Some(color) = &side.color {
                add_color_heap_bytes(bytes, color)?;
            }
        }
    }
    Ok(())
}

fn add_color_heap_bytes(bytes: &mut usize, color: &PresentationColor) -> Result<()> {
    if let Some(css) = &color.css {
        add_presentation_bytes(bytes, css.capacity())?;
    }
    Ok(())
}

fn add_presentation_bytes(bytes: &mut usize, additional: usize) -> Result<()> {
    *bytes = bytes
        .checked_add(additional)
        .ok_or_else(presentation_reservation_overflow)?;
    Ok(())
}

fn presentation_reservation_overflow() -> TabularkError {
    TabularkError::new(
        ErrorCode::ResourceLimit,
        "Excel presentation memory reservation overflows",
    )
}

#[derive(Clone, Debug)]
struct WorkbookSheetReference {
    name: String,
    relationship_id: String,
}

#[derive(Clone, Debug)]
struct WorkbookRelationship {
    target: String,
    external: bool,
}

#[derive(Clone, Debug, Default)]
struct StyleTable {
    styles: Vec<PresentationStyle>,
    raw_to_deduplicated: Vec<Option<u32>>,
}

/// BIFF8 stores the same presentation primitives as SpreadsheetML, but in a
/// workbook-level FONT / FORMAT / XF collection.  Keep their unresolved
/// palette indices until all Globals records have been read; Palette normally
/// appears after FONT records.
#[derive(Clone, Debug, Default)]
struct RawBiff8Font {
    family: Option<String>,
    size: Option<f64>,
    bold: Option<bool>,
    italic: Option<bool>,
    underline: Option<bool>,
    color_index: Option<u16>,
}

#[derive(Clone, Copy, Debug, Default)]
struct RawBiff8BorderSide {
    style: u8,
    color_index: u8,
}

#[derive(Clone, Debug, Default)]
struct RawBiff8Borders {
    top: RawBiff8BorderSide,
    right: RawBiff8BorderSide,
    bottom: RawBiff8BorderSide,
    left: RawBiff8BorderSide,
}

#[derive(Clone, Debug, Default)]
struct RawBiff8Fill {
    pattern: u8,
    foreground_index: u8,
    background_index: u8,
}

#[derive(Clone, Debug, Default)]
struct RawBiff8Xf {
    is_style: bool,
    parent: usize,
    font_index: usize,
    number_format_id: u16,
    horizontal_alignment: Option<String>,
    vertical_alignment: Option<String>,
    wrap_text: Option<bool>,
    borders: RawBiff8Borders,
    fill: RawBiff8Fill,
    uses_number_format: bool,
    uses_font: bool,
    uses_alignment: bool,
    uses_borders: bool,
    uses_fill: bool,
}

#[derive(Clone, Debug, Default)]
struct Biff8Palette {
    /// Palette record entries correspond to Icv values 0x08 through 0x3F.
    custom: Option<Vec<PresentationColor>>,
}

impl WorkbookPresentation {
    fn parse_xlsx(bytes: &[u8], limits: &ExcelLimits) -> Result<Self> {
        let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|error| {
            TabularkError::new(ErrorCode::ParseFailed, "invalid XLSX ZIP container")
                .with_detail("reason", error.to_string())
        })?;
        let workbook =
            read_zip_entry(&mut archive, "xl/workbook.xml", limits)?.ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ParseFailed,
                    "XLSX workbook is missing xl/workbook.xml",
                )
            })?;
        let relationships = read_zip_entry(&mut archive, "xl/_rels/workbook.xml.rels", limits)?
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ParseFailed,
                    "XLSX workbook is missing workbook relationships",
                )
            })?;
        let sheets = parse_xlsx_workbook_sheets(&workbook)?;
        let relationships = parse_xlsx_relationships(&relationships)?;
        let styles = match read_zip_entry(&mut archive, "xl/styles.xml", limits)? {
            Some(styles) => parse_xlsx_styles(&styles, limits)?,
            None => StyleTable::default(),
        };

        let mut presentation = Self::default();
        for sheet in sheets {
            let Some(relationship) = relationships.get(&sheet.relationship_id) else {
                continue;
            };
            if relationship.external {
                continue;
            }
            let Some(path) = resolve_ooxml_target("xl/", &relationship.target) else {
                return Err(TabularkError::new(
                    ErrorCode::ParseFailed,
                    "XLSX worksheet relationship has an unsafe target",
                )
                .with_detail("target", relationship.target.clone()));
            };
            let Some(xml) = read_zip_entry(&mut archive, &path, limits)? else {
                return Err(TabularkError::new(
                    ErrorCode::ParseFailed,
                    "XLSX worksheet relationship target is missing",
                )
                .with_detail("target", path));
            };
            let layout = parse_xlsx_worksheet(&xml, &styles.raw_to_deduplicated, limits)?;
            presentation.sheets.insert(sheet.name, layout);
        }
        presentation.styles = styles.styles;
        Ok(presentation)
    }

    fn parse_biff8(bytes: &[u8], limits: &ExcelLimits) -> Result<Self> {
        let mut compound = cfb::CompoundFile::open(Cursor::new(bytes)).map_err(|error| {
            TabularkError::new(ErrorCode::ParseFailed, "invalid Excel compound file")
                .with_detail("reason", error.to_string())
        })?;
        let mut workbook_path = None;
        for entry in compound.walk() {
            if entry.is_stream()
                && (entry.name().eq_ignore_ascii_case("Workbook")
                    || entry.name().eq_ignore_ascii_case("Book"))
            {
                workbook_path = Some(entry.path().to_owned());
                break;
            }
        }
        let workbook_path = workbook_path.ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ParseFailed,
                "Excel compound file does not contain a Workbook stream",
            )
        })?;
        let mut stream = compound.open_stream(workbook_path).map_err(|error| {
            TabularkError::new(
                ErrorCode::ParseFailed,
                "failed to open the Excel Workbook stream",
            )
            .with_detail("reason", error.to_string())
        })?;
        let mut workbook = Vec::new();
        stream.read_to_end(&mut workbook).map_err(|error| {
            TabularkError::new(
                ErrorCode::ParseFailed,
                "failed to read the Excel Workbook stream",
            )
            .with_detail("reason", error.to_string())
        })?;
        let styles = parse_biff8_styles(&workbook, limits)?;
        let sheets = parse_biff8_bound_sheets(&workbook)?;
        let mut presentation = Self::default();
        for sheet in sheets {
            let layout = parse_biff8_worksheet(
                &workbook,
                sheet.offset,
                &styles.raw_to_deduplicated,
                limits,
            )?;
            presentation.sheets.insert(sheet.name, layout);
        }
        presentation.styles = styles.styles;
        Ok(presentation)
    }
}

fn read_zip_entry(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    name: &str,
    limits: &ExcelLimits,
) -> Result<Option<Vec<u8>>> {
    let Some(index) = archive.index_for_name(name) else {
        return Ok(None);
    };
    let mut file = archive.by_index(index).map_err(|error| {
        TabularkError::new(ErrorCode::ParseFailed, "failed to read XLSX ZIP entry")
            .with_detail("entry", name)
            .with_detail("reason", error.to_string())
    })?;
    if file.size() > limits.max_zip_entry_bytes {
        return Err(resource_limit(
            "zip-entry-bytes",
            file.size(),
            limits.max_zip_entry_bytes,
            "XLSX entry exceeds the configured uncompressed-byte limit",
        ));
    }
    let capacity = usize::try_from(file.size()).map_err(|_| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "XLSX entry length exceeds the supported integer range",
        )
    })?;
    let mut contents = Vec::with_capacity(capacity);
    let limit = file.size().saturating_add(1);
    (&mut file)
        .take(limit)
        .read_to_end(&mut contents)
        .map_err(|error| {
            TabularkError::new(
                ErrorCode::ParseFailed,
                "failed to decompress XLSX ZIP entry",
            )
            .with_detail("entry", name)
            .with_detail("reason", error.to_string())
        })?;
    if contents.len() > capacity {
        return Err(resource_limit(
            "zip-entry-bytes",
            contents.len() as u64,
            file.size(),
            "XLSX entry produced more bytes than its declared uncompressed size",
        ));
    }
    Ok(Some(contents))
}

fn parse_xlsx_workbook_sheets(xml: &[u8]) -> Result<Vec<WorkbookSheetReference>> {
    let mut reader = Reader::from_reader(Cursor::new(xml));
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut sheets = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) | Ok(Event::Empty(event))
                if local_name(event.name().as_ref()) == b"sheet" =>
            {
                let attributes = xml_attributes(&event, reader.decoder())?;
                let Some(name) = attributes.get("name") else {
                    buffer.clear();
                    continue;
                };
                let Some(relationship_id) = attributes.get("id") else {
                    buffer.clear();
                    continue;
                };
                sheets.push(WorkbookSheetReference {
                    name: name.clone(),
                    relationship_id: relationship_id.clone(),
                });
            }
            Ok(Event::Eof) => break,
            Ok(Event::DocType(_)) => {
                return Err(TabularkError::new(
                    ErrorCode::UnsupportedFeature,
                    "XLSX XML document type declarations are not supported",
                ));
            }
            Ok(_) => {}
            Err(error) => {
                return Err(xml_error("failed to parse xl/workbook.xml", error));
            }
        }
        buffer.clear();
    }
    Ok(sheets)
}

fn parse_xlsx_relationships(xml: &[u8]) -> Result<HashMap<String, WorkbookRelationship>> {
    let mut reader = Reader::from_reader(Cursor::new(xml));
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut relationships = HashMap::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) | Ok(Event::Empty(event))
                if local_name(event.name().as_ref()) == b"Relationship" =>
            {
                let attributes = xml_attributes(&event, reader.decoder())?;
                let (Some(id), Some(target)) = (attributes.get("Id"), attributes.get("Target"))
                else {
                    buffer.clear();
                    continue;
                };
                relationships.insert(
                    id.clone(),
                    WorkbookRelationship {
                        target: target.clone(),
                        external: attributes
                            .get("TargetMode")
                            .is_some_and(|mode| mode.eq_ignore_ascii_case("External")),
                    },
                );
            }
            Ok(Event::Eof) => break,
            Ok(Event::DocType(_)) => {
                return Err(TabularkError::new(
                    ErrorCode::UnsupportedFeature,
                    "XLSX XML document type declarations are not supported",
                ));
            }
            Ok(_) => {}
            Err(error) => {
                return Err(xml_error("failed to parse workbook relationships", error));
            }
        }
        buffer.clear();
    }
    Ok(relationships)
}

fn parse_xlsx_worksheet(
    xml: &[u8],
    styles: &[Option<u32>],
    limits: &ExcelLimits,
) -> Result<WorksheetPresentation> {
    let mut reader = Reader::from_reader(Cursor::new(xml));
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut layout = WorksheetPresentation::default();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) | Ok(Event::Empty(event)) => {
                let attributes = xml_attributes(&event, reader.decoder())?;
                match local_name(event.name().as_ref()) {
                    b"dimension" => apply_xlsx_dimension(&mut layout, &attributes, limits)?,
                    b"pane" => apply_xlsx_pane(&mut layout, &attributes),
                    b"row" => apply_xlsx_row(&mut layout, &attributes, limits)?,
                    b"col" => apply_xlsx_column(&mut layout, &attributes, limits)?,
                    b"mergeCell" => apply_xlsx_merge(&mut layout, &attributes, limits)?,
                    b"c" => apply_xlsx_cell_style(&mut layout, &attributes, styles, limits)?,
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Ok(Event::DocType(_)) => {
                return Err(TabularkError::new(
                    ErrorCode::UnsupportedFeature,
                    "XLSX XML document type declarations are not supported",
                ));
            }
            Ok(_) => {}
            Err(error) => return Err(xml_error("failed to parse XLSX worksheet XML", error)),
        }
        buffer.clear();
    }
    Ok(layout)
}

fn apply_xlsx_dimension(
    layout: &mut WorksheetPresentation,
    attributes: &HashMap<String, String>,
    limits: &ExcelLimits,
) -> Result<()> {
    let Some(reference) = attributes.get("ref") else {
        return Ok(());
    };
    let Some(region) = parse_a1_region(reference) else {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "XLSX worksheet dimension has an invalid A1 reference",
        )
        .with_detail("reference", reference.as_str()));
    };
    update_layout_extent(
        layout,
        region.row_end,
        region.column_end,
        limits,
        "worksheet-dimensions",
        "XLSX worksheet dimension exceeds the configured cell limit",
    )
}

fn apply_xlsx_pane(layout: &mut WorksheetPresentation, attributes: &HashMap<String, String>) {
    let frozen = attributes.get("state").is_none_or(|state| {
        state.eq_ignore_ascii_case("frozen") || state.eq_ignore_ascii_case("frozenSplit")
    });
    if !frozen {
        return;
    }
    if let Some(rows) = attributes
        .get("ySplit")
        .and_then(|value| parse_axis_split(value))
    {
        layout.frozen_rows = rows;
    }
    if let Some(columns) = attributes
        .get("xSplit")
        .and_then(|value| parse_axis_split(value))
    {
        layout.frozen_columns = columns;
    }
}

fn apply_xlsx_row(
    layout: &mut WorksheetPresentation,
    attributes: &HashMap<String, String>,
    limits: &ExcelLimits,
) -> Result<()> {
    let Some(row) = attributes
        .get("r")
        .and_then(|value| value.parse::<u64>().ok())
        .and_then(|value| value.checked_sub(1))
    else {
        return Ok(());
    };
    if row >= limits.max_worksheet_rows {
        return Err(resource_limit(
            "worksheet-rows",
            row.saturating_add(1),
            limits.max_worksheet_rows,
            "XLSX row layout exceeds the configured worksheet row limit",
        ));
    }
    let size = attributes
        .get("ht")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(points_to_pixels);
    let hidden = attributes
        .get("hidden")
        .and_then(|value| parse_xml_bool(value));
    if size.is_some() || hidden.is_some() {
        insert_axis_entry(&mut layout.rows, row, size, hidden, limits)?;
    }
    Ok(())
}

fn apply_xlsx_column(
    layout: &mut WorksheetPresentation,
    attributes: &HashMap<String, String>,
    limits: &ExcelLimits,
) -> Result<()> {
    let Some(first) = attributes
        .get("min")
        .and_then(|value| value.parse::<u64>().ok())
        .and_then(|value| value.checked_sub(1))
    else {
        return Ok(());
    };
    let Some(last) = attributes
        .get("max")
        .and_then(|value| value.parse::<u64>().ok())
        .and_then(|value| value.checked_sub(1))
    else {
        return Ok(());
    };
    if last < first {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "XLSX column layout has an inverted min/max range",
        ));
    }
    if last >= limits.max_worksheet_columns {
        return Err(resource_limit(
            "worksheet-columns",
            last.saturating_add(1),
            limits.max_worksheet_columns,
            "XLSX column layout exceeds the configured worksheet column limit",
        ));
    }
    let size = attributes
        .get("width")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(column_width_to_pixels);
    let hidden = attributes
        .get("hidden")
        .and_then(|value| parse_xml_bool(value));
    if size.is_none() && hidden.is_none() {
        return Ok(());
    }
    for column in first..=last {
        insert_axis_entry(&mut layout.columns, column, size, hidden, limits)?;
    }
    Ok(())
}

fn apply_xlsx_merge(
    layout: &mut WorksheetPresentation,
    attributes: &HashMap<String, String>,
    limits: &ExcelLimits,
) -> Result<()> {
    let Some(reference) = attributes.get("ref") else {
        return Ok(());
    };
    let Some(region) = parse_a1_region(reference) else {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "XLSX mergeCell has an invalid A1 reference",
        )
        .with_detail("reference", reference.as_str()));
    };
    if region.row_end > limits.max_worksheet_rows
        || region.column_end > limits.max_worksheet_columns
    {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "XLSX merged cell exceeds the configured worksheet dimensions",
        )
        .with_detail("resource", "merged-cells")
        .with_detail("availableRows", limits.max_worksheet_rows)
        .with_detail("availableColumns", limits.max_worksheet_columns));
    }
    if layout.merged_cells.len() >= limits.max_merged_cells {
        return Err(resource_limit_usize(
            "merged-cells",
            layout.merged_cells.len().saturating_add(1),
            limits.max_merged_cells,
            "XLSX workbook exceeds the configured merged-cell limit",
        ));
    }
    update_layout_extent(
        layout,
        region.row_end,
        region.column_end,
        limits,
        "merged-cells",
        "XLSX merged cell expands the worksheet beyond the configured cell limit",
    )?;
    layout.merged_cells.push(region);
    Ok(())
}

fn apply_xlsx_cell_style(
    layout: &mut WorksheetPresentation,
    attributes: &HashMap<String, String>,
    styles: &[Option<u32>],
    limits: &ExcelLimits,
) -> Result<()> {
    let Some(reference) = attributes.get("r").and_then(|value| parse_a1_cell(value)) else {
        return Ok(());
    };
    if reference.row >= limits.max_worksheet_rows
        || reference.column >= limits.max_worksheet_columns
    {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "XLSX styled cell exceeds the configured worksheet dimensions",
        )
        .with_detail("resource", "styled-cells"));
    }
    update_layout_extent(
        layout,
        reference.row.saturating_add(1),
        reference.column.saturating_add(1),
        limits,
        "worksheet-cells",
        "XLSX cell expands the worksheet beyond the configured cell limit",
    )?;
    let raw_style = attributes
        .get("s")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let Some(Some(style)) = styles.get(raw_style) else {
        return Ok(());
    };
    if !layout.styles.contains_key(&reference) && layout.styles.len() >= limits.max_styled_cells {
        return Err(resource_limit_usize(
            "styled-cells",
            layout.styles.len().saturating_add(1),
            limits.max_styled_cells,
            "XLSX worksheet exceeds the configured styled-cell limit",
        ));
    }
    layout.styles.insert(reference, *style);
    Ok(())
}

fn insert_axis_entry(
    entries: &mut BTreeMap<u64, PresentationAxisEntry>,
    index: u64,
    size: Option<f64>,
    hidden: Option<bool>,
    limits: &ExcelLimits,
) -> Result<()> {
    if !entries.contains_key(&index) && entries.len() >= limits.max_layout_entries {
        return Err(resource_limit_usize(
            "layout-entries",
            entries.len().saturating_add(1),
            limits.max_layout_entries,
            "Excel worksheet exceeds the configured sparse layout entry limit",
        ));
    }
    let entry = entries
        .entry(index)
        .or_insert_with(|| PresentationAxisEntry {
            index,
            size: None,
            hidden: None,
        });
    if size.is_some() {
        entry.size = size;
    }
    if hidden.is_some() {
        entry.hidden = hidden;
    }
    Ok(())
}

fn update_layout_extent(
    layout: &mut WorksheetPresentation,
    row_end: u64,
    column_end: u64,
    limits: &ExcelLimits,
    resource: &str,
    message: &str,
) -> Result<()> {
    if row_end > limits.max_worksheet_rows || column_end > limits.max_worksheet_columns {
        return Err(TabularkError::new(ErrorCode::ResourceLimit, message)
            .with_detail("resource", resource)
            .with_detail("requiredRows", row_end)
            .with_detail("availableRows", limits.max_worksheet_rows)
            .with_detail("requiredColumns", column_end)
            .with_detail("availableColumns", limits.max_worksheet_columns));
    }
    let next_rows = layout.extent_rows.max(row_end);
    let next_columns = layout.extent_columns.max(column_end);
    let cells = next_rows.checked_mul(next_columns).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "Excel worksheet cell extent overflows",
        )
        .with_detail("resource", resource)
    })?;
    if cells > limits.max_worksheet_cells {
        return Err(resource_limit(
            resource,
            cells,
            limits.max_worksheet_cells,
            message,
        ));
    }
    layout.extent_rows = next_rows;
    layout.extent_columns = next_columns;
    Ok(())
}

fn parse_xlsx_styles(xml: &[u8], limits: &ExcelLimits) -> Result<StyleTable> {
    let mut parser = XlsxStyleParser::default();
    let mut reader = Reader::from_reader(Cursor::new(xml));
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => {
                let attributes = xml_attributes(&event, reader.decoder())?;
                parser.start(
                    local_name(event.name().as_ref()),
                    &attributes,
                    false,
                    limits,
                )?;
            }
            Ok(Event::Empty(event)) => {
                let attributes = xml_attributes(&event, reader.decoder())?;
                parser.start(local_name(event.name().as_ref()), &attributes, true, limits)?;
            }
            Ok(Event::End(event)) => parser.end(local_name(event.name().as_ref()), limits)?,
            Ok(Event::Eof) => break,
            Ok(Event::DocType(_)) => {
                return Err(TabularkError::new(
                    ErrorCode::UnsupportedFeature,
                    "XLSX XML document type declarations are not supported",
                ));
            }
            Ok(_) => {}
            Err(error) => return Err(xml_error("failed to parse xl/styles.xml", error)),
        }
        buffer.clear();
    }
    parser.finish(limits)
}

#[derive(Clone, Debug, Default)]
struct XlsxStyleParser {
    in_num_formats: bool,
    in_fonts: bool,
    in_fills: bool,
    in_borders: bool,
    in_cell_xfs: bool,
    number_formats: HashMap<u32, String>,
    fonts: Vec<PresentationFont>,
    fills: Vec<RawFill>,
    borders: Vec<PresentationBorders>,
    raw_xfs: Vec<RawXf>,
    current_font: Option<PresentationFont>,
    current_fill: Option<RawFill>,
    current_border: Option<PresentationBorders>,
    current_border_side: Option<BorderSide>,
    current_xf: Option<RawXf>,
}

#[derive(Clone, Copy, Debug)]
enum BorderSide {
    Top,
    Right,
    Bottom,
    Left,
}

#[derive(Clone, Debug, Default)]
struct RawFill {
    foreground: Option<PresentationColor>,
    background: Option<PresentationColor>,
}

#[derive(Clone, Debug, Default)]
struct RawXf {
    number_format_id: u32,
    font_id: usize,
    fill_id: usize,
    border_id: usize,
    horizontal_alignment: Option<String>,
    vertical_alignment: Option<String>,
    wrap_text: Option<bool>,
}

impl XlsxStyleParser {
    fn start(
        &mut self,
        name: &[u8],
        attributes: &HashMap<String, String>,
        empty: bool,
        limits: &ExcelLimits,
    ) -> Result<()> {
        match name {
            b"numFmts" => self.in_num_formats = true,
            b"fonts" => self.in_fonts = true,
            b"fills" => self.in_fills = true,
            b"borders" => self.in_borders = true,
            b"cellXfs" => self.in_cell_xfs = true,
            b"numFmt" if self.in_num_formats => {
                if self.number_formats.len() >= limits.max_styles {
                    return Err(resource_limit_usize(
                        "styles",
                        self.number_formats.len().saturating_add(1),
                        limits.max_styles,
                        "XLSX workbook exceeds the configured number-format limit",
                    ));
                }
                if let (Some(id), Some(format)) = (
                    attributes
                        .get("numFmtId")
                        .and_then(|value| value.parse::<u32>().ok()),
                    attributes.get("formatCode"),
                ) {
                    self.number_formats.insert(id, format.clone());
                }
            }
            b"font" if self.in_fonts => {
                self.current_font = Some(PresentationFont::default());
                if empty {
                    self.finish_font(limits)?;
                }
            }
            b"name" if self.current_font.is_some() => {
                if let Some(value) = attributes.get("val") {
                    self.current_font.as_mut().expect("checked is_some").family =
                        Some(value.clone());
                }
            }
            b"sz" if self.current_font.is_some() => {
                if let Some(value) = attributes
                    .get("val")
                    .and_then(|value| value.parse::<f64>().ok())
                    .filter(|value| value.is_finite() && *value > 0.0)
                {
                    self.current_font.as_mut().expect("checked is_some").size = Some(value);
                }
            }
            b"b" if self.current_font.is_some() => {
                self.current_font.as_mut().expect("checked is_some").bold = Some(true);
            }
            b"i" if self.current_font.is_some() => {
                self.current_font.as_mut().expect("checked is_some").italic = Some(true);
            }
            b"u" if self.current_font.is_some() => {
                self.current_font
                    .as_mut()
                    .expect("checked is_some")
                    .underline = Some(true);
            }
            b"color" if self.current_font.is_some() => {
                self.current_font.as_mut().expect("checked is_some").color =
                    color_from_attributes(attributes);
            }
            b"fill" if self.in_fills => {
                self.current_fill = Some(RawFill::default());
                if empty {
                    self.finish_fill(limits)?;
                }
            }
            b"fgColor" if self.current_fill.is_some() => {
                self.current_fill
                    .as_mut()
                    .expect("checked is_some")
                    .foreground = color_from_attributes(attributes);
            }
            b"bgColor" if self.current_fill.is_some() => {
                self.current_fill
                    .as_mut()
                    .expect("checked is_some")
                    .background = color_from_attributes(attributes);
            }
            b"border" if self.in_borders => {
                self.current_border = Some(PresentationBorders::default());
                if empty {
                    self.finish_border(limits)?;
                }
            }
            b"top" | b"right" | b"bottom" | b"left" if self.current_border.is_some() => {
                let side = match name {
                    b"top" => BorderSide::Top,
                    b"right" => BorderSide::Right,
                    b"bottom" => BorderSide::Bottom,
                    b"left" => BorderSide::Left,
                    _ => unreachable!(),
                };
                self.current_border_side = Some(side);
                let value = PresentationBorderSide {
                    style: attributes
                        .get("style")
                        .and_then(|value| normalize_border_style(value)),
                    color: None,
                };
                set_border_side(
                    self.current_border.as_mut().expect("checked is_some"),
                    side,
                    value,
                );
                if empty {
                    self.current_border_side = None;
                }
            }
            b"color" if self.current_border.is_some() && self.current_border_side.is_some() => {
                let side = self.current_border_side.expect("checked is_some");
                if let Some(border_side) =
                    border_side_mut(self.current_border.as_mut().expect("checked is_some"), side)
                {
                    border_side.color = color_from_attributes(attributes);
                }
            }
            b"xf" if self.in_cell_xfs => {
                self.current_xf = Some(RawXf {
                    number_format_id: parse_u32_attribute(attributes, "numFmtId").unwrap_or(0),
                    font_id: parse_usize_attribute(attributes, "fontId").unwrap_or(0),
                    fill_id: parse_usize_attribute(attributes, "fillId").unwrap_or(0),
                    border_id: parse_usize_attribute(attributes, "borderId").unwrap_or(0),
                    ..RawXf::default()
                });
                if empty {
                    self.finish_xf(limits)?;
                }
            }
            b"alignment" if self.current_xf.is_some() => {
                let xf = self.current_xf.as_mut().expect("checked is_some");
                xf.horizontal_alignment = attributes
                    .get("horizontal")
                    .and_then(|value| normalize_horizontal_alignment(value));
                xf.vertical_alignment = attributes
                    .get("vertical")
                    .and_then(|value| normalize_vertical_alignment(value));
                xf.wrap_text = attributes
                    .get("wrapText")
                    .and_then(|value| parse_xml_bool(value));
            }
            _ => {}
        }
        Ok(())
    }

    fn end(&mut self, name: &[u8], limits: &ExcelLimits) -> Result<()> {
        match name {
            b"numFmts" => self.in_num_formats = false,
            b"fonts" => self.in_fonts = false,
            b"fills" => self.in_fills = false,
            b"borders" => self.in_borders = false,
            b"cellXfs" => self.in_cell_xfs = false,
            b"font" if self.current_font.is_some() => self.finish_font(limits)?,
            b"fill" if self.current_fill.is_some() => self.finish_fill(limits)?,
            b"border" if self.current_border.is_some() => self.finish_border(limits)?,
            b"top" | b"right" | b"bottom" | b"left" => self.current_border_side = None,
            b"xf" if self.current_xf.is_some() => self.finish_xf(limits)?,
            _ => {}
        }
        Ok(())
    }

    fn finish_font(&mut self, limits: &ExcelLimits) -> Result<()> {
        if self.fonts.len() >= limits.max_styles {
            return Err(resource_limit_usize(
                "styles",
                self.fonts.len().saturating_add(1),
                limits.max_styles,
                "XLSX workbook exceeds the configured font limit",
            ));
        }
        self.fonts
            .push(self.current_font.take().unwrap_or_default());
        Ok(())
    }

    fn finish_fill(&mut self, limits: &ExcelLimits) -> Result<()> {
        if self.fills.len() >= limits.max_styles {
            return Err(resource_limit_usize(
                "styles",
                self.fills.len().saturating_add(1),
                limits.max_styles,
                "XLSX workbook exceeds the configured fill limit",
            ));
        }
        self.fills
            .push(self.current_fill.take().unwrap_or_default());
        Ok(())
    }

    fn finish_border(&mut self, limits: &ExcelLimits) -> Result<()> {
        if self.borders.len() >= limits.max_styles {
            return Err(resource_limit_usize(
                "styles",
                self.borders.len().saturating_add(1),
                limits.max_styles,
                "XLSX workbook exceeds the configured border limit",
            ));
        }
        self.borders
            .push(self.current_border.take().unwrap_or_default());
        self.current_border_side = None;
        Ok(())
    }

    fn finish_xf(&mut self, limits: &ExcelLimits) -> Result<()> {
        if self.raw_xfs.len() >= limits.max_styles {
            return Err(resource_limit_usize(
                "styles",
                self.raw_xfs.len().saturating_add(1),
                limits.max_styles,
                "XLSX workbook exceeds the configured cell-style limit",
            ));
        }
        self.raw_xfs
            .push(self.current_xf.take().unwrap_or_default());
        Ok(())
    }

    fn finish(self, limits: &ExcelLimits) -> Result<StyleTable> {
        let mut styles = Vec::new();
        let mut raw_to_deduplicated = Vec::with_capacity(self.raw_xfs.len());
        let mut deduplicated = HashMap::new();
        for raw in &self.raw_xfs {
            let style = self.render_xf(raw);
            if style.is_empty() {
                raw_to_deduplicated.push(None);
                continue;
            }
            let key = format!("{style:?}");
            if let Some(existing) = deduplicated.get(&key) {
                raw_to_deduplicated.push(Some(*existing));
                continue;
            }
            if styles.len() >= limits.max_styles {
                return Err(resource_limit_usize(
                    "styles",
                    styles.len().saturating_add(1),
                    limits.max_styles,
                    "XLSX workbook exceeds the configured deduplicated style limit",
                ));
            }
            let index = u32::try_from(styles.len()).map_err(|_| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "XLSX style index exceeds the supported integer range",
                )
            })?;
            deduplicated.insert(key, index);
            styles.push(style);
            raw_to_deduplicated.push(Some(index));
        }
        Ok(StyleTable {
            styles,
            raw_to_deduplicated,
        })
    }

    fn render_xf(&self, raw: &RawXf) -> PresentationStyle {
        let fill = self.fills.get(raw.fill_id).cloned().unwrap_or_default();
        let font = self
            .fonts
            .get(raw.font_id)
            .cloned()
            .filter(|font| !font_is_empty(font));
        let borders = self
            .borders
            .get(raw.border_id)
            .cloned()
            .filter(|border| !borders_is_empty(border));
        PresentationStyle {
            number_format: self
                .number_formats
                .get(&raw.number_format_id)
                .cloned()
                .or_else(|| builtin_number_format(raw.number_format_id).map(str::to_owned)),
            font,
            foreground_color: fill.foreground.clone(),
            background_color: fill.background.clone(),
            fill_color: fill.foreground,
            borders,
            horizontal_alignment: raw.horizontal_alignment.clone(),
            vertical_alignment: raw.vertical_alignment.clone(),
            wrap_text: raw.wrap_text,
        }
    }
}

fn parse_biff8_styles(workbook: &[u8], limits: &ExcelLimits) -> Result<StyleTable> {
    let mut fonts = Vec::new();
    let mut number_formats = HashMap::new();
    let mut xfs = Vec::new();
    let mut palette = Biff8Palette::default();
    let mut position = 0_usize;

    // FONT, FORMAT, XF, and PALETTE all live in the Globals Substream.  Do
    // not scan into a worksheet: the same record identifiers have different
    // meanings there and would make a malicious sheet look like an unlimited
    // style collection.
    while let Some((record, data, next)) = next_biff_record(workbook, position)? {
        position = next;
        if record == 0x000A {
            break;
        }
        match record {
            // Font (MS-XLS 2.4.122)
            0x0031 => {
                if fonts.len() >= limits.max_styles {
                    return Err(resource_limit_usize(
                        "styles",
                        fonts.len().saturating_add(1),
                        limits.max_styles,
                        "BIFF8 workbook exceeds the configured font limit",
                    ));
                }
                fonts.push(parse_biff8_font(data)?);
            }
            // Format (MS-XLS 2.4.126)
            0x041E => {
                let Some(format_id) = u16_at(data, 0) else {
                    return Err(TabularkError::new(
                        ErrorCode::ParseFailed,
                        "BIFF8 FORMAT record is truncated",
                    ));
                };
                if !number_formats.contains_key(&format_id)
                    && number_formats.len() >= limits.max_styles
                {
                    return Err(resource_limit_usize(
                        "styles",
                        number_formats.len().saturating_add(1),
                        limits.max_styles,
                        "BIFF8 workbook exceeds the configured number-format limit",
                    ));
                }
                let value = decode_biff8_unicode_string(&data[2..]).ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::ParseFailed,
                        "BIFF8 FORMAT record has an invalid Unicode format string",
                    )
                })?;
                number_formats.insert(format_id, value);
            }
            // XF (MS-XLS 2.4.353)
            0x00E0 => {
                if xfs.len() >= limits.max_styles {
                    return Err(resource_limit_usize(
                        "styles",
                        xfs.len().saturating_add(1),
                        limits.max_styles,
                        "BIFF8 workbook exceeds the configured cell-style limit",
                    ));
                }
                xfs.push(parse_biff8_xf(data)?);
            }
            // Palette (MS-XLS 2.4.188).  A later record replaces an earlier
            // one, matching the workbook-global state seen by Excel readers.
            0x0092 => palette = parse_biff8_palette(data)?,
            _ => {}
        }
    }

    let rendered_fonts = fonts
        .iter()
        .map(|font| render_biff8_font(font, &palette))
        .collect::<Vec<_>>();
    let mut styles = Vec::new();
    let mut raw_to_deduplicated = Vec::with_capacity(xfs.len());
    let mut deduplicated = HashMap::new();
    for (index, _) in xfs.iter().enumerate() {
        let raw = effective_biff8_xf(index, &xfs);
        let style = render_biff8_xf(&raw, &rendered_fonts, &number_formats, &palette);
        if style.is_empty() {
            raw_to_deduplicated.push(None);
            continue;
        }
        let key = format!("{style:?}");
        if let Some(existing) = deduplicated.get(&key) {
            raw_to_deduplicated.push(Some(*existing));
            continue;
        }
        if styles.len() >= limits.max_styles {
            return Err(resource_limit_usize(
                "styles",
                styles.len().saturating_add(1),
                limits.max_styles,
                "BIFF8 workbook exceeds the configured deduplicated style limit",
            ));
        }
        let style_index = u32::try_from(styles.len()).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "BIFF8 style index exceeds the supported integer range",
            )
        })?;
        deduplicated.insert(key, style_index);
        styles.push(style);
        raw_to_deduplicated.push(Some(style_index));
    }
    Ok(StyleTable {
        styles,
        raw_to_deduplicated,
    })
}

fn parse_biff8_font(data: &[u8]) -> Result<RawBiff8Font> {
    if data.len() < 16 {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "BIFF8 FONT record is truncated",
        ));
    }
    let height_twips = u16_at(data, 0).unwrap_or(0);
    let flags = u16_at(data, 2).unwrap_or(0);
    let weight = u16_at(data, 6).unwrap_or(0);
    let underline = data[10];
    let name = decode_biff8_short_string(&data[14..]).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ParseFailed,
            "BIFF8 FONT record has an invalid font name",
        )
    })?;
    Ok(RawBiff8Font {
        family: (!name.is_empty()).then_some(name),
        size: (height_twips > 0).then_some(f64::from(height_twips) / 20.0),
        bold: (weight >= 700).then_some(true),
        italic: (flags & 0x0002 != 0).then_some(true),
        underline: (underline != 0).then_some(true),
        color_index: Some(u16_at(data, 4).unwrap_or(0)),
    })
}

fn parse_biff8_xf(data: &[u8]) -> Result<RawBiff8Xf> {
    // BIFF8 CellXF is 14 bytes after the six-byte XF header.  Reading all
    // twenty bytes here also rejects the shorter pre-BIFF8 XF layouts.
    if data.len() < 20 {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "BIFF8 XF record is truncated",
        ));
    }
    let protection = u16_at(data, 4).unwrap_or(0);
    let alignment = data[6];
    let used_attributes = data[9];
    let border_styles = u16_at(data, 10).unwrap_or(0);
    let border_colors = u16_at(data, 12).unwrap_or(0);
    let border_and_fill = u32_at(data, 14).unwrap_or(0);
    let fill_colors = u16_at(data, 18).unwrap_or(0);
    let is_style = protection & 0x0004 != 0;

    Ok(RawBiff8Xf {
        is_style,
        parent: usize::from((protection >> 4) & 0x0FFF),
        font_index: usize::from(u16_at(data, 0).unwrap_or(0)),
        number_format_id: u16_at(data, 2).unwrap_or(0),
        horizontal_alignment: biff8_horizontal_alignment(alignment & 0x07),
        vertical_alignment: biff8_vertical_alignment((alignment >> 4) & 0x07),
        wrap_text: (alignment & 0x08 != 0).then_some(true),
        borders: RawBiff8Borders {
            left: RawBiff8BorderSide {
                style: (border_styles & 0x000F) as u8,
                color_index: (border_colors & 0x007F) as u8,
            },
            right: RawBiff8BorderSide {
                style: ((border_styles >> 4) & 0x000F) as u8,
                color_index: ((border_colors >> 7) & 0x007F) as u8,
            },
            top: RawBiff8BorderSide {
                style: ((border_styles >> 8) & 0x000F) as u8,
                color_index: (border_and_fill & 0x007F) as u8,
            },
            bottom: RawBiff8BorderSide {
                style: ((border_styles >> 12) & 0x000F) as u8,
                color_index: ((border_and_fill >> 7) & 0x007F) as u8,
            },
        },
        fill: RawBiff8Fill {
            pattern: ((border_and_fill >> 26) & 0x003F) as u8,
            foreground_index: (fill_colors & 0x007F) as u8,
            background_index: ((fill_colors >> 7) & 0x007F) as u8,
        },
        // CellXF attribute flags occupy bits 2 through 6 of the fourth
        // formatting byte.  Style XFs always provide their direct values.
        uses_number_format: is_style || used_attributes & 0x04 != 0,
        uses_font: is_style || used_attributes & 0x08 != 0,
        uses_alignment: is_style || used_attributes & 0x10 != 0,
        uses_borders: is_style || used_attributes & 0x20 != 0,
        uses_fill: is_style || used_attributes & 0x40 != 0,
    })
}

fn parse_biff8_palette(data: &[u8]) -> Result<Biff8Palette> {
    let Some(count) = u16_at(data, 0) else {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "BIFF8 PALETTE record is truncated",
        ));
    };
    if count != 56 || data.len() < 2 + usize::from(count) * 4 {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "BIFF8 PALETTE record does not contain 56 RGB entries",
        ));
    }
    let mut colors = Vec::with_capacity(usize::from(count));
    for index in 0..usize::from(count) {
        let offset = 2 + index * 4;
        colors.push(presentation_color(
            data[offset],
            data[offset + 1],
            data[offset + 2],
        ));
    }
    Ok(Biff8Palette {
        custom: Some(colors),
    })
}

fn effective_biff8_xf(index: usize, xfs: &[RawBiff8Xf]) -> RawBiff8Xf {
    let Some(raw) = xfs.get(index) else {
        return RawBiff8Xf::default();
    };
    let mut effective = raw.clone();
    if raw.is_style || raw.parent == index {
        return effective;
    }
    let Some(parent) = xfs.get(raw.parent).filter(|parent| parent.is_style) else {
        return effective;
    };
    if !raw.uses_number_format {
        effective.number_format_id = parent.number_format_id;
    }
    if !raw.uses_font {
        effective.font_index = parent.font_index;
    }
    if !raw.uses_alignment {
        effective.horizontal_alignment = parent.horizontal_alignment.clone();
        effective.vertical_alignment = parent.vertical_alignment.clone();
        effective.wrap_text = parent.wrap_text;
    }
    if !raw.uses_borders {
        effective.borders = parent.borders.clone();
    }
    if !raw.uses_fill {
        effective.fill = parent.fill.clone();
    }
    effective
}

fn render_biff8_font(font: &RawBiff8Font, palette: &Biff8Palette) -> PresentationFont {
    PresentationFont {
        family: font.family.clone(),
        size: font.size,
        bold: font.bold,
        italic: font.italic,
        underline: font.underline,
        color: font
            .color_index
            .and_then(|index| (index != 0).then(|| biff8_color(index, palette)).flatten()),
    }
}

fn render_biff8_xf(
    raw: &RawBiff8Xf,
    fonts: &[PresentationFont],
    number_formats: &HashMap<u16, String>,
    palette: &Biff8Palette,
) -> PresentationStyle {
    let font = biff8_font_position(raw.font_index)
        .and_then(|index| fonts.get(index))
        .cloned()
        .filter(|font| !font_is_empty(font));
    let (foreground_color, background_color, fill_color) = if raw.fill.pattern == 0 {
        (None, None, None)
    } else {
        let foreground_color = biff8_color(u16::from(raw.fill.foreground_index), palette);
        let background_color = biff8_color(u16::from(raw.fill.background_index), palette);
        (foreground_color.clone(), background_color, foreground_color)
    };
    let borders = render_biff8_borders(&raw.borders, palette);
    PresentationStyle {
        number_format: number_formats
            .get(&raw.number_format_id)
            .cloned()
            .or_else(|| builtin_number_format(u32::from(raw.number_format_id)).map(str::to_owned)),
        font,
        foreground_color,
        background_color,
        fill_color,
        borders,
        horizontal_alignment: raw.horizontal_alignment.clone(),
        vertical_alignment: raw.vertical_alignment.clone(),
        wrap_text: raw.wrap_text,
    }
}

fn render_biff8_borders(
    borders: &RawBiff8Borders,
    palette: &Biff8Palette,
) -> Option<PresentationBorders> {
    let result = PresentationBorders {
        top: render_biff8_border_side(borders.top, palette),
        right: render_biff8_border_side(borders.right, palette),
        bottom: render_biff8_border_side(borders.bottom, palette),
        left: render_biff8_border_side(borders.left, palette),
    };
    (!borders_is_empty(&result)).then_some(result)
}

fn render_biff8_border_side(
    side: RawBiff8BorderSide,
    palette: &Biff8Palette,
) -> Option<PresentationBorderSide> {
    let style = biff8_border_style(side.style);
    let color = (side.color_index != 0)
        .then(|| biff8_color(u16::from(side.color_index), palette))
        .flatten();
    (style.is_some() || color.is_some()).then_some(PresentationBorderSide { style, color })
}

fn biff8_font_position(index: usize) -> Option<usize> {
    // BIFF reserves font index 4 for compatibility with an old Excel font;
    // all physical FONT records after it are addressed one lower.
    match index {
        4 => None,
        0..=3 => Some(index),
        _ => index.checked_sub(1),
    }
}

fn biff8_horizontal_alignment(value: u8) -> Option<String> {
    let value = match value {
        0 => "general",
        1 => "left",
        2 => "center",
        3 => "right",
        5 | 7 => "justify",
        _ => return None,
    };
    Some(value.to_owned())
}

fn biff8_vertical_alignment(value: u8) -> Option<String> {
    let value = match value {
        0 => "top",
        1 => "center",
        2 => "bottom",
        3 | 4 => "justify",
        _ => return None,
    };
    Some(value.to_owned())
}

fn biff8_border_style(value: u8) -> Option<String> {
    let value = match value {
        0 => return None,
        1 => "thin",
        2 => "medium",
        3 | 8 | 9 | 10 | 11 | 12 | 13 => "dashed",
        4 | 7 => "dotted",
        5 => "thick",
        6 => "double",
        _ => return None,
    };
    Some(value.to_owned())
}

fn biff8_color(index: u16, palette: &Biff8Palette) -> Option<PresentationColor> {
    match index {
        0x0000 => Some(presentation_color(0, 0, 0)),
        0x0001 => Some(presentation_color(255, 255, 255)),
        0x0002 => Some(presentation_color(255, 0, 0)),
        0x0003 => Some(presentation_color(0, 255, 0)),
        0x0004 => Some(presentation_color(0, 0, 255)),
        0x0005 => Some(presentation_color(255, 255, 0)),
        0x0006 => Some(presentation_color(255, 0, 255)),
        0x0007 => Some(presentation_color(0, 255, 255)),
        0x0008..=0x003F => {
            let palette_index = usize::from(index - 0x0008);
            palette
                .custom
                .as_ref()
                .and_then(|colors| colors.get(palette_index))
                .cloned()
                .or_else(|| default_biff8_palette_color(palette_index))
        }
        // Automatic / system colours are intentionally absent from the
        // portable CSS contract.  The Canvas has its own system and
        // forced-colour rendering policy for them.
        _ => None,
    }
}

fn presentation_color(red: u8, green: u8, blue: u8) -> PresentationColor {
    PresentationColor {
        css: Some(format!("#{red:02X}{green:02X}{blue:02X}")),
    }
}

fn default_biff8_palette_color(index: usize) -> Option<PresentationColor> {
    const PALETTE: [(u8, u8, u8); 56] = [
        (0, 0, 0),
        (255, 255, 255),
        (255, 0, 0),
        (0, 255, 0),
        (0, 0, 255),
        (255, 255, 0),
        (255, 0, 255),
        (0, 255, 255),
        (128, 0, 0),
        (0, 128, 0),
        (0, 0, 128),
        (128, 128, 0),
        (128, 0, 128),
        (0, 128, 128),
        (192, 192, 192),
        (128, 128, 128),
        (153, 153, 255),
        (153, 51, 102),
        (255, 255, 204),
        (204, 255, 255),
        (102, 0, 102),
        (255, 128, 128),
        (0, 102, 204),
        (204, 204, 255),
        (0, 0, 128),
        (255, 0, 255),
        (255, 255, 0),
        (0, 255, 255),
        (128, 0, 128),
        (128, 0, 0),
        (0, 128, 128),
        (0, 0, 255),
        (0, 204, 255),
        (204, 255, 255),
        (204, 255, 204),
        (255, 255, 153),
        (153, 204, 255),
        (255, 153, 204),
        (204, 153, 255),
        (255, 204, 153),
        (51, 102, 255),
        (51, 204, 204),
        (153, 204, 0),
        (255, 204, 0),
        (255, 153, 0),
        (255, 102, 0),
        (102, 102, 153),
        (150, 150, 150),
        (0, 51, 102),
        (51, 153, 102),
        (0, 51, 0),
        (51, 51, 0),
        (153, 51, 0),
        (153, 51, 102),
        (51, 51, 153),
        (51, 51, 51),
    ];
    let (red, green, blue) = *PALETTE.get(index)?;
    Some(presentation_color(red, green, blue))
}

fn parse_biff8_bound_sheets(workbook: &[u8]) -> Result<Vec<Biff8BoundSheet>> {
    let mut sheets = Vec::new();
    let mut position = 0_usize;
    while let Some((record, data, next)) = next_biff_record(workbook, position)? {
        position = next;
        if record == 0x000A {
            break;
        }
        if record != 0x0085 || data.len() < 8 {
            continue;
        }
        let offset = usize::try_from(u32_at(data, 0).unwrap_or(0)).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "BIFF8 worksheet offset exceeds the supported integer range",
            )
        })?;
        let sheet_type = data[5];
        if sheet_type != 0 {
            continue;
        }
        let Some(name) = decode_biff8_short_string(&data[6..]) else {
            continue;
        };
        sheets.push(Biff8BoundSheet { name, offset });
    }
    Ok(sheets)
}

#[derive(Clone, Debug)]
struct Biff8BoundSheet {
    name: String,
    offset: usize,
}

fn parse_biff8_worksheet(
    workbook: &[u8],
    offset: usize,
    styles: &[Option<u32>],
    limits: &ExcelLimits,
) -> Result<WorksheetPresentation> {
    if offset >= workbook.len() {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "BIFF8 worksheet offset is outside the Workbook stream",
        ));
    }
    let mut layout = WorksheetPresentation::default();
    let mut position = offset;
    let mut pane = None;
    let mut frozen = false;
    while let Some((record, data, next)) = next_biff_record(workbook, position)? {
        position = next;
        match record {
            0x000A => break,
            // DIMENSIONS stores zero-based inclusive start coordinates and
            // exclusive end coordinates.  Parsing it before Calamine opens a
            // dense Range prevents a sparse-but-enormous worksheet from
            // allocating its declared rectangle first.
            0x0200 if data.len() >= 12 => {
                let row_end = u64::from(u32_at(data, 4).unwrap_or(0));
                let column_end = u64::from(u16_at(data, 10).unwrap_or(0));
                update_biff8_extent(
                    &mut layout,
                    row_end,
                    column_end,
                    limits,
                    "BIFF8 worksheet dimension exceeds the configured cell limit",
                )?;
            }
            0x0006 | 0x0201 | 0x0203 | 0x0204 | 0x0205 | 0x027E | 0x00D6 | 0x00FD
                if data.len() >= 6 =>
            {
                let row = u64::from(u16_at(data, 0).unwrap_or(0));
                let column = u64::from(u16_at(data, 2).unwrap_or(0));
                let row_end = row.saturating_add(1);
                let column_end = column.saturating_add(1);
                update_biff8_extent(
                    &mut layout,
                    row_end,
                    column_end,
                    limits,
                    "BIFF8 cell expands the worksheet beyond the configured cell limit",
                )?;
                apply_biff8_cell_style(
                    &mut layout,
                    row,
                    column,
                    u16_at(data, 4).unwrap_or(0),
                    styles,
                    limits,
                )?;
            }
            0x00BD | 0x00BE if data.len() >= 6 => {
                let row = u64::from(u16_at(data, 0).unwrap_or(0));
                let first_column = u64::from(u16_at(data, 2).unwrap_or(0));
                let last_column =
                    u64::from(u16_at(data, data.len().saturating_sub(2)).unwrap_or(0));
                if last_column < first_column {
                    return Err(TabularkError::new(
                        ErrorCode::ParseFailed,
                        "BIFF8 multi-cell record has an inverted column range",
                    ));
                }
                let row_end = row.saturating_add(1);
                let column_end = last_column.saturating_add(1);
                update_biff8_extent(
                    &mut layout,
                    row_end,
                    column_end,
                    limits,
                    "BIFF8 multi-cell record expands the worksheet beyond the configured cell limit",
                )?;
                let declared = usize::try_from(last_column - first_column + 1).map_err(|_| {
                    TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "BIFF8 multi-cell count exceeds the supported integer range",
                    )
                })?;
                let item_width = if record == 0x00BD { 6 } else { 2 };
                let available = (data.len() - 6) / item_width;
                if declared > available {
                    return Err(TabularkError::new(
                        ErrorCode::ParseFailed,
                        "BIFF8 multi-cell record contains fewer styles than declared",
                    ));
                }
                for index in 0..declared {
                    let style_offset = 4 + index * item_width;
                    let column = first_column
                        .checked_add(u64::try_from(index).map_err(|_| {
                            TabularkError::new(
                                ErrorCode::ResourceLimit,
                                "BIFF8 multi-cell column offset exceeds the supported integer range",
                            )
                        })?)
                        .ok_or_else(|| {
                            TabularkError::new(
                                ErrorCode::ResourceLimit,
                                "BIFF8 multi-cell column coordinate overflows",
                            )
                        })?;
                    apply_biff8_cell_style(
                        &mut layout,
                        row,
                        column,
                        u16_at(data, style_offset).unwrap_or(0),
                        styles,
                        limits,
                    )?;
                }
            }
            0x023E if data.len() >= 2 => {
                let flags = u16_at(data, 0).unwrap_or(0);
                frozen = flags & 0x0008 != 0;
            }
            0x0041 if data.len() >= 4 => {
                pane = Some((
                    u64::from(u16_at(data, 0).unwrap_or(0)),
                    u64::from(u16_at(data, 2).unwrap_or(0)),
                ));
            }
            0x0208 if data.len() >= 16 => {
                let row = u64::from(u16_at(data, 0).unwrap_or(0));
                let height = u64::from(u16_at(data, 6).unwrap_or(0));
                let flags = u32_at(data, 12).unwrap_or(0);
                let hidden = flags & 0x20 != 0;
                let max_rows = limits.max_worksheet_rows.min(BIFF8_MAX_ROWS);
                if row >= max_rows {
                    return Err(resource_limit(
                        "worksheet-rows",
                        row.saturating_add(1),
                        max_rows,
                        "BIFF8 row layout exceeds the configured worksheet row limit",
                    ));
                }
                insert_axis_entry(
                    &mut layout.rows,
                    row,
                    (height > 0).then(|| points_to_pixels(height as f64 / 20.0)),
                    hidden.then_some(true),
                    limits,
                )?;
            }
            0x007D if data.len() >= 10 => {
                let first = u64::from(u16_at(data, 0).unwrap_or(0));
                let last = u64::from(u16_at(data, 2).unwrap_or(0));
                let width = u64::from(u16_at(data, 4).unwrap_or(0));
                let flags = u16_at(data, 8).unwrap_or(0);
                let max_columns = limits.max_worksheet_columns.min(BIFF8_MAX_COLUMNS);
                if last < first || last >= max_columns {
                    return Err(resource_limit(
                        "worksheet-columns",
                        last.saturating_add(1),
                        max_columns,
                        "BIFF8 column layout exceeds the configured worksheet column limit",
                    ));
                }
                for column in first..=last {
                    insert_axis_entry(
                        &mut layout.columns,
                        column,
                        (width > 0).then(|| column_width_to_pixels(width as f64 / 256.0)),
                        (flags & 0x0001 != 0).then_some(true),
                        limits,
                    )?;
                }
            }
            0x00E5 if data.len() >= 2 => {
                let count = usize::from(u16_at(data, 0).unwrap_or(0));
                let available = (data.len() - 2) / 8;
                for index in 0..count.min(available) {
                    if layout.merged_cells.len() >= limits.max_merged_cells {
                        return Err(resource_limit_usize(
                            "merged-cells",
                            layout.merged_cells.len().saturating_add(1),
                            limits.max_merged_cells,
                            "BIFF8 workbook exceeds the configured merged-cell limit",
                        ));
                    }
                    let start = 2 + index * 8;
                    let row_start = u64::from(u16_at(data, start).unwrap_or(0));
                    let row_end = u64::from(u16_at(data, start + 2).unwrap_or(0)).saturating_add(1);
                    let column_start = u64::from(u16_at(data, start + 4).unwrap_or(0));
                    let column_end =
                        u64::from(u16_at(data, start + 6).unwrap_or(0)).saturating_add(1);
                    if row_end > row_start && column_end > column_start {
                        update_biff8_extent(
                            &mut layout,
                            row_end,
                            column_end,
                            limits,
                            "BIFF8 merged cell expands the worksheet beyond the configured cell limit",
                        )?;
                        layout.merged_cells.push(PresentationMergedCell {
                            row_start,
                            row_end,
                            column_start,
                            column_end,
                        });
                    }
                }
            }
            _ => {}
        }
    }
    if let Some((columns, rows)) = pane {
        if frozen || columns > 0 || rows > 0 {
            layout.frozen_columns = columns;
            layout.frozen_rows = rows;
        }
    }
    Ok(layout)
}

fn apply_biff8_cell_style(
    layout: &mut WorksheetPresentation,
    row: u64,
    column: u64,
    raw_style: u16,
    styles: &[Option<u32>],
    limits: &ExcelLimits,
) -> Result<()> {
    let Some(Some(style)) = styles.get(usize::from(raw_style)) else {
        return Ok(());
    };
    let coordinate = CellCoordinate { row, column };
    if !layout.styles.contains_key(&coordinate) && layout.styles.len() >= limits.max_styled_cells {
        return Err(resource_limit_usize(
            "styled-cells",
            layout.styles.len().saturating_add(1),
            limits.max_styled_cells,
            "BIFF8 worksheet exceeds the configured styled-cell limit",
        ));
    }
    layout.styles.insert(coordinate, *style);
    Ok(())
}

fn update_biff8_extent(
    layout: &mut WorksheetPresentation,
    row_end: u64,
    column_end: u64,
    limits: &ExcelLimits,
    message: &str,
) -> Result<()> {
    if row_end > BIFF8_MAX_ROWS || column_end > BIFF8_MAX_COLUMNS {
        return Err(TabularkError::new(ErrorCode::ResourceLimit, message)
            .with_detail("resource", "worksheet-dimensions")
            .with_detail("requiredRows", row_end)
            .with_detail("availableRows", BIFF8_MAX_ROWS)
            .with_detail("requiredColumns", column_end)
            .with_detail("availableColumns", BIFF8_MAX_COLUMNS));
    }
    update_layout_extent(
        layout,
        row_end,
        column_end,
        limits,
        "worksheet-dimensions",
        message,
    )
}

fn next_biff_record(data: &[u8], position: usize) -> Result<Option<(u16, &[u8], usize)>> {
    if position == data.len() {
        return Ok(None);
    }
    let Some(header_end) = position.checked_add(4) else {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "BIFF8 record header offset overflows",
        ));
    };
    if header_end > data.len() {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "BIFF8 Workbook stream ends in a truncated record header",
        ));
    }
    let record = u16_at(&data[position..header_end], 0).unwrap_or(0);
    let length = usize::from(u16_at(&data[position..header_end], 2).unwrap_or(0));
    let start = header_end;
    let end = start.checked_add(length).ok_or_else(|| {
        TabularkError::new(ErrorCode::ParseFailed, "BIFF8 record length overflows")
    })?;
    if end > data.len() {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "BIFF8 Workbook stream ends in a truncated record",
        ));
    }
    Ok(Some((record, &data[start..end], end)))
}

fn decode_biff8_short_string(data: &[u8]) -> Option<String> {
    if data.len() < 2 {
        return None;
    }
    let count = usize::from(data[0]);
    let wide = data[1] & 0x01 != 0;
    let bytes = &data[2..];
    if wide {
        let length = count.checked_mul(2)?;
        if bytes.len() < length {
            return None;
        }
        let units = bytes[..length]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        String::from_utf16(&units).ok()
    } else {
        if bytes.len() < count {
            return None;
        }
        Some(
            bytes[..count]
                .iter()
                .map(|byte| char::from(*byte))
                .collect(),
        )
    }
}

fn decode_biff8_unicode_string(data: &[u8]) -> Option<String> {
    if data.len() < 3 {
        return None;
    }
    let count = usize::from(u16_at(data, 0)?);
    let wide = data[2] & 0x01 != 0;
    let bytes = &data[3..];
    if wide {
        let length = count.checked_mul(2)?;
        if bytes.len() < length {
            return None;
        }
        let units = bytes[..length]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        String::from_utf16(&units).ok()
    } else {
        if bytes.len() < count {
            return None;
        }
        Some(
            bytes[..count]
                .iter()
                .map(|byte| char::from(*byte))
                .collect(),
        )
    }
}

fn xml_attributes(
    event: &BytesStart<'_>,
    decoder: quick_xml::encoding::Decoder,
) -> Result<HashMap<String, String>> {
    let mut result = HashMap::new();
    for attribute in event.attributes().with_checks(false) {
        let attribute =
            attribute.map_err(|error| xml_error("invalid XLSX XML attribute", error))?;
        let key = String::from_utf8_lossy(local_name(attribute.key.as_ref())).into_owned();
        let value = attribute
            .decode_and_unescape_value(decoder)
            .map_err(|error| xml_error("invalid XLSX XML attribute value", error))?
            .into_owned();
        result.insert(key, value);
    }
    Ok(result)
}

fn local_name(name: &[u8]) -> &[u8] {
    name.rsplit(|byte| *byte == b':').next().unwrap_or(name)
}

fn resolve_ooxml_target(base: &str, target: &str) -> Option<String> {
    let combined = if target.starts_with('/') {
        target.trim_start_matches('/').replace('\\', "/")
    } else {
        format!("{base}{}", target.replace('\\', "/"))
    };
    let mut parts = Vec::new();
    for part in combined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part if part.contains(':') => return None,
            part => parts.push(part),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn parse_a1_region(value: &str) -> Option<PresentationMergedCell> {
    let (start, end) = value.split_once(':').unwrap_or((value, value));
    let start = parse_a1_cell(start)?;
    let end = parse_a1_cell(end)?;
    let row_start = start.row.min(end.row);
    let column_start = start.column.min(end.column);
    let row_end = start.row.max(end.row).checked_add(1)?;
    let column_end = start.column.max(end.column).checked_add(1)?;
    Some(PresentationMergedCell {
        row_start,
        row_end,
        column_start,
        column_end,
    })
}

fn parse_a1_cell(value: &str) -> Option<CellCoordinate> {
    let value = value.trim().trim_start_matches('$');
    let mut letters = 0_u64;
    let mut length = 0_usize;
    for character in value.bytes() {
        let upper = character.to_ascii_uppercase();
        if !upper.is_ascii_uppercase() {
            break;
        }
        letters = letters
            .checked_mul(26)?
            .checked_add(u64::from(upper - b'A' + 1))?;
        length += 1;
    }
    if length == 0 {
        return None;
    }
    let row = value[length..]
        .trim_start_matches('$')
        .parse::<u64>()
        .ok()?
        .checked_sub(1)?;
    Some(CellCoordinate {
        row,
        column: letters.checked_sub(1)?,
    })
}

fn parse_axis_split(value: &str) -> Option<u64> {
    let value = value.parse::<f64>().ok()?;
    (value.is_finite() && value >= 0.0).then_some(value.floor() as u64)
}

fn parse_xml_bool(value: &str) -> Option<bool> {
    match value {
        "1" | "true" | "TRUE" => Some(true),
        "0" | "false" | "FALSE" => Some(false),
        _ => None,
    }
}

fn points_to_pixels(points: f64) -> f64 {
    points * 96.0 / 72.0
}

fn column_width_to_pixels(width: f64) -> f64 {
    (width * 7.0 + 5.0).floor().max(0.0)
}

fn parse_u32_attribute(attributes: &HashMap<String, String>, key: &str) -> Option<u32> {
    attributes
        .get(key)
        .and_then(|value| value.parse::<u32>().ok())
}

fn parse_usize_attribute(attributes: &HashMap<String, String>, key: &str) -> Option<usize> {
    attributes
        .get(key)
        .and_then(|value| value.parse::<usize>().ok())
}

fn color_from_attributes(attributes: &HashMap<String, String>) -> Option<PresentationColor> {
    let rgb = attributes.get("rgb")?;
    let rgb = rgb.trim_start_matches('#');
    let rgb = match rgb.len() {
        8 => &rgb[2..],
        6 => rgb,
        _ => return None,
    };
    if !rgb.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(PresentationColor {
        css: Some(format!("#{}", rgb.to_ascii_uppercase())),
    })
}

fn normalize_border_style(value: &str) -> Option<String> {
    let normalized = match value {
        "none" => "none",
        "thin" => "thin",
        "medium" => "medium",
        "thick" => "thick",
        "dashed" | "mediumDashed" | "dashDot" | "mediumDashDot" | "slantDashDot" => "dashed",
        "dotted" | "hair" => "dotted",
        "double" => "double",
        _ => return None,
    };
    Some(normalized.to_owned())
}

fn normalize_horizontal_alignment(value: &str) -> Option<String> {
    match value {
        "general" | "left" | "center" | "right" | "justify" => Some(value.to_owned()),
        _ => None,
    }
}

fn normalize_vertical_alignment(value: &str) -> Option<String> {
    match value {
        "top" | "center" | "bottom" | "justify" => Some(value.to_owned()),
        _ => None,
    }
}

fn set_border_side(
    border: &mut PresentationBorders,
    side: BorderSide,
    value: PresentationBorderSide,
) {
    match side {
        BorderSide::Top => border.top = Some(value),
        BorderSide::Right => border.right = Some(value),
        BorderSide::Bottom => border.bottom = Some(value),
        BorderSide::Left => border.left = Some(value),
    }
}

fn border_side_mut(
    border: &mut PresentationBorders,
    side: BorderSide,
) -> Option<&mut PresentationBorderSide> {
    match side {
        BorderSide::Top => border.top.as_mut(),
        BorderSide::Right => border.right.as_mut(),
        BorderSide::Bottom => border.bottom.as_mut(),
        BorderSide::Left => border.left.as_mut(),
    }
}

fn font_is_empty(font: &PresentationFont) -> bool {
    font.family.is_none()
        && font.size.is_none()
        && font.bold.is_none()
        && font.italic.is_none()
        && font.underline.is_none()
        && font.color.is_none()
}

fn border_side_is_empty(side: &PresentationBorderSide) -> bool {
    side.style.is_none() && side.color.is_none()
}

fn borders_is_empty(border: &PresentationBorders) -> bool {
    [
        border.top.as_ref(),
        border.right.as_ref(),
        border.bottom.as_ref(),
        border.left.as_ref(),
    ]
    .into_iter()
    .flatten()
    .all(border_side_is_empty)
}

fn builtin_number_format(id: u32) -> Option<&'static str> {
    match id {
        1 => Some("0"),
        2 => Some("0.00"),
        3 => Some("#,##0"),
        4 => Some("#,##0.00"),
        9 => Some("0%"),
        10 => Some("0.00%"),
        11 => Some("0.00E+00"),
        12 => Some("# ?/?"),
        13 => Some("# ??/??"),
        14 => Some("m/d/yy"),
        15 => Some("d-mmm-yy"),
        16 => Some("d-mmm"),
        17 => Some("mmm-yy"),
        18 => Some("h:mm AM/PM"),
        19 => Some("h:mm:ss AM/PM"),
        20 => Some("h:mm"),
        21 => Some("h:mm:ss"),
        22 => Some("m/d/yy h:mm"),
        37 => Some("#,##0 ;(#,##0)"),
        38 => Some("#,##0 ;[Red](#,##0)"),
        39 => Some("#,##0.00;(#,##0.00)"),
        40 => Some("#,##0.00;[Red](#,##0.00)"),
        45 => Some("mm:ss"),
        46 => Some("[h]:mm:ss"),
        47 => Some("mmss.0"),
        48 => Some("##0.0E+0"),
        49 => Some("@"),
        _ => None,
    }
}

fn u16_at(data: &[u8], offset: usize) -> Option<u16> {
    let bytes = data.get(offset..offset.checked_add(2)?)?;
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn u32_at(data: &[u8], offset: usize) -> Option<u32> {
    let bytes = data.get(offset..offset.checked_add(4)?)?;
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn xml_error(error_message: &str, error: impl std::fmt::Display) -> TabularkError {
    TabularkError::new(ErrorCode::ParseFailed, error_message)
        .with_detail("reason", error.to_string())
}

fn resource_limit(resource: &str, required: u64, available: u64, message: &str) -> TabularkError {
    TabularkError::new(ErrorCode::ResourceLimit, message)
        .with_detail("resource", resource)
        .with_detail("required", required)
        .with_detail("available", available)
}

fn resource_limit_usize(
    resource: &str,
    required: usize,
    available: usize,
    message: &str,
) -> TabularkError {
    TabularkError::new(ErrorCode::ResourceLimit, message)
        .with_detail("resource", resource)
        .with_detail("required", required)
        .with_detail("available", available)
}
