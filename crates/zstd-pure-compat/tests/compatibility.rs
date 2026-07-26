use std::io::{self, Write};

use zstd::bulk::{Compressor, Decompressor};

#[test]
fn reports_the_reference_level_range() {
    assert_eq!(
        zstd::compression_level_range(),
        zstd_real::compression_level_range()
    );
}

#[test]
fn rejects_out_of_range_levels() {
    assert!(Compressor::new(-131_073).is_err());
    assert!(Compressor::new(23).is_err());
}

#[test]
fn round_trips_boundary_sized_inputs() {
    for size in [
        0,
        1,
        255,
        256,
        65_791,
        65_792,
        128 * 1024,
        128 * 1024 + 1,
        256 * 1024,
    ] {
        let input: Vec<u8> = (0..size).map(|index| (index % 251) as u8).collect();
        let mut compressor = Compressor::new(3).unwrap();
        let encoded = compressor.compress(&input).unwrap();

        assert_eq!(
            zstd::zstd_safe::get_frame_content_size(&encoded).unwrap(),
            Some(size as u64)
        );

        let mut decompressor = Decompressor::new().unwrap();
        assert_eq!(decompressor.decompress(&encoded, size).unwrap(), input);
        assert_eq!(zstd_real::bulk::decompress(&encoded, size).unwrap(), input);
    }
}

#[test]
fn reference_decoder_accepts_compat_frames() {
    let empty = Compressor::new(1).unwrap().compress(&[]).unwrap();
    assert_eq!(zstd_real::bulk::decompress(&empty, 0).unwrap(), b"");

    let input = b"a pure Rust zstd frame consumed by the reference implementation".repeat(5_000);
    let encoded = Compressor::new(22).unwrap().compress(&input).unwrap();
    let decoded = zstd_real::bulk::decompress(&encoded, input.len()).unwrap();
    assert_eq!(decoded, input);
}

#[test]
fn reused_compressor_emits_independent_frames() {
    let mut compressor = Compressor::new(3).unwrap();
    let inputs = [
        b"first independent frame".repeat(8_000),
        b"second independent frame".repeat(8_000),
    ];
    for input in &inputs {
        let encoded = compressor.compress(input).unwrap();
        let decoded = zstd_real::bulk::decompress(&encoded, input.len()).unwrap();
        assert_eq!(decoded.as_slice(), input.as_slice());
        let decoded = Decompressor::new()
            .unwrap()
            .decompress(&encoded, input.len())
            .unwrap();
        assert_eq!(decoded.as_slice(), input.as_slice());
    }
}

#[test]
fn compat_decoder_accepts_reference_frames() {
    let empty = zstd_real::bulk::compress(&[], 3).unwrap();
    assert_eq!(
        Decompressor::new().unwrap().decompress(&empty, 0).unwrap(),
        b""
    );

    let mut input = b"a reference zstd frame consumed by the pure Rust implementation".repeat(500);
    let mut state = 0x1234_5678u32;
    for byte in &mut input[5_000..10_000] {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *byte = (state >> 24) as u8;
    }

    for level in [-5, 1, 3, 9, 19, 22] {
        let encoded = zstd_real::bulk::compress(&input, level).unwrap();
        let decoded = Decompressor::new()
            .unwrap()
            .decompress(&encoded, input.len())
            .unwrap();
        assert_eq!(decoded, input, "reference compression level {level}");
    }
}

#[test]
fn validates_reference_frame_checksums() {
    let input = b"checksummed zstd content".repeat(100);
    let mut encoder = zstd_real::stream::write::Encoder::new(Vec::new(), 3).unwrap();
    encoder.include_checksum(true).unwrap();
    encoder
        .set_pledged_src_size(Some(input.len() as u64))
        .unwrap();
    encoder.write_all(&input).unwrap();
    let encoded = encoder.finish().unwrap();
    assert_eq!(
        zstd::zstd_safe::get_frame_content_size(&encoded).unwrap(),
        Some(input.len() as u64)
    );

    let decoded = Decompressor::new()
        .unwrap()
        .decompress(&encoded, input.len())
        .unwrap();
    assert_eq!(decoded, input);

    let mut corrupted = encoded;
    *corrupted.last_mut().unwrap() ^= 1;
    let error = Decompressor::new()
        .unwrap()
        .decompress(&corrupted, input.len())
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("checksum"));
}

#[test]
fn rejects_a_declared_size_over_the_output_limit_before_decoding() {
    let input = b"bounded output".repeat(100);
    let encoded = Compressor::new(1).unwrap().compress(&input).unwrap();
    let error = Decompressor::new()
        .unwrap()
        .decompress(&encoded, input.len() - 1)
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert_eq!(
        error.to_string(),
        format!(
            "zstd resource limit: output required {} available {}",
            input.len(),
            input.len() - 1
        )
    );
}

#[test]
fn rejects_a_frame_window_over_the_caller_capacity_before_decoding() {
    // Descriptor 0 requests a 1 KiB window and omits the content size. The
    // block body is intentionally absent: rejection must happen first.
    let encoded = [0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00];
    let error = Decompressor::new()
        .unwrap()
        .decompress(&encoded, 1023)
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert_eq!(
        error.to_string(),
        "zstd resource limit: window required 1024 available 1023"
    );
}

#[test]
fn rejects_an_unknown_size_frame_when_output_crosses_the_limit() {
    let input = vec![b'x'; 128 * 1024 + 1];
    let encoded = ruzstd::encoding::compress_to_vec(
        input.as_slice(),
        ruzstd::encoding::CompressionLevel::Fastest,
    );
    assert_eq!(
        zstd::zstd_safe::get_frame_content_size(&encoded).unwrap(),
        None
    );

    let error = Decompressor::new()
        .unwrap()
        .decompress(&encoded, 128 * 1024)
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert_eq!(
        error.to_string(),
        format!(
            "zstd resource limit: output required {} available {}",
            input.len(),
            128 * 1024
        )
    );
}

#[test]
fn rejects_an_oversized_window_before_decoder_allocation() {
    // Window descriptor 0xf8 requests a 2 TiB window. No block bytes are
    // needed because the compatibility layer rejects the header first.
    let encoded = [0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xf8];
    let error = Decompressor::new()
        .unwrap()
        .decompress(&encoded, usize::MAX)
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert_eq!(
        error.to_string(),
        format!(
            "zstd resource limit: window required {} available {}",
            1u64 << 41,
            100 * 1024 * 1024
        )
    );
}

#[test]
fn malformed_and_trailing_data_return_errors() {
    assert!(zstd::zstd_safe::get_frame_content_size(&[1, 2, 3]).is_err());
    assert!(Decompressor::new()
        .unwrap()
        .decompress(&[1, 2, 3], 100)
        .is_err());

    let mut encoded = Compressor::new(1).unwrap().compress(b"payload").unwrap();
    encoded.push(0);
    let error = Decompressor::new()
        .unwrap()
        .decompress(&encoded, 7)
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
}
