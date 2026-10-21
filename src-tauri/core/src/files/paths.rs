use crate::complete::dirs::expand_home;
use crate::error::{AppError, AppResult};

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"];

/// A path below the root: `""` is the root itself; no leading `/`, `..` segment or NUL.
pub fn check_rel(rel: &str) -> AppResult<()> {
    if rel.starts_with('/') || rel.contains('\0') || rel.split('/').any(|s| s == "..") {
        return Err(AppError::new("invalid", format!("invalid path: {rel:?}")));
    }
    Ok(())
}

/// Expand a leading `~` against the Machine's home; the result is absolute, without a
/// trailing `/` (except `/` itself).
pub fn resolve_root(home: &str, root: &str) -> AppResult<String> {
    let mut expanded = expand_home(root, home);
    // A home of `/` expands `~` to "" (the trailing `/` is trimmed).
    if expanded.is_empty() && root.starts_with('~') {
        expanded = "/".to_string();
    }
    if !expanded.starts_with('/') || expanded.contains('\0') {
        return Err(AppError::new("invalid", format!("invalid root: {root:?}")));
    }
    let trimmed = expanded.trim_end_matches('/');
    Ok(if trimmed.is_empty() { "/" } else { trimmed }.to_string())
}

pub fn is_image(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    match name.rsplit_once('.') {
        // `.png` is a dotfile with no stem, not an image.
        Some((stem, ext)) if !stem.is_empty() => {
            IMAGE_EXTS.contains(&ext.to_ascii_lowercase().as_str())
        }
        _ => false,
    }
}

/// An `io` error for a script that failed: its stderr, or `exit N` when it printed nothing.
pub fn io_error(status: i32, stderr: &str) -> AppError {
    let msg = stderr.trim();
    if msg.is_empty() {
        AppError::new("io", format!("exit {status}"))
    } else {
        AppError::new("io", msg.to_string())
    }
}

/// argv running `script` under `sh -c` with `args` as `$1…` (never formatted into the script).
pub fn script_argv(script: &str, args: &[&str]) -> Vec<String> {
    ["sh", "-c", script, "sh"]
        .into_iter()
        .chain(args.iter().copied())
        .map(String::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_accepts_plain_and_empty() {
        for ok in [
            "",
            "a.txt",
            "src/a b.ts",
            ".github/x.yml",
            "-dash.md",
            "a..b",
        ] {
            assert!(check_rel(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn rel_rejects_escapes() {
        for bad in ["/etc/passwd", "..", "../x", "a/../../x", "a/..", "a\0b"] {
            assert_eq!(check_rel(bad).unwrap_err().code, "invalid", "{bad:?}");
        }
    }

    #[test]
    fn root_expands_tilde_against_machine_home() {
        assert_eq!(resolve_root("/home/u", "~").unwrap(), "/home/u");
        assert_eq!(
            resolve_root("/home/u", "~/w/app/").unwrap(),
            "/home/u/w/app"
        );
        assert_eq!(resolve_root("/home/u", "/srv/x").unwrap(), "/srv/x");
        assert_eq!(resolve_root("/home/u", "/").unwrap(), "/");
        assert_eq!(resolve_root("/", "~").unwrap(), "/");
        assert_eq!(resolve_root("/", "~/w").unwrap(), "/w");
        assert_eq!(
            resolve_root("/home/u", "rel/x").unwrap_err().code,
            "invalid"
        );
        assert_eq!(resolve_root("/home/u", "").unwrap_err().code, "invalid");
    }

    #[test]
    fn images_by_extension() {
        assert!(is_image("a/B.PNG"));
        assert!(is_image("x.svg"));
        assert!(!is_image("x.svgz"));
        assert!(!is_image("png"));
        assert!(!is_image(".png"));
        assert!(!is_image("dir/.PNG"));
    }

    #[test]
    fn io_error_falls_back_to_the_exit_status() {
        let e = io_error(7, "  \n");
        assert_eq!((e.code.as_str(), e.message.as_str()), ("io", "exit 7"));
        assert_eq!(io_error(1, "boom\n").message, "boom");
    }

    #[test]
    fn script_argv_passes_args_positionally() {
        assert_eq!(
            script_argv("echo \"$1\"", &["a b", "$(x)"]),
            vec!["sh", "-c", "echo \"$1\"", "sh", "a b", "$(x)"]
        );
        assert_eq!(script_argv("true", &[]), vec!["sh", "-c", "true", "sh"]);
    }
}
