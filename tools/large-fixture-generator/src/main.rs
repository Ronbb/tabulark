use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const EXACT_TWO_GIB: u64 = 1_u64 << 31;
const TAIL_WINDOW: usize = 64 * 1024;
const XLS_TAIL_MARKER: &[u8] = b"TABULARK-M6-XLS-TAIL";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Format {
    Csv,
    Arrow,
    Parquet,
    Xlsx,
    Xls,
}

impl Format {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "csv" => Ok(Self::Csv),
            "arrow" => Ok(Self::Arrow),
            "parquet" => Ok(Self::Parquet),
            "xlsx" => Ok(Self::Xlsx),
            "xls" => Ok(Self::Xls),
            _ => Err(format!("unsupported format: {value}")),
        }
    }
}

struct Args {
    command: String,
    format: Format,
    input: Option<PathBuf>,
    output: PathBuf,
    size: u64,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("tabulark-large-fixture-generator: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = parse_args()?;
    match args.command.as_str() {
        "generate" => generate(&args)?,
        "verify" => verify(&args)?,
        _ => return Err("command must be generate or verify".into()),
    }
    Ok(())
}

fn parse_args() -> Result<Args, String> {
    let mut values = env::args().skip(1);
    let command = values.next().ok_or("missing command")?;
    let mut format = None;
    let mut input = None;
    let mut output = None;
    let mut size = EXACT_TWO_GIB;
    while let Some(flag) = values.next() {
        let value = values
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--format" => format = Some(Format::parse(&value)?),
            "--input" => input = Some(PathBuf::from(value)),
            "--output" => output = Some(PathBuf::from(value)),
            "--size" => size = value.parse().map_err(|_| "invalid --size")?,
            _ => return Err(format!("unknown option: {flag}")),
        }
    }
    Ok(Args {
        command,
        format: format.ok_or("missing --format")?,
        input,
        output: output.ok_or("missing --output")?,
        size,
    })
}

fn generate(args: &Args) -> Result<(), String> {
    if let Some(parent) = args.output.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    match args.format {
        Format::Csv => generate_csv(&args.output, args.size),
        Format::Arrow => expand_tail_container(args, arrow_tail_start),
        Format::Parquet => expand_tail_container(args, parquet_tail_start),
        Format::Xlsx => generate_zip64(args),
        Format::Xls => generate_cfb(args),
    }?;
    verify(args)
}

fn generate_csv(path: &Path, size: u64) -> Result<(), String> {
    const HEADER: &[u8] = b"row,payload,tail_marker\n";
    const FINAL_PREFIX: &[u8] = b"2147483647,";
    const FINAL_SUFFIX: &[u8] = b",TABULARK_M6_LAST_BYTE\n";
    if size < (HEADER.len() + FINAL_PREFIX.len() + FINAL_SUFFIX.len()) as u64 {
        return Err("CSV target is too small".into());
    }
    let file = File::create(path).map_err(io_error)?;
    let mut writer = BufWriter::with_capacity(8 * 1024 * 1024, file);
    writer.write_all(HEADER).map_err(io_error)?;
    let mut written = HEADER.len() as u64;
    let block = {
        let mut bytes = Vec::with_capacity(1024 * 1024);
        bytes.extend_from_slice(b"1,");
        bytes.resize(1024 * 1024 - 1, b'x');
        bytes.push(b'\n');
        bytes
    };
    let minimum_final = (FINAL_PREFIX.len() + FINAL_SUFFIX.len()) as u64;
    while size - written >= block.len() as u64 + minimum_final {
        writer.write_all(&block).map_err(io_error)?;
        written += block.len() as u64;
    }
    let final_size = usize::try_from(size - written).map_err(|_| "CSV tail is too large")?;
    let payload_size = final_size
        .checked_sub(FINAL_PREFIX.len() + FINAL_SUFFIX.len())
        .ok_or("CSV tail is too small")?;
    writer.write_all(FINAL_PREFIX).map_err(io_error)?;
    write_repeated(&mut writer, b'x', payload_size).map_err(io_error)?;
    writer.write_all(FINAL_SUFFIX).map_err(io_error)?;
    writer.flush().map_err(io_error)
}

fn expand_tail_container(
    args: &Args,
    locate_tail: fn(&[u8]) -> Result<usize, String>,
) -> Result<(), String> {
    let source = read_template(args)?;
    let tail_start = locate_tail(&source)?;
    let tail = &source[tail_start..];
    let prefix = &source[..tail_start];
    if args.size < (prefix.len() + tail.len()) as u64 {
        return Err("target is smaller than its template".into());
    }
    let mut output = sparse_output(&args.output, args.size)?;
    output.write_all(prefix).map_err(io_error)?;
    output
        .seek(SeekFrom::Start(args.size - tail.len() as u64))
        .map_err(io_error)?;
    output.write_all(tail).map_err(io_error)
}

fn arrow_tail_start(bytes: &[u8]) -> Result<usize, String> {
    if bytes.len() < 10 || &bytes[bytes.len() - 6..] != b"ARROW1" {
        return Err("Arrow template has no trailing ARROW1 magic".into());
    }
    let footer_length = u32::from_le_bytes(
        bytes[bytes.len() - 10..bytes.len() - 6]
            .try_into()
            .map_err(|_| "invalid Arrow footer length")?,
    ) as usize;
    bytes
        .len()
        .checked_sub(10 + footer_length)
        .ok_or_else(|| "Arrow footer lies outside the template".into())
}

fn parquet_tail_start(bytes: &[u8]) -> Result<usize, String> {
    if bytes.len() < 8 || &bytes[bytes.len() - 4..] != b"PAR1" {
        return Err("Parquet template has no trailing PAR1 magic".into());
    }
    let metadata_length = u32::from_le_bytes(
        bytes[bytes.len() - 8..bytes.len() - 4]
            .try_into()
            .map_err(|_| "invalid Parquet metadata length")?,
    ) as usize;
    bytes
        .len()
        .checked_sub(8 + metadata_length)
        .ok_or_else(|| "Parquet metadata lies outside the template".into())
}

fn generate_zip64(args: &Args) -> Result<(), String> {
    let source = read_template(args)?;
    let eocd = find_eocd(&source)?;
    let entries = read_u16(&source, eocd + 10)?;
    let central_size = read_u32(&source, eocd + 12)? as usize;
    let central_offset = read_u32(&source, eocd + 16)? as usize;
    let comment_length = read_u16(&source, eocd + 20)? as usize;
    if eocd + 22 + comment_length != source.len()
        || central_offset.checked_add(central_size) != Some(eocd)
    {
        return Err("XLSX template has a non-canonical central directory".into());
    }
    let central = &source[central_offset..eocd];
    let comment = &source[eocd + 22..];
    let tail_length = central.len() + 56 + 20 + 22 + comment.len();
    if args.size < central_offset as u64 + tail_length as u64 {
        return Err("XLSX target is too small".into());
    }
    let new_central_offset = args.size - tail_length as u64;
    let zip64_offset = new_central_offset + central.len() as u64;
    let mut output = sparse_output(&args.output, args.size)?;
    output
        .write_all(&source[..central_offset])
        .map_err(io_error)?;
    output
        .seek(SeekFrom::Start(new_central_offset))
        .map_err(io_error)?;
    output.write_all(central).map_err(io_error)?;
    write_u32(&mut output, 0x0606_4b50)?;
    write_u64(&mut output, 44)?;
    write_u16(&mut output, 45)?;
    write_u16(&mut output, 45)?;
    write_u32(&mut output, 0)?;
    write_u32(&mut output, 0)?;
    write_u64(&mut output, u64::from(entries))?;
    write_u64(&mut output, u64::from(entries))?;
    write_u64(&mut output, central.len() as u64)?;
    write_u64(&mut output, new_central_offset)?;
    write_u32(&mut output, 0x0706_4b50)?;
    write_u32(&mut output, 0)?;
    write_u64(&mut output, zip64_offset)?;
    write_u32(&mut output, 1)?;
    write_u32(&mut output, 0x0605_4b50)?;
    write_u16(&mut output, 0)?;
    write_u16(&mut output, 0)?;
    write_u16(&mut output, u16::MAX)?;
    write_u16(&mut output, u16::MAX)?;
    write_u32(&mut output, u32::MAX)?;
    write_u32(&mut output, u32::MAX)?;
    write_u16(
        &mut output,
        u16::try_from(comment.len()).map_err(|_| "ZIP comment is too large")?,
    )?;
    output.write_all(comment).map_err(io_error)
}

fn generate_cfb(args: &Args) -> Result<(), String> {
    let source = read_template(args)?;
    const SIGNATURE: &[u8] = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1";
    if !source.starts_with(SIGNATURE) {
        return Err("XLS template is not a CFB container".into());
    }
    if args.size < source.len() as u64 + XLS_TAIL_MARKER.len() as u64 {
        return Err("XLS target is too small".into());
    }
    let mut output = sparse_output(&args.output, args.size)?;
    output.write_all(&source).map_err(io_error)?;
    output
        .seek(SeekFrom::Start(args.size - XLS_TAIL_MARKER.len() as u64))
        .map_err(io_error)?;
    output.write_all(XLS_TAIL_MARKER).map_err(io_error)
}

fn verify(args: &Args) -> Result<(), String> {
    let metadata = fs::metadata(&args.output).map_err(io_error)?;
    if metadata.len() != args.size {
        return Err(format!(
            "expected {} bytes, found {}",
            args.size,
            metadata.len()
        ));
    }
    let mut file = File::open(&args.output).map_err(io_error)?;
    let window_length = usize::try_from(args.size.min(TAIL_WINDOW as u64))
        .map_err(|_| "tail window does not fit memory")?;
    file.seek(SeekFrom::Start(args.size - window_length as u64))
        .map_err(io_error)?;
    let mut tail = vec![0; window_length];
    file.read_exact(&mut tail).map_err(io_error)?;
    let tail_ok = match args.format {
        Format::Csv => tail
            .windows(b"TABULARK_M6_LAST_BYTE".len())
            .any(|part| part == b"TABULARK_M6_LAST_BYTE"),
        Format::Arrow => tail.ends_with(b"ARROW1"),
        Format::Parquet => tail.ends_with(b"PAR1"),
        Format::Xlsx => tail.windows(4).any(|part| part == b"PK\x05\x06"),
        Format::Xls => tail.ends_with(XLS_TAIL_MARKER),
    };
    if !tail_ok {
        return Err("the final bounded window does not contain the format trailer".into());
    }
    println!(
        "{{\"format\":\"{}\",\"size\":{},\"tailStart\":{},\"lastByteOffset\":{},\"tailReadBytes\":{}}}",
        format_name(args.format),
        args.size,
        args.size - window_length as u64,
        args.size - 1,
        window_length
    );
    Ok(())
}

fn read_template(args: &Args) -> Result<Vec<u8>, String> {
    let path = args
        .input
        .as_deref()
        .ok_or("this format requires --input")?;
    fs::read(path).map_err(io_error)
}

fn sparse_output(path: &Path, size: u64) -> Result<File, String> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .read(true)
        .write(true)
        .open(path)
        .map_err(io_error)?;
    file.set_len(size).map_err(io_error)?;
    Ok(file)
}

fn find_eocd(bytes: &[u8]) -> Result<usize, String> {
    let start = bytes.len().saturating_sub(65_557);
    (start..bytes.len().saturating_sub(3))
        .rev()
        .find(|&offset| bytes[offset..].starts_with(b"PK\x05\x06"))
        .ok_or_else(|| "XLSX template has no EOCD".into())
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let value = bytes
        .get(offset..offset + 2)
        .ok_or("integer lies outside the template")?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or("integer lies outside the template")?;
    Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

fn write_u16(writer: &mut File, value: u16) -> Result<(), String> {
    writer.write_all(&value.to_le_bytes()).map_err(io_error)
}

fn write_u32(writer: &mut File, value: u32) -> Result<(), String> {
    writer.write_all(&value.to_le_bytes()).map_err(io_error)
}

fn write_u64(writer: &mut File, value: u64) -> Result<(), String> {
    writer.write_all(&value.to_le_bytes()).map_err(io_error)
}

fn write_repeated(writer: &mut impl Write, byte: u8, length: usize) -> io::Result<()> {
    let block = [byte; 64 * 1024];
    let mut remaining = length;
    while remaining > 0 {
        let count = remaining.min(block.len());
        writer.write_all(&block[..count])?;
        remaining -= count;
    }
    Ok(())
}

fn format_name(format: Format) -> &'static str {
    match format {
        Format::Csv => "csv",
        Format::Arrow => "arrow",
        Format::Parquet => "parquet",
        Format::Xlsx => "xlsx",
        Format::Xls => "xls",
    }
}

fn io_error(error: io::Error) -> String {
    error.to_string()
}
