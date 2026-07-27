use std::io::{Cursor, Read};

use wasm_bindgen::prelude::*;

const MAX_ENTRIES: usize = 4_096;
const MAX_EXPANDED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_XML_DEPTH: usize = 256;

/// Result retained only long enough for JavaScript to transfer the PDF to the
/// PDFium Worker. The parsed rwml model is dropped before this value returns.
#[wasm_bindgen]
pub struct ConvertedPreview {
    pdf: Vec<u8>,
    page_count: u32,
    warning_report: String,
}

#[wasm_bindgen]
impl ConvertedPreview {
    #[wasm_bindgen(getter)]
    pub fn page_count(&self) -> u32 {
        self.page_count
    }

    pub fn pdf_bytes(&self) -> Vec<u8> {
        self.pdf.clone()
    }

    pub fn warning_report(&self) -> String {
        self.warning_report.clone()
    }
}

/// Preview-grade DOCX → PDF conversion. Legacy CFB `.doc` input is rejected
/// at this public PoC boundary even though rwml can parse it experimentally.
#[wasm_bindgen]
pub fn convert_docx_to_pdf(bytes: &[u8]) -> Result<ConvertedPreview, JsValue> {
    preflight_docx(bytes).map_err(js_error)?;
    let document = rwml::Document::open(bytes).map_err(|error| js_error(error.to_string()))?;
    let source_report = document.report().to_json();
    let model = document.model();
    drop(document);

    let fonts = [
        rwml_fonts::noto_sans_kr_subset_with_hanja().to_vec(),
        rwml_fonts::noto_sans_arabic_subset().to_vec(),
        rwml_fonts::noto_sans_hebrew_subset().to_vec(),
    ];
    let rendered = rwml::render_pdf_with_fonts_and_report(&model, &fonts);
    let page_count = u32::try_from(rendered.report.pages)
        .map_err(|_| js_error("rendered page count exceeds u32"))?;
    let render_warnings = rendered
        .report
        .warnings
        .iter()
        .map(|warning| format!("\"{}\"", json_escape(&format!("{warning:?}"))))
        .collect::<Vec<_>>()
        .join(",");
    let warning_report =
        format!("{{\"source\":{source_report},\"renderWarnings\":[{render_warnings}]}}");

    Ok(ConvertedPreview {
        pdf: rendered.pdf,
        page_count,
        warning_report,
    })
}

fn preflight_docx(bytes: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(b"PK") {
        return Err("only a DOCX ZIP container is accepted".into());
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| "invalid DOCX ZIP container".to_string())?;
    if archive.len() > MAX_ENTRIES {
        return Err("DOCX entry count exceeds the configured limit".into());
    }
    let mut expanded = 0_u64;
    let mut has_document = false;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| "invalid DOCX ZIP entry".to_string())?;
        expanded = expanded
            .checked_add(entry.size())
            .ok_or_else(|| "DOCX expanded size overflow".to_string())?;
        if expanded > MAX_EXPANDED_BYTES {
            return Err("DOCX expanded size exceeds the configured limit".into());
        }
        let name = entry.name().replace('\\', "/").to_ascii_lowercase();
        if name == "word/document.xml" {
            has_document = true;
        }
        if name.ends_with(".xml") || name.ends_with(".rels") {
            if entry.size() > 8 * 1024 * 1024 {
                return Err("DOCX XML part exceeds the configured limit".into());
            }
            let mut xml = String::new();
            entry
                .take(8 * 1024 * 1024)
                .read_to_string(&mut xml)
                .map_err(|_| "DOCX XML is not valid UTF-8".to_string())?;
            validate_xml_depth(&xml)?;
        }
    }
    if !has_document {
        return Err("DOCX is missing word/document.xml".into());
    }
    Ok(())
}

fn validate_xml_depth(xml: &str) -> Result<(), String> {
    let mut depth = 0_usize;
    for token in xml.split('<').skip(1) {
        if token.starts_with('/') {
            depth = depth.saturating_sub(1);
        } else if !token.starts_with('?') && !token.starts_with('!') && !token.contains("/>") {
            depth += 1;
            if depth > MAX_XML_DEPTH {
                return Err("DOCX XML depth exceeds the configured limit".into());
            }
        }
    }
    Ok(())
}

fn json_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

fn js_error(message: impl AsRef<str>) -> JsValue {
    JsValue::from_str(message.as_ref())
}
