//! A deliberately narrow compatibility layer for the subset of `zstd` 0.13
//! used by Arrow IPC and Parquet 59.1.0.
//!
//! Compression emits interoperable raw Zstandard blocks for every accepted
//! level, so the level affects API validation rather than compression tuning.
//! Decompression accepts one ordinary Zstandard frame, enforces the caller's
//! output limit, and caps the frame window before the decoder allocates it.

use std::ops::RangeInclusive;

/// The minimum compression level reported by zstd 1.5.x.
const MIN_COMPRESSION_LEVEL: zstd_safe::CompressionLevel = -131_072;
/// The maximum compression level reported by zstd 1.5.x.
const MAX_COMPRESSION_LEVEL: zstd_safe::CompressionLevel = 22;
/// Shared ceiling checked before decoder-window or encoder-output allocation.
const MAX_WINDOW_SIZE: u64 = 100 * 1024 * 1024;

/// Returns the compression-level range expected from `zstd` 0.13.
pub fn compression_level_range() -> RangeInclusive<zstd_safe::CompressionLevel> {
    MIN_COMPRESSION_LEVEL..=MAX_COMPRESSION_LEVEL
}

/// The small `zstd_safe` surface used by Arrow and Parquet.
pub mod zstd_safe {
    use std::fmt;

    use crate::frame::parse_frame_header;

    /// A Zstandard compression level.
    pub type CompressionLevel = i32;

    /// The frame prefix is truncated or invalid.
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct ContentSizeError;

    impl fmt::Display for ContentSizeError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("Could not get content size")
        }
    }

    impl std::error::Error for ContentSizeError {}

    /// Returns the decompressed size recorded in the first frame header.
    ///
    /// `Ok(None)` means the header intentionally omits the size. Like
    /// `zstd_safe`, malformed and incomplete prefixes return an error.
    pub fn get_frame_content_size(source: &[u8]) -> Result<Option<u64>, ContentSizeError> {
        parse_frame_header(source)
            .map(|header| header.content_size)
            .map_err(|_| ContentSizeError)
    }
}

/// In-memory compression and decompression compatible with the calls made by
/// Arrow IPC and Parquet 59.1.0.
pub mod bulk {
    use std::io::{self, Write};
    use std::marker::PhantomData;

    use ruzstd::decoding::{BlockDecodingStrategy, FrameDecoder};

    use crate::frame::{encode_raw_frame, parse_frame_header};
    use crate::{MAX_COMPRESSION_LEVEL, MAX_WINDOW_SIZE, MIN_COMPRESSION_LEVEL};

    /// Match `ruzstd`'s intended decoder ceiling while checking it before its
    /// first-frame allocation path.
    const DECODE_CHUNK_SIZE: usize = 1024 * 1024;

    /// A reusable-compatible in-memory compressor.
    ///
    /// All valid zstd levels select the same raw-frame policy; retaining the
    /// level keeps constructor behavior compatible without promising tuning.
    pub struct Compressor<'a> {
        _lifetime: PhantomData<&'a ()>,
    }

    impl Compressor<'static> {
        /// Creates a compressor for an accepted zstd compression level.
        pub fn new(level: i32) -> io::Result<Self> {
            if !(MIN_COMPRESSION_LEVEL..=MAX_COMPRESSION_LEVEL).contains(&level) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "invalid zstd compression level {level}; expected {MIN_COMPRESSION_LEVEL}..={MAX_COMPRESSION_LEVEL}"
                    ),
                ));
            }

            Ok(Self {
                _lifetime: PhantomData,
            })
        }
    }

    impl<'a> Compressor<'a> {
        /// Compresses one independent Zstandard frame.
        pub fn compress(&mut self, source: &[u8]) -> io::Result<Vec<u8>> {
            encode_raw_frame(source)
        }
    }

    /// A reusable-compatible in-memory decompressor.
    pub struct Decompressor<'a> {
        _lifetime: PhantomData<&'a ()>,
    }

    impl Decompressor<'static> {
        /// Creates a decompressor.
        pub fn new() -> io::Result<Self> {
            Ok(Self {
                _lifetime: PhantomData,
            })
        }
    }

    impl<'a> Decompressor<'a> {
        /// Decompresses one frame without allowing more than `capacity` output
        /// bytes.
        pub fn decompress(&mut self, source: &[u8], capacity: usize) -> io::Result<Vec<u8>> {
            let header = parse_frame_header(source).map_err(invalid_data)?;

            if header.window_size > MAX_WINDOW_SIZE {
                return Err(resource_limit(
                    "window",
                    header.window_size,
                    MAX_WINDOW_SIZE,
                ));
            }

            if let Some(content_size) = header.content_size {
                if content_size > capacity as u64 {
                    return Err(resource_limit("output", content_size, capacity as u64));
                }
            }

            if header.window_size > capacity as u64 {
                return Err(resource_limit(
                    "window",
                    header.window_size,
                    capacity as u64,
                ));
            }

            let reserve = header
                .content_size
                .map(|size| size as usize)
                .unwrap_or(capacity);
            let mut output = Vec::new();
            output.try_reserve_exact(reserve).map_err(|error| {
                io::Error::new(
                    io::ErrorKind::OutOfMemory,
                    format!("could not reserve zstd output buffer: {error}"),
                )
            })?;

            let mut remaining = source;
            let mut decoder = FrameDecoder::new();
            decoder.init(&mut remaining).map_err(invalid_data)?;

            while !decoder.is_finished() {
                decoder
                    .decode_blocks(
                        &mut remaining,
                        BlockDecodingStrategy::UptoBytes(DECODE_CHUNK_SIZE),
                    )
                    .map_err(invalid_data)?;
                collect_bounded(&mut decoder, &mut output, capacity)?;
            }
            collect_bounded(&mut decoder, &mut output, capacity)?;

            if !remaining.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "trailing data or multiple zstd frames are not supported by bulk decompression",
                ));
            }

            if let Some(expected) = header.content_size {
                if output.len() as u64 != expected {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!(
                            "zstd frame declared {expected} output bytes but decoded {}",
                            output.len()
                        ),
                    ));
                }
            }

            if let Some(expected) = decoder.get_checksum_from_data() {
                let actual = decoder.get_calculated_checksum().ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "zstd checksum was present but could not be calculated",
                    )
                })?;
                if actual != expected {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "zstd content checksum mismatch",
                    ));
                }
            }

            Ok(output)
        }
    }

    fn collect_bounded(
        decoder: &mut FrameDecoder,
        output: &mut Vec<u8>,
        capacity: usize,
    ) -> io::Result<()> {
        let mut writer = BoundedWriter { output, capacity };
        decoder.collect_to_writer(&mut writer).map(|_| ())
    }

    struct BoundedWriter<'a> {
        output: &'a mut Vec<u8>,
        capacity: usize,
    }

    impl Write for BoundedWriter<'_> {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            let required = self.output.len().saturating_add(buffer.len());
            if required > self.capacity {
                return Err(resource_limit(
                    "output",
                    required as u64,
                    self.capacity as u64,
                ));
            }
            self.output.extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn invalid_data(error: impl std::fmt::Display) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidData, error.to_string())
    }

    fn resource_limit(resource: &str, required: u64, available: u64) -> io::Error {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("zstd resource limit: {resource} required {required} available {available}"),
        )
    }
}

mod frame {
    use std::fmt;
    use std::io;

    use crate::MAX_WINDOW_SIZE;

    const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];
    const MAX_BLOCK_SIZE: usize = 128 * 1024;

    pub(crate) struct FrameHeader {
        pub(crate) content_size: Option<u64>,
        pub(crate) window_size: u64,
    }

    #[derive(Debug)]
    pub(crate) struct FrameHeaderError(&'static str);

    impl fmt::Display for FrameHeaderError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.0)
        }
    }

    pub(crate) fn parse_frame_header(source: &[u8]) -> Result<FrameHeader, FrameHeaderError> {
        if source.get(..4) != Some(&ZSTD_MAGIC) {
            return Err(FrameHeaderError("invalid or truncated zstd frame magic"));
        }
        let descriptor = *source
            .get(4)
            .ok_or(FrameHeaderError("truncated zstd frame descriptor"))?;
        if descriptor & 0x18 != 0 {
            return Err(FrameHeaderError(
                "zstd frame descriptor has a reserved bit set",
            ));
        }

        let single_segment = descriptor & 0x20 != 0;
        let dictionary_id_size = match descriptor & 0x03 {
            0 => 0,
            1 => 1,
            2 => 2,
            _ => 4,
        };
        let content_size_size = match descriptor >> 6 {
            0 if single_segment => 1,
            0 => 0,
            1 => 2,
            2 => 4,
            _ => 8,
        };

        let mut cursor = 5usize;
        let window_size = if single_segment {
            0
        } else {
            let descriptor = *source
                .get(cursor)
                .ok_or(FrameHeaderError("truncated zstd window descriptor"))?;
            cursor += 1;
            let exponent = u32::from(descriptor >> 3);
            let mantissa = u64::from(descriptor & 0x07);
            let base = 1u64 << (10 + exponent);
            base + (base / 8) * mantissa
        };

        cursor = cursor
            .checked_add(dictionary_id_size)
            .ok_or(FrameHeaderError("invalid zstd frame header length"))?;
        let content_size_bytes = source
            .get(cursor..cursor + content_size_size)
            .ok_or(FrameHeaderError("truncated zstd frame content size"))?;

        let content_size = if content_size_size == 0 {
            None
        } else {
            let mut bytes = [0u8; 8];
            bytes[..content_size_size].copy_from_slice(content_size_bytes);
            let mut size = u64::from_le_bytes(bytes);
            if content_size_size == 2 {
                size += 256;
            }
            Some(size)
        };

        Ok(FrameHeader {
            content_size,
            window_size: if single_segment {
                content_size.expect("single-segment frames always carry a content size")
            } else {
                window_size
            },
        })
    }

    /// Encodes bounded source bytes as a standard single-segment frame made of
    /// raw blocks. The adapters are readers; this narrow writer exists only to
    /// satisfy the reusable bulk API that Arrow/Parquet instantiate.
    pub(crate) fn encode_raw_frame(source: &[u8]) -> io::Result<Vec<u8>> {
        let content_size = u64::try_from(source.len()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "input length does not fit in a zstd frame content size",
            )
        })?;
        if content_size > MAX_WINDOW_SIZE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("zstd input exceeds compatibility limit {MAX_WINDOW_SIZE}"),
            ));
        }
        let (size_flag, size_bytes, stored_size) = encoded_content_size(content_size);
        let block_count = if source.is_empty() {
            1
        } else {
            (source.len() - 1) / MAX_BLOCK_SIZE + 1
        };
        let frame_size = 4usize
            .checked_add(1)
            .and_then(|size| size.checked_add(size_bytes))
            .and_then(|size| size.checked_add(block_count.checked_mul(3)?))
            .and_then(|size| size.checked_add(source.len()))
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::OutOfMemory,
                    "zstd frame length overflows addressable memory",
                )
            })?;
        let mut frame = Vec::new();
        frame.try_reserve_exact(frame_size).map_err(|error| {
            io::Error::new(
                io::ErrorKind::OutOfMemory,
                format!("could not reserve zstd frame buffer: {error}"),
            )
        })?;
        frame.extend_from_slice(&ZSTD_MAGIC);
        frame.push((size_flag << 6) | 0x20);
        frame.extend_from_slice(&stored_size.to_le_bytes()[..size_bytes]);

        if source.is_empty() {
            frame.extend_from_slice(&1u32.to_le_bytes()[..3]);
        } else {
            for (index, block) in source.chunks(MAX_BLOCK_SIZE).enumerate() {
                let block_size = u32::try_from(block.len()).expect("one zstd block fits in u32");
                let last_block = u32::from(index + 1 == block_count);
                let block_header = (block_size << 3) | last_block;
                frame.extend_from_slice(&block_header.to_le_bytes()[..3]);
                frame.extend_from_slice(block);
            }
        }
        Ok(frame)
    }

    fn encoded_content_size(content_size: u64) -> (u8, usize, u64) {
        if content_size <= 255 {
            (0, 1, content_size)
        } else if content_size <= 65_791 {
            (1, 2, content_size - 256)
        } else if content_size <= u64::from(u32::MAX) {
            (2, 4, content_size)
        } else {
            (3, 8, content_size)
        }
    }
}
