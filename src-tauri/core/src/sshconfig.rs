//! Minimal `~/.ssh/config` reader: only `Host` aliases, for the Add machine suggestions.

/// `Host` aliases in file order, deduplicated. The keyword is case-insensitive; patterns
/// (`*`, `?`, leading `!`) are skipped.
pub fn hosts(config_text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in config_text.lines() {
        let line = line.trim();
        let (keyword, rest) = match line.find(|c: char| c.is_whitespace() || c == '=') {
            Some(i) => (
                &line[..i],
                line[i..].trim_start_matches(|c: char| c.is_whitespace() || c == '='),
            ),
            None => (line, ""),
        };
        if !keyword.eq_ignore_ascii_case("host") {
            continue;
        }
        for alias in rest.split_whitespace() {
            let alias = alias.trim_matches('"');
            if alias.is_empty() || alias.contains(['*', '?']) || alias.starts_with('!') {
                continue;
            }
            if !out.iter().any(|h| h == alias) {
                out.push(alias.to_string());
            }
        }
    }
    out
}

/// Hosts from `~/.ssh/config`; a missing or unreadable file gives an empty list (`Include` is not followed).
pub fn read_hosts() -> Vec<String> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    match std::fs::read_to_string(std::path::Path::new(&home).join(".ssh/config")) {
        Ok(text) => hosts(&text),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lists_concrete_hosts() {
        let cfg = "Host *\n  ServerAliveInterval 30\nHost devtuf gpu-box\n  HostName 10.0.0.5\nHost *.internal !bastion\nHost devtuf\n  User me\nhost lower\n";
        assert_eq!(hosts(cfg), vec!["devtuf", "gpu-box", "lower"]);
    }
}
