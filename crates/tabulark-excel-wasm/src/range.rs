//! Bounded, range-backed container primitives for the Excel adapter.
//!
//! The WebAssembly facade owns the asynchronous operation state.  This module
//! deliberately contains no JavaScript types: it indexes ZIP/ZIP64 packages,
//! validates and retains non-overlapping source ranges, produces compact OOXML
//! packages for a selected worksheet, and follows CFB sector chains through a
//! sparse `Read + Seek` view.  Keeping these mechanics in Rust makes every
//! offset calculation use checked `u64` arithmetic before a host range is
//! requested.

use std::collections::{BTreeMap, HashMap};
use std::fmt::{Display, Formatter};
use std::io::{self, Cursor, Read, Seek, SeekFrom};

use quick_xml::Reader as XmlReader;
use quick_xml::events::Event as XmlEvent;
use tabulark::{ErrorCode, Result, TabularkError};
use zip::ZipArchive;

use crate::ExcelSheetVisibility;

pub(crate) const RANGE_TAIL_BYTES: u64 = 128 * 1024;
pub(crate) const RANGE_CHUNK_BYTES: u64 = 1024 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 16_384;
const MAX_COMPRESSED_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EXPANDED_ENTRY_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HostRange {
    pub(crate) offset: u64,
    pub(crate) length: u64,
}

impl HostRange {
    pub(crate) fn new(offset: u64, length: u64, source_length: u64) -> Result<Self> {
        if length == 0 {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Excel source range length must be positive",
            ));
        }
        let end = offset.checked_add(length).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::InvalidArgument,
                "Excel source range end overflows u64",
            )
        })?;
        if end > source_length {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Excel source range lies outside the source",
            )
            .with_detail("offset", offset)
            .with_detail("length", length)
            .with_detail("sourceLength", source_length));
        }
        Ok(Self { offset, length })
    }

    pub(crate) fn end(&self) -> u64 {
        // The constructor is the only way to create a HostRange.
        self.offset + self.length
    }
}

#[derive(Clone, Debug)]
pub(crate) struct IndexedRanges {
    source_length: u64,
    ranges: BTreeMap<u64, Vec<u8>>,
    retained_bytes: u64,
}

impl IndexedRanges {
    pub(crate) fn new(source_length: u64) -> Self {
        Self {
            source_length,
            ranges: BTreeMap::new(),
            retained_bytes: 0,
        }
    }

    pub(crate) fn source_length(&self) -> u64 {
        self.source_length
    }

    pub(crate) fn retained_bytes(&self) -> u64 {
        self.retained_bytes
    }

    pub(crate) fn insert(&mut self, requested: &HostRange, bytes: Vec<u8>) -> Result<()> {
        if requested.end() > self.source_length {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Excel range result lies outside the source",
            ));
        }
        let actual = u64::try_from(bytes.len()).map_err(|_| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel range result length exceeds u64",
            )
        })?;
        if actual != requested.length {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Excel range result length does not match its action",
            )
            .with_detail("expectedLength", requested.length)
            .with_detail("actualLength", actual));
        }

        if let Some((&start, existing)) = self.ranges.range(..=requested.offset).next_back() {
            let existing_end = start
                .checked_add(u64::try_from(existing.len()).map_err(|_| {
                    TabularkError::new(ErrorCode::ResourceLimit, "indexed range exceeds u64")
                })?)
                .ok_or_else(|| {
                    TabularkError::new(ErrorCode::ResourceLimit, "indexed range end overflows")
                })?;
            if existing_end > requested.offset {
                if start == requested.offset && existing.as_slice() == bytes.as_slice() {
                    return Ok(());
                }
                return Err(TabularkError::new(
                    ErrorCode::InvalidArgument,
                    "Excel range result overlaps an indexed range",
                ));
            }
        }
        if let Some((&next, _)) = self.ranges.range(requested.offset..).next()
            && next < requested.end()
        {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Excel range result overlaps an indexed range",
            ));
        }
        self.retained_bytes = self.retained_bytes.checked_add(actual).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "Excel indexed range accounting overflows",
            )
        })?;
        let mut start = requested.offset;
        let mut merged = bytes;
        if let Some((&previous_start, previous)) = self.ranges.range(..start).next_back() {
            let previous_length = u64::try_from(previous.len()).map_err(|_| {
                TabularkError::new(ErrorCode::ResourceLimit, "indexed range exceeds u64")
            })?;
            if previous_start.checked_add(previous_length) == Some(start) {
                let mut previous = self
                    .ranges
                    .remove(&previous_start)
                    .expect("adjacent indexed range remains present");
                previous.extend_from_slice(&merged);
                merged = previous;
                start = previous_start;
            }
        }
        let merged_end = start
            .checked_add(u64::try_from(merged.len()).map_err(|_| {
                TabularkError::new(ErrorCode::ResourceLimit, "indexed range exceeds u64")
            })?)
            .ok_or_else(|| {
                TabularkError::new(ErrorCode::ResourceLimit, "indexed range end overflows")
            })?;
        if let Some(next) = self.ranges.remove(&merged_end) {
            merged.extend_from_slice(&next);
        }
        self.ranges.insert(start, merged);
        Ok(())
    }

    pub(crate) fn bytes(&self, range: &HostRange) -> Option<&[u8]> {
        let (&start, bytes) = self.ranges.range(..=range.offset).next_back()?;
        let relative = range.offset.checked_sub(start)?;
        let relative = usize::try_from(relative).ok()?;
        let length = usize::try_from(range.length).ok()?;
        let end = relative.checked_add(length)?;
        bytes.get(relative..end)
    }

    /// Returns the first unindexed gap inside `range` without re-requesting
    /// any retained bytes. A parser may ask for a structure that contains an
    /// already indexed prefix (for example the first ZIP local header after
    /// the eight-byte container signature); host results must remain strictly
    /// non-overlapping even in that case.
    pub(crate) fn first_missing(&self, range: &HostRange) -> Result<Option<HostRange>> {
        if range.end() > self.source_length {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "Excel missing-range query lies outside the source",
            ));
        }
        let mut position = range.offset;
        while position < range.end() {
            if let Some((&start, bytes)) = self.ranges.range(..=position).next_back() {
                let length = u64::try_from(bytes.len()).map_err(|_| {
                    TabularkError::new(ErrorCode::ResourceLimit, "indexed range exceeds u64")
                })?;
                let end = start.checked_add(length).ok_or_else(|| {
                    TabularkError::new(ErrorCode::ResourceLimit, "indexed range end overflows")
                })?;
                if end > position {
                    position = end.min(range.end());
                    continue;
                }
            }

            let missing_end = self
                .ranges
                .range(position..)
                .next()
                .map_or(range.end(), |(&next, _)| next.min(range.end()));
            if missing_end > position {
                return HostRange::new(position, missing_end - position, self.source_length)
                    .map(Some);
            }

            // `insert` merges adjacent segments, so reaching a segment that
            // starts exactly at `position` should have been handled above.
            return Err(TabularkError::new(
                ErrorCode::RuntimeFailure,
                "Excel indexed range map contains an unreachable gap",
            ));
        }
        Ok(None)
    }

    pub(crate) fn reader(&self) -> SparseReader<'_> {
        SparseReader {
            indexed: self,
            position: 0,
            chunk_bytes: RANGE_CHUNK_BYTES,
        }
    }

    fn materialize_indexed_prefix(&self, max_bytes: u64) -> Result<Vec<u8>> {
        let end = self.ranges.iter().try_fold(0_u64, |end, (offset, bytes)| {
            let length = u64::try_from(bytes.len()).map_err(|_| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "Excel indexed range length exceeds u64",
                )
            })?;
            offset.checked_add(length).map_or_else(
                || {
                    Err(TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "Excel indexed range end overflows",
                    ))
                },
                |candidate| Ok(end.max(candidate)),
            )
        })?;
        if end > max_bytes {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "indexed XLS working set exceeds the configured compact-source limit",
            )
            .with_detail("requiredBytes", end)
            .with_detail("availableBytes", max_bytes));
        }
        let mut output = vec![
            0;
            usize::try_from(end).map_err(|_| {
                TabularkError::new(ErrorCode::ResourceLimit, "indexed XLS prefix exceeds usize")
            })?
        ];
        for (offset, bytes) in &self.ranges {
            let offset = usize::try_from(*offset).map_err(|_| {
                TabularkError::new(ErrorCode::ResourceLimit, "indexed XLS offset exceeds usize")
            })?;
            let end = offset.checked_add(bytes.len()).ok_or_else(|| {
                TabularkError::new(ErrorCode::ResourceLimit, "indexed XLS copy end overflows")
            })?;
            output[offset..end].copy_from_slice(bytes);
        }
        Ok(output)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct MissingRange(pub(crate) HostRange);

impl Display for MissingRange {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "source range [{}, {}) is not indexed",
            self.0.offset,
            self.0.end()
        )
    }
}

impl std::error::Error for MissingRange {}

pub(crate) struct SparseReader<'a> {
    indexed: &'a IndexedRanges,
    position: u64,
    chunk_bytes: u64,
}

impl Read for SparseReader<'_> {
    fn read(&mut self, target: &mut [u8]) -> io::Result<usize> {
        if target.is_empty() || self.position == self.indexed.source_length {
            return Ok(0);
        }
        if self.position > self.indexed.source_length {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "sparse Excel reader is past EOF",
            ));
        }
        if let Some((&start, bytes)) = self.indexed.ranges.range(..=self.position).next_back() {
            let relative = usize::try_from(self.position - start).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "range index exceeds usize")
            })?;
            if relative < bytes.len() {
                let remaining_source = usize::try_from(self.indexed.source_length - self.position)
                    .unwrap_or(usize::MAX);
                let count = target
                    .len()
                    .min(bytes.len() - relative)
                    .min(remaining_source);
                target[..count].copy_from_slice(&bytes[relative..relative + count]);
                self.position = self
                    .position
                    .checked_add(u64::try_from(count).unwrap_or(u64::MAX))
                    .ok_or_else(|| io::Error::other("sparse reader position overflows"))?;
                return Ok(count);
            }
        }
        // Expand a small parser read into one bounded source window.  CFB's
        // header/FAT readers often ask for only a handful of bytes; returning
        // that exact size would turn one sector walk into thousands of host
        // round trips without reducing retained memory meaningfully.
        let requested = self
            .chunk_bytes
            .min(self.indexed.source_length - self.position);
        let range = HostRange::new(self.position, requested, self.indexed.source_length)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
        Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            MissingRange(range),
        ))
    }
}

impl Seek for SparseReader<'_> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let next = match position {
            SeekFrom::Start(value) => value,
            SeekFrom::End(delta) => checked_signed_offset(self.indexed.source_length, delta)?,
            SeekFrom::Current(delta) => checked_signed_offset(self.position, delta)?,
        };
        if next > self.indexed.source_length {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "sparse Excel seek lies outside the source",
            ));
        }
        self.position = next;
        Ok(next)
    }
}

fn checked_signed_offset(base: u64, delta: i64) -> io::Result<u64> {
    if delta >= 0 {
        base.checked_add(delta as u64)
    } else {
        base.checked_sub(delta.unsigned_abs())
    }
    .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Excel seek offset overflows"))
}

pub(crate) fn missing_range(error: &(dyn std::error::Error + 'static)) -> Option<HostRange> {
    let mut current = Some(error);
    while let Some(candidate) = current {
        if let Some(missing) = candidate.downcast_ref::<MissingRange>() {
            return Some(missing.0.clone());
        }
        if let Some(io_error) = candidate.downcast_ref::<io::Error>()
            && let Some(inner) = io_error.get_ref()
            && let Some(missing) = inner.downcast_ref::<MissingRange>()
        {
            return Some(missing.0.clone());
        }
        current = candidate.source();
    }
    None
}

#[derive(Clone, Debug)]
pub(crate) struct ZipEntryIndex {
    pub(crate) name: String,
    flags: u16,
    method: u16,
    crc32: u32,
    compressed_size: u64,
    uncompressed_size: u64,
    local_header_offset: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct ZipDirectoryIndex {
    entries: HashMap<String, ZipEntryIndex>,
}

impl ZipDirectoryIndex {
    pub(crate) fn entry(&self, name: &str) -> Option<&ZipEntryIndex> {
        self.entries.get(name)
    }

    pub(crate) fn workbook_path(&self) -> Option<&str> {
        if self.entries.contains_key("xl/workbook.xml") {
            return Some("xl/workbook.xml");
        }
        self.entries
            .keys()
            .find(|name| name.eq_ignore_ascii_case("xl/workbook.xml"))
            .map(String::as_str)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct CentralDirectoryLocation {
    pub(crate) range: HostRange,
    pub(crate) entries: usize,
}

pub(crate) fn tail_range(source_length: u64) -> Result<HostRange> {
    let length = source_length.min(RANGE_TAIL_BYTES);
    if length < 22 {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "XLSX source is too short to contain an end-of-central-directory record",
        ));
    }
    HostRange::new(source_length - length, length, source_length)
}

pub(crate) fn parse_end_of_central_directory(
    tail: &[u8],
    tail_offset: u64,
    source_length: u64,
) -> Result<CentralDirectoryLocation> {
    if tail.len() < 22 {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "XLSX tail is truncated",
        ));
    }
    for index in (0..=tail.len() - 22).rev() {
        if read_u32(tail, index)? != 0x0605_4b50 {
            continue;
        }
        let comment_length = usize::from(read_u16(tail, index + 20)?);
        if index
            .checked_add(22)
            .and_then(|value| value.checked_add(comment_length))
            != Some(tail.len())
        {
            continue;
        }
        if read_u16(tail, index + 4)? != 0 || read_u16(tail, index + 6)? != 0 {
            return Err(TabularkError::new(
                ErrorCode::UnsupportedFeature,
                "multi-disk XLSX ZIP archives are unsupported",
            ));
        }
        let entries = read_u16(tail, index + 10)?;
        let size = read_u32(tail, index + 12)?;
        let offset = read_u32(tail, index + 16)?;
        if entries == u16::MAX || size == u32::MAX || offset == u32::MAX {
            return parse_zip64_end(tail, tail_offset, index, source_length);
        }
        return central_location(
            u64::from(offset),
            u64::from(size),
            usize::from(entries),
            source_length,
        );
    }
    Err(TabularkError::new(
        ErrorCode::ParseFailed,
        "XLSX end-of-central-directory record was not found",
    ))
}

fn parse_zip64_end(
    tail: &[u8],
    tail_offset: u64,
    eocd_index: usize,
    source_length: u64,
) -> Result<CentralDirectoryLocation> {
    let locator = eocd_index.checked_sub(20).ok_or_else(|| {
        TabularkError::new(ErrorCode::ParseFailed, "XLSX ZIP64 locator is missing")
    })?;
    if read_u32(tail, locator)? != 0x0706_4b50 {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "XLSX ZIP64 locator is missing",
        ));
    }
    if read_u32(tail, locator + 4)? != 0 || read_u32(tail, locator + 16)? != 1 {
        return Err(TabularkError::new(
            ErrorCode::UnsupportedFeature,
            "multi-disk XLSX ZIP64 archives are unsupported",
        ));
    }
    let record_offset = read_u64(tail, locator + 8)?;
    let relative = record_offset.checked_sub(tail_offset).ok_or_else(|| {
        TabularkError::new(
            ErrorCode::ParseFailed,
            "XLSX ZIP64 record is outside the indexed tail",
        )
    })?;
    let relative = usize::try_from(relative).map_err(|_| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "XLSX ZIP64 record offset exceeds usize",
        )
    })?;
    if relative.checked_add(56).is_none_or(|end| end > tail.len())
        || read_u32(tail, relative)? != 0x0606_4b50
    {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "XLSX ZIP64 record is invalid or truncated",
        ));
    }
    let record_size = read_u64(tail, relative + 4)?;
    if record_size < 44 {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "XLSX ZIP64 record is truncated",
        ));
    }
    let record_end = u64::try_from(relative)
        .ok()
        .and_then(|value| value.checked_add(12))
        .and_then(|value| value.checked_add(record_size))
        .and_then(|value| usize::try_from(value).ok());
    if record_end.is_none_or(|end| end > tail.len()) {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "XLSX ZIP64 record extends outside the indexed tail",
        ));
    }
    if read_u32(tail, relative + 16)? != 0 || read_u32(tail, relative + 20)? != 0 {
        return Err(TabularkError::new(
            ErrorCode::UnsupportedFeature,
            "multi-disk XLSX ZIP64 archives are unsupported",
        ));
    }
    let entries_on_disk = read_u64(tail, relative + 24)?;
    let entries = read_u64(tail, relative + 32)?;
    if entries != entries_on_disk {
        return Err(TabularkError::new(
            ErrorCode::UnsupportedFeature,
            "split XLSX ZIP64 central directories are unsupported",
        ));
    }
    let entries = usize::try_from(entries).map_err(|_| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "XLSX ZIP entry count exceeds usize",
        )
    })?;
    central_location(
        read_u64(tail, relative + 48)?,
        read_u64(tail, relative + 40)?,
        entries,
        source_length,
    )
}

fn central_location(
    offset: u64,
    size: u64,
    entries: usize,
    source_length: u64,
) -> Result<CentralDirectoryLocation> {
    if entries == 0 || entries > MAX_ZIP_ENTRIES {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "XLSX ZIP entry count exceeds the configured limit",
        )
        .with_detail("required", entries)
        .with_detail("available", MAX_ZIP_ENTRIES));
    }
    if size == 0 || size > MAX_CENTRAL_DIRECTORY_BYTES {
        return Err(TabularkError::new(
            ErrorCode::ResourceLimit,
            "XLSX central directory exceeds the configured limit",
        )
        .with_detail("requiredBytes", size)
        .with_detail("availableBytes", MAX_CENTRAL_DIRECTORY_BYTES));
    }
    Ok(CentralDirectoryLocation {
        range: HostRange::new(offset, size, source_length)?,
        entries,
    })
}

pub(crate) fn parse_central_directory(
    bytes: &[u8],
    expected_entries: usize,
    source_length: u64,
) -> Result<ZipDirectoryIndex> {
    let mut offset = 0usize;
    let mut entries = HashMap::new();
    while offset < bytes.len() {
        if bytes.len() - offset < 46 || read_u32(bytes, offset)? != 0x0201_4b50 {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "XLSX central directory contains an invalid entry",
            ));
        }
        let flags = read_u16(bytes, offset + 8)?;
        let method = read_u16(bytes, offset + 10)?;
        let crc32 = read_u32(bytes, offset + 16)?;
        let mut compressed_size = u64::from(read_u32(bytes, offset + 20)?);
        let mut uncompressed_size = u64::from(read_u32(bytes, offset + 24)?);
        let name_length = usize::from(read_u16(bytes, offset + 28)?);
        let extra_length = usize::from(read_u16(bytes, offset + 30)?);
        let comment_length = usize::from(read_u16(bytes, offset + 32)?);
        let mut local_header_offset = u64::from(read_u32(bytes, offset + 42)?);
        let name_start = offset.checked_add(46).ok_or_else(zip_overflow)?;
        let name_end = name_start
            .checked_add(name_length)
            .ok_or_else(zip_overflow)?;
        let extra_end = name_end
            .checked_add(extra_length)
            .ok_or_else(zip_overflow)?;
        let end = extra_end
            .checked_add(comment_length)
            .ok_or_else(zip_overflow)?;
        if end > bytes.len() {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "XLSX central directory entry is truncated",
            ));
        }
        let name = std::str::from_utf8(&bytes[name_start..name_end])
            .map_err(|_| {
                TabularkError::new(
                    ErrorCode::UnsupportedFeature,
                    "XLSX ZIP entry names must be UTF-8",
                )
            })?
            .to_owned();
        validate_zip_path(&name)?;
        if flags & 0x0001 != 0 {
            return Err(TabularkError::new(
                ErrorCode::UnsupportedFeature,
                "encrypted XLSX ZIP entries are unsupported",
            )
            .with_detail("entry", name));
        }
        if method != 0 && method != 8 {
            return Err(TabularkError::new(
                ErrorCode::UnsupportedFeature,
                "XLSX ZIP compression method is unsupported",
            )
            .with_detail("entry", name)
            .with_detail("method", method));
        }
        let need_compressed = compressed_size == u64::from(u32::MAX);
        let need_uncompressed = uncompressed_size == u64::from(u32::MAX);
        let need_offset = local_header_offset == u64::from(u32::MAX);
        if need_compressed || need_uncompressed || need_offset {
            let values = parse_zip64_extra(
                &bytes[name_end..extra_end],
                need_compressed,
                need_uncompressed,
                need_offset,
            )?;
            if need_uncompressed {
                uncompressed_size = values.0;
            }
            if need_compressed {
                compressed_size = values.1;
            }
            if need_offset {
                local_header_offset = values.2;
            }
        }
        if compressed_size > MAX_COMPRESSED_ENTRY_BYTES
            || uncompressed_size > MAX_EXPANDED_ENTRY_BYTES
        {
            return Err(TabularkError::new(
                ErrorCode::ResourceLimit,
                "XLSX ZIP entry exceeds the configured bound",
            )
            .with_detail("entry", name)
            .with_detail("compressedBytes", compressed_size)
            .with_detail("expandedBytes", uncompressed_size));
        }
        HostRange::new(local_header_offset, 30, source_length)?;
        let entry = ZipEntryIndex {
            name: name.clone(),
            flags,
            method,
            crc32,
            compressed_size,
            uncompressed_size,
            local_header_offset,
        };
        if entries.insert(name.clone(), entry).is_some() {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "XLSX ZIP contains a duplicate entry",
            )
            .with_detail("entry", name));
        }
        offset = end;
    }
    if entries.len() != expected_entries {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "XLSX central directory count does not match its end record",
        )
        .with_detail("expectedEntries", expected_entries)
        .with_detail("actualEntries", entries.len()));
    }
    Ok(ZipDirectoryIndex { entries })
}

fn parse_zip64_extra(
    bytes: &[u8],
    need_compressed: bool,
    need_uncompressed: bool,
    need_offset: bool,
) -> Result<(u64, u64, u64)> {
    let mut offset = 0usize;
    while offset.checked_add(4).is_some_and(|end| end <= bytes.len()) {
        let id = read_u16(bytes, offset)?;
        let size = usize::from(read_u16(bytes, offset + 2)?);
        offset += 4;
        let end = offset.checked_add(size).ok_or_else(zip_overflow)?;
        if end > bytes.len() {
            break;
        }
        if id != 1 {
            offset = end;
            continue;
        }
        let mut cursor = offset;
        let mut next = || -> Result<u64> {
            let value = read_u64(bytes, cursor)?;
            cursor = cursor.checked_add(8).ok_or_else(zip_overflow)?;
            if cursor > end {
                return Err(TabularkError::new(
                    ErrorCode::ParseFailed,
                    "XLSX ZIP64 extra field is truncated",
                ));
            }
            Ok(value)
        };
        let uncompressed = if need_uncompressed { next()? } else { 0 };
        let compressed = if need_compressed { next()? } else { 0 };
        let local_offset = if need_offset { next()? } else { 0 };
        return Ok((uncompressed, compressed, local_offset));
    }
    Err(TabularkError::new(
        ErrorCode::ParseFailed,
        "XLSX ZIP64 entry metadata is missing",
    ))
}

#[derive(Clone, Debug)]
pub(crate) struct RawZipEntry {
    index: ZipEntryIndex,
    compressed: Vec<u8>,
}

impl RawZipEntry {
    pub(crate) fn name(&self) -> &str {
        &self.index.name
    }

    pub(crate) fn header_range(index: &ZipEntryIndex, source_length: u64) -> Result<HostRange> {
        HostRange::new(index.local_header_offset, 30, source_length)
    }

    pub(crate) fn data_range(
        index: &ZipEntryIndex,
        local_header: &[u8],
        source_length: u64,
    ) -> Result<HostRange> {
        if local_header.len() != 30 || read_u32(local_header, 0)? != 0x0403_4b50 {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "XLSX local file header is invalid",
            )
            .with_detail("entry", index.name.clone()));
        }
        let flags = read_u16(local_header, 6)?;
        let method = read_u16(local_header, 8)?;
        if flags & 1 != 0 || method != index.method {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "XLSX local header does not match its central entry",
            )
            .with_detail("entry", index.name.clone()));
        }
        let name_length = u64::from(read_u16(local_header, 26)?);
        let extra_length = u64::from(read_u16(local_header, 28)?);
        let data_offset = index
            .local_header_offset
            .checked_add(30)
            .and_then(|value| value.checked_add(name_length))
            .and_then(|value| value.checked_add(extra_length))
            .ok_or_else(zip_overflow)?;
        HostRange::new(data_offset, index.compressed_size, source_length)
    }

    pub(crate) fn new(index: ZipEntryIndex, compressed: Vec<u8>) -> Result<Self> {
        let actual = u64::try_from(compressed.len()).map_err(|_| {
            TabularkError::new(ErrorCode::ResourceLimit, "XLSX entry length exceeds u64")
        })?;
        if actual != index.compressed_size {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "XLSX compressed entry length does not match its directory entry",
            ));
        }
        Ok(Self { index, compressed })
    }

    pub(crate) fn decode(&self) -> Result<Vec<u8>> {
        let archive = build_raw_zip(std::slice::from_ref(self), &[])?;
        let mut archive = ZipArchive::new(Cursor::new(archive)).map_err(zip_read_error)?;
        let mut entry = archive.by_index(0).map_err(zip_read_error)?;
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|error| {
            TabularkError::new(ErrorCode::ParseFailed, "failed to inflate XLSX ZIP entry")
                .with_detail("entry", self.index.name.clone())
                .with_detail("reason", error.to_string())
        })?;
        let actual = u64::try_from(bytes.len()).map_err(|_| {
            TabularkError::new(ErrorCode::ResourceLimit, "expanded XLSX entry exceeds u64")
        })?;
        if actual != self.index.uncompressed_size {
            return Err(TabularkError::new(
                ErrorCode::ParseFailed,
                "expanded XLSX entry length is invalid",
            )
            .with_detail("entry", self.index.name.clone()));
        }
        Ok(bytes)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct RangeSheetDescriptor {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) visibility: ExcelSheetVisibility,
    pub(crate) path: String,
}

pub(crate) fn parse_workbook_descriptors(
    workbook: &[u8],
    relationships: &[u8],
    relationship_path: &str,
) -> Result<Vec<RangeSheetDescriptor>> {
    #[derive(Debug)]
    struct SheetRef {
        name: String,
        relationship: String,
        visibility: ExcelSheetVisibility,
    }
    let mut sheets = Vec::new();
    let mut reader = XmlReader::from_reader(workbook);
    let workbook_decoder = reader.decoder();
    loop {
        match reader.read_event() {
            Ok(XmlEvent::Start(element)) | Ok(XmlEvent::Empty(element))
                if element.local_name().as_ref() == b"sheet" =>
            {
                if sheets.len() >= 1_024 {
                    return Err(TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "XLSX workbook exceeds the worksheet limit",
                    ));
                }
                let mut name = None;
                let mut relationship = None;
                let mut visibility = ExcelSheetVisibility::Visible;
                for attribute in element.attributes().with_checks(false) {
                    let attribute = attribute.map_err(xml_attribute_error)?;
                    let key = attribute.key.local_name();
                    let value = attribute
                        .decode_and_unescape_value(workbook_decoder)
                        .map_err(xml_decode_error)?
                        .into_owned();
                    match key.as_ref() {
                        b"name" => name = Some(value),
                        b"id" => relationship = Some(value),
                        b"state" if value == "hidden" => {
                            visibility = ExcelSheetVisibility::Hidden;
                        }
                        b"state" if value == "veryHidden" || value == "very-hidden" => {
                            visibility = ExcelSheetVisibility::VeryHidden;
                        }
                        _ => {}
                    }
                }
                sheets.push(SheetRef {
                    name: name.unwrap_or_else(|| format!("Sheet {}", sheets.len() + 1)),
                    relationship: relationship.ok_or_else(|| {
                        TabularkError::new(
                            ErrorCode::ParseFailed,
                            "XLSX worksheet is missing its relationship ID",
                        )
                    })?,
                    visibility,
                });
            }
            Ok(XmlEvent::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(xml_decode_error(error)),
        }
    }
    if sheets.is_empty() {
        return Err(TabularkError::new(
            ErrorCode::UnsupportedFeature,
            "XLSX workbook contains no worksheets",
        ));
    }

    let base = relationship_path
        .split_once("/_rels/")
        .map_or("", |(base, _)| base);
    let mut targets = HashMap::new();
    let mut reader = XmlReader::from_reader(relationships);
    let relationship_decoder = reader.decoder();
    loop {
        match reader.read_event() {
            Ok(XmlEvent::Start(element)) | Ok(XmlEvent::Empty(element))
                if element.local_name().as_ref() == b"Relationship" =>
            {
                let mut id = None;
                let mut target = None;
                let mut kind = None;
                let mut external = false;
                for attribute in element.attributes().with_checks(false) {
                    let attribute = attribute.map_err(xml_attribute_error)?;
                    let value = attribute
                        .decode_and_unescape_value(relationship_decoder)
                        .map_err(xml_decode_error)?
                        .into_owned();
                    match attribute.key.local_name().as_ref() {
                        b"Id" => id = Some(value),
                        b"Target" => target = Some(value),
                        b"Type" => kind = Some(value),
                        b"TargetMode" if value.eq_ignore_ascii_case("external") => external = true,
                        _ => {}
                    }
                }
                if !external
                    && kind
                        .as_deref()
                        .is_some_and(|value| value.ends_with("/worksheet"))
                    && let (Some(id), Some(target)) = (id, target)
                {
                    targets.insert(id, resolve_zip_target(base, &target)?);
                }
            }
            Ok(XmlEvent::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(xml_decode_error(error)),
        }
    }
    sheets
        .into_iter()
        .enumerate()
        .map(|(index, sheet)| {
            let path = targets.get(&sheet.relationship).cloned().ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ParseFailed,
                    "XLSX worksheet relationship target is missing",
                )
                .with_detail("relationshipId", sheet.relationship)
            })?;
            Ok(RangeSheetDescriptor {
                id: format!("sheet-{index}"),
                name: sheet.name,
                visibility: sheet.visibility,
                path,
            })
        })
        .collect()
}

pub(crate) fn workbook_relationships_path(workbook_path: &str) -> String {
    match workbook_path.rsplit_once('/') {
        Some((directory, file)) => format!("{directory}/_rels/{file}.rels"),
        None => format!("_rels/{workbook_path}.rels"),
    }
}

fn resolve_zip_target(base: &str, target: &str) -> Result<String> {
    if target.starts_with('/') || target.contains(':') || target.contains('\\') {
        return Err(TabularkError::new(
            ErrorCode::UnsupportedFeature,
            "external or absolute XLSX relationships are unsupported",
        ));
    }
    let mut parts = Vec::new();
    let joined = if base.is_empty() {
        target.to_owned()
    } else {
        format!("{base}/{target}")
    };
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(TabularkError::new(
                        ErrorCode::ParseFailed,
                        "XLSX relationship escapes the package root",
                    ));
                }
            }
            _ => parts.push(part),
        }
    }
    let path = parts.join("/");
    validate_zip_path(&path)?;
    Ok(path)
}

pub(crate) fn build_compact_xlsx(
    entries: &[RawZipEntry],
    sheets: &[RangeSheetDescriptor],
    selected_path: &str,
) -> Result<Vec<u8>> {
    const EMPTY_WORKSHEET: &[u8] = br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>"#;
    let placeholders = sheets
        .iter()
        .filter(|sheet| sheet.path != selected_path)
        .map(|sheet| (sheet.path.as_str(), EMPTY_WORKSHEET))
        .collect::<Vec<_>>();
    build_raw_zip(entries, &placeholders)
}

fn build_raw_zip(entries: &[RawZipEntry], placeholders: &[(&str, &[u8])]) -> Result<Vec<u8>> {
    #[derive(Clone)]
    struct Central {
        name: Vec<u8>,
        flags: u16,
        method: u16,
        crc32: u32,
        compressed_size: u32,
        uncompressed_size: u32,
        local_offset: u32,
    }
    let mut output = Vec::new();
    let mut central = Vec::new();
    let mut append = |name: &str,
                      flags: u16,
                      method: u16,
                      crc32: u32,
                      compressed: &[u8],
                      uncompressed_size: u64|
     -> Result<()> {
        let name = name.as_bytes().to_vec();
        let name_length = u16::try_from(name.len()).map_err(|_| {
            TabularkError::new(ErrorCode::ResourceLimit, "XLSX ZIP entry name is too long")
        })?;
        let compressed_size = u32::try_from(compressed.len()).map_err(|_| {
            TabularkError::new(ErrorCode::ResourceLimit, "compact XLSX entry exceeds ZIP32")
        })?;
        let uncompressed_size = u32::try_from(uncompressed_size).map_err(|_| {
            TabularkError::new(ErrorCode::ResourceLimit, "compact XLSX entry exceeds ZIP32")
        })?;
        let local_offset = u32::try_from(output.len()).map_err(|_| {
            TabularkError::new(ErrorCode::ResourceLimit, "compact XLSX exceeds ZIP32")
        })?;
        push_u32(&mut output, 0x0403_4b50);
        push_u16(&mut output, 20);
        push_u16(&mut output, flags & !0x0008);
        push_u16(&mut output, method);
        push_u16(&mut output, 0);
        push_u16(&mut output, 0);
        push_u32(&mut output, crc32);
        push_u32(&mut output, compressed_size);
        push_u32(&mut output, uncompressed_size);
        push_u16(&mut output, name_length);
        push_u16(&mut output, 0);
        output.extend_from_slice(&name);
        output.extend_from_slice(compressed);
        central.push(Central {
            name,
            flags: flags & !0x0008,
            method,
            crc32,
            compressed_size,
            uncompressed_size,
            local_offset,
        });
        Ok(())
    };
    for entry in entries {
        append(
            &entry.index.name,
            entry.index.flags,
            entry.index.method,
            entry.index.crc32,
            &entry.compressed,
            entry.index.uncompressed_size,
        )?;
    }
    for (name, bytes) in placeholders {
        append(name, 0x0800, 0, crc32(bytes), bytes, bytes.len() as u64)?;
    }
    let central_offset = u32::try_from(output.len())
        .map_err(|_| TabularkError::new(ErrorCode::ResourceLimit, "compact XLSX exceeds ZIP32"))?;
    for entry in &central {
        push_u32(&mut output, 0x0201_4b50);
        push_u16(&mut output, 20);
        push_u16(&mut output, 20);
        push_u16(&mut output, entry.flags);
        push_u16(&mut output, entry.method);
        push_u16(&mut output, 0);
        push_u16(&mut output, 0);
        push_u32(&mut output, entry.crc32);
        push_u32(&mut output, entry.compressed_size);
        push_u32(&mut output, entry.uncompressed_size);
        push_u16(
            &mut output,
            u16::try_from(entry.name.len()).map_err(|_| zip_overflow())?,
        );
        push_u16(&mut output, 0);
        push_u16(&mut output, 0);
        push_u16(&mut output, 0);
        push_u16(&mut output, 0);
        push_u32(&mut output, 0);
        push_u32(&mut output, entry.local_offset);
        output.extend_from_slice(&entry.name);
    }
    let central_size = u32::try_from(output.len())
        .ok()
        .and_then(|end| end.checked_sub(central_offset))
        .ok_or_else(zip_overflow)?;
    let count = u16::try_from(central.len()).map_err(|_| {
        TabularkError::new(
            ErrorCode::ResourceLimit,
            "compact XLSX has too many entries",
        )
    })?;
    push_u32(&mut output, 0x0605_4b50);
    push_u16(&mut output, 0);
    push_u16(&mut output, 0);
    push_u16(&mut output, count);
    push_u16(&mut output, count);
    push_u32(&mut output, central_size);
    push_u32(&mut output, central_offset);
    push_u16(&mut output, 0);
    Ok(output)
}

pub(crate) fn compact_xls(
    indexed: &IndexedRanges,
) -> std::result::Result<Vec<u8>, CompactXlsError> {
    let reader = indexed.reader();
    let mut compound = cfb::CompoundFile::open(reader).map_err(CompactXlsError::from_io)?;
    let path = compound
        .walk()
        .find(|entry| {
            entry.is_stream()
                && (entry.name().eq_ignore_ascii_case("Workbook")
                    || entry.name().eq_ignore_ascii_case("Book"))
        })
        .map(|entry| entry.path().to_owned())
        .ok_or_else(|| {
            CompactXlsError::Fatal(TabularkError::new(
                ErrorCode::ParseFailed,
                "Excel CFB source does not contain a Workbook stream",
            ))
        })?;
    let mut stream = compound
        .open_stream(path)
        .map_err(CompactXlsError::from_io)?;
    let mut workbook = Vec::new();
    stream
        .read_to_end(&mut workbook)
        .map_err(CompactXlsError::from_io)?;
    drop(stream);
    drop(compound);
    // Once every referenced FAT/miniFAT/Workbook sector has been proven
    // readable, materialize only the indexed low prefix.  Appended sparse
    // capacity (including a sparse final window near the address limit) is not
    // part of the CFB
    // sector graph and therefore never enters WebAssembly memory.  Avoiding a
    // newly-created CFB also keeps this path deterministic on wasm32, where
    // `SystemTime::now` is unavailable to the cfb writer.
    indexed
        .materialize_indexed_prefix(128 * 1024 * 1024)
        .map_err(CompactXlsError::Fatal)
}

#[derive(Debug)]
pub(crate) enum CompactXlsError {
    Missing(HostRange),
    Fatal(TabularkError),
}

impl CompactXlsError {
    fn from_io(error: io::Error) -> Self {
        if let Some(range) = missing_range(&error) {
            Self::Missing(range)
        } else {
            Self::Fatal(
                TabularkError::new(ErrorCode::ParseFailed, "failed to index Excel CFB source")
                    .with_detail("reason", error.to_string()),
            )
        }
    }
}

fn validate_zip_path(name: &str) -> Result<()> {
    if name.is_empty()
        || name.starts_with('/')
        || name.contains('\\')
        || name.split('/').any(|part| part == "..")
    {
        return Err(TabularkError::new(
            ErrorCode::ParseFailed,
            "XLSX ZIP entry has an unsafe path",
        )
        .with_detail("entry", name));
    }
    Ok(())
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16> {
    let bytes = bytes.get(offset..offset + 2).ok_or_else(zip_truncated)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let bytes = bytes.get(offset..offset + 4).ok_or_else(zip_truncated)?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64> {
    let bytes = bytes.get(offset..offset + 8).ok_or_else(zip_truncated)?;
    Ok(u64::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ]))
}

fn push_u16(target: &mut Vec<u8>, value: u16) {
    target.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(target: &mut Vec<u8>, value: u32) {
    target.extend_from_slice(&value.to_le_bytes());
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut value = u32::MAX;
    for byte in bytes {
        value ^= u32::from(*byte);
        for _ in 0..8 {
            value = if value & 1 == 0 {
                value >> 1
            } else {
                (value >> 1) ^ 0xedb8_8320
            };
        }
    }
    !value
}

fn zip_truncated() -> TabularkError {
    TabularkError::new(ErrorCode::ParseFailed, "XLSX ZIP structure is truncated")
}

fn zip_overflow() -> TabularkError {
    TabularkError::new(
        ErrorCode::ResourceLimit,
        "XLSX ZIP offset arithmetic overflows",
    )
}

fn zip_read_error(error: zip::result::ZipError) -> TabularkError {
    TabularkError::new(
        ErrorCode::ParseFailed,
        "failed to read compact XLSX ZIP entry",
    )
    .with_detail("reason", error.to_string())
}

fn xml_attribute_error(error: quick_xml::events::attributes::AttrError) -> TabularkError {
    TabularkError::new(ErrorCode::ParseFailed, "invalid XLSX XML attribute")
        .with_detail("reason", error.to_string())
}

fn xml_decode_error(error: impl Display) -> TabularkError {
    TabularkError::new(ErrorCode::ParseFailed, "invalid XLSX workbook XML")
        .with_detail("reason", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ExcelOptions, ExcelRuntime};
    use tabulark::model::RangeRequest;

    const XLSX: &[u8] = include_bytes!("../../../test/fixtures/excel/v1/tabulark-ooxml.xlsx");
    const XLS: &[u8] = include_bytes!("../../../test/fixtures/excel/v1/tabulark-biff8.xls");

    fn raw_entry(source: &[u8], index: &ZipEntryIndex) -> RawZipEntry {
        let header_range = RawZipEntry::header_range(index, source.len() as u64).unwrap();
        let header = &source[header_range.offset as usize..header_range.end() as usize];
        let data_range = RawZipEntry::data_range(index, header, source.len() as u64).unwrap();
        RawZipEntry::new(
            index.clone(),
            source[data_range.offset as usize..data_range.end() as usize].to_vec(),
        )
        .unwrap()
    }

    #[test]
    fn zip64_tail_and_central_ranges_use_checked_u64() {
        let source_length = 1_u64 << 31;
        assert_eq!(tail_range(source_length).unwrap().end(), source_length);
        assert!(HostRange::new(source_length, 1, source_length).is_err());
        assert!(HostRange::new(u64::MAX, 2, u64::MAX).is_err());
        assert!(HostRange::new((1_u64 << 31) + 1, 1, (1_u64 << 31) + 2).is_ok());
    }

    #[test]
    fn sparse_ranges_support_the_exact_four_gib_minus_one_source_extent() {
        let source_length = u32::MAX as u64;
        let mut indexed = IndexedRanges::new(source_length);
        let high = HostRange::new(source_length - 16, 16, source_length).unwrap();
        indexed.insert(&high, vec![0x5a; 16]).unwrap();
        assert_eq!(indexed.bytes(&high), Some(&[0x5a; 16][..]));

        let query = HostRange::new(source_length - 32, 32, source_length).unwrap();
        assert_eq!(
            indexed.first_missing(&query).unwrap(),
            Some(HostRange::new(source_length - 32, 16, source_length).unwrap())
        );
        assert_eq!(tail_range(source_length).unwrap().end(), source_length);
    }

    #[test]
    fn missing_range_excludes_an_indexed_zip_signature_prefix() {
        let source_length = 1_u64 << 31;
        let mut indexed = IndexedRanges::new(source_length);
        let signature = HostRange::new(0, 8, source_length).unwrap();
        indexed
            .insert(&signature, b"PK\x03\x04test".to_vec())
            .unwrap();

        let local_header = HostRange::new(0, 30, source_length).unwrap();
        let missing = indexed.first_missing(&local_header).unwrap().unwrap();
        assert_eq!(missing, HostRange::new(8, 22, source_length).unwrap());
        indexed.insert(&missing, vec![0; 22]).unwrap();

        assert_eq!(indexed.bytes(&local_header).unwrap().len(), 30);
        assert_eq!(indexed.first_missing(&local_header).unwrap(), None);
        assert_eq!(indexed.retained_bytes(), 30);
    }

    #[test]
    fn missing_range_stops_before_an_indexed_zip_tail() {
        let source_length = 1_u64 << 31;
        let mut indexed = IndexedRanges::new(source_length);
        let tail = tail_range(source_length).unwrap();
        indexed
            .insert(&tail, vec![0; usize::try_from(tail.length).unwrap()])
            .unwrap();

        let central = HostRange::new(tail.offset - 64, 128, source_length).unwrap();
        assert_eq!(
            indexed.first_missing(&central).unwrap(),
            Some(HostRange::new(tail.offset - 64, 64, source_length).unwrap())
        );
    }

    #[test]
    fn compact_xlsx_contains_only_selected_real_worksheet() {
        let tail = tail_range(XLSX.len() as u64).unwrap();
        let location = parse_end_of_central_directory(
            &XLSX[tail.offset as usize..tail.end() as usize],
            tail.offset,
            XLSX.len() as u64,
        )
        .unwrap();
        let index = parse_central_directory(
            &XLSX[location.range.offset as usize..location.range.end() as usize],
            location.entries,
            XLSX.len() as u64,
        )
        .unwrap();
        let workbook_path = index.workbook_path().unwrap();
        let relationships_path = workbook_relationships_path(workbook_path);
        let workbook = raw_entry(XLSX, index.entry(workbook_path).unwrap());
        let relationships = raw_entry(XLSX, index.entry(&relationships_path).unwrap());
        let descriptors = parse_workbook_descriptors(
            &workbook.decode().unwrap(),
            &relationships.decode().unwrap(),
            &relationships_path,
        )
        .unwrap();
        let target = &descriptors[0];
        let mut paths = vec![
            "[Content_Types].xml".to_owned(),
            workbook_path.to_owned(),
            relationships_path,
            target.path.clone(),
        ];
        for optional in ["xl/styles.xml", "xl/sharedStrings.xml"] {
            if index.entry(optional).is_some() {
                paths.push(optional.to_owned());
            }
        }
        let entries = paths
            .iter()
            .map(|path| raw_entry(XLSX, index.entry(path).unwrap()))
            .collect::<Vec<_>>();
        let compact = build_compact_xlsx(&entries, &descriptors, &target.path).unwrap();
        assert!(compact.len() < XLSX.len());
        let mut runtime = ExcelRuntime::default();
        let source = runtime
            .open_source(compact, ExcelOptions::default())
            .unwrap();
        let table = runtime.open_table(source, &target.id).unwrap();
        let batch = runtime
            .read_range(table.table_handle, RangeRequest::new(0, 1, 0, 1).unwrap())
            .unwrap();
        assert_eq!(batch.range().row_count(), 1);
    }

    #[test]
    fn cfb_sparse_reader_requests_only_referenced_ranges() {
        let padded_length = (1_u64 << 31) + 1;
        let mut indexed = IndexedRanges::new(padded_length);
        for _ in 0..256 {
            match compact_xls(&indexed) {
                Ok(compact) => {
                    assert!(indexed.retained_bytes() < XLS.len() as u64 + RANGE_CHUNK_BYTES);
                    let mut runtime = ExcelRuntime::default();
                    let source = runtime
                        .open_source(compact, ExcelOptions::default())
                        .unwrap();
                    assert!(!runtime.list_tables(source).unwrap().is_empty());
                    return;
                }
                Err(CompactXlsError::Missing(range)) => {
                    let start = usize::try_from(range.offset).unwrap();
                    let available = XLS.len().saturating_sub(start);
                    let length = usize::try_from(range.length).unwrap();
                    let mut bytes = vec![0; length];
                    let copy = available.min(length);
                    bytes[..copy].copy_from_slice(&XLS[start..start + copy]);
                    indexed.insert(&range, bytes).unwrap();
                }
                Err(CompactXlsError::Fatal(error)) => panic!("{error}"),
            }
        }
        panic!("CFB indexing did not converge");
    }
}
