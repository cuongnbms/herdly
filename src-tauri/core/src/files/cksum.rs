//! POSIX `cksum` CRC (ADR-0007): the version check of a save compares it with the `cksum` binary's output on the Machine.

const TABLE: [u32; 256] = build_table();

const fn build_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = (i as u32) << 24;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 0x8000_0000 != 0 {
                (crc << 1) ^ 0x04C1_1DB7
            } else {
                crc << 1
            };
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
}

fn update(crc: u32, byte: u8) -> u32 {
    (crc << 8) ^ TABLE[((crc >> 24) as u8 ^ byte) as usize]
}

/// The first number the `cksum` binary prints for `bytes`.
pub fn cksum(bytes: &[u8]) -> u32 {
    let mut crc = bytes.iter().fold(0u32, |crc, &b| update(crc, b));
    let mut len = bytes.len() as u64;
    while len != 0 {
        crc = update(crc, (len & 0xff) as u8);
        len >>= 8;
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::cksum;
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn system(bytes: &[u8]) -> u32 {
        let mut child = Command::new("cksum")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(bytes).unwrap();
        let out = child.wait_with_output().unwrap();
        let s = String::from_utf8(out.stdout).unwrap();
        s.split_whitespace().next().unwrap().parse().unwrap()
    }

    #[test]
    fn known_values() {
        assert_eq!(cksum(b""), 4294967295);
        assert_eq!(cksum(b"hello\n"), 3015617425);
    }

    #[test]
    fn matches_the_cksum_binary() {
        let long: Vec<u8> = (0..70_000u32).map(|i| (i * 31 % 251) as u8).collect();
        for sample in [&b"a"[..], b"a\r\nb\n", "héllo wörld\n".as_bytes(), &long] {
            assert_eq!(cksum(sample), system(sample), "{} bytes", sample.len());
        }
    }
}
