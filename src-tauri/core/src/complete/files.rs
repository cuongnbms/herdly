//! Files under a Pane's working directory, for `@file` completion.
use crate::error::AppResult;
use crate::transport::{exec, Transport};

pub const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    "target",
    "dist",
    "build",
    ".next",
    ".worktrees",
];

/// A `find` expression that prunes the `SKIP_DIRS` folders (files with those names are kept);
/// follow it with `-o` and what to print.
pub fn find_prune() -> String {
    let names = SKIP_DIRS
        .iter()
        .map(|n| format!("-name {n}"))
        .collect::<Vec<_>>()
        .join(" -o ");
    format!("\\( -type d \\( {names} \\) \\) -prune")
}

const MAX_DEPTH: usize = 6;
const MAX_FILES: usize = 5000;

/// Whether `dir` is the home folder (trailing `/` ignored). Scanning it would walk
/// `~/Library` and trigger macOS privacy prompts, so callers refuse it.
pub fn is_home(home: &str, dir: &str) -> bool {
    dir.trim_end_matches('/') == home.trim_end_matches('/')
}

/// Paths relative to `cwd`, `/`-separated and sorted; empty when `cwd` is missing or
/// is the home folder, which would scan `~/Library` and trigger macOS privacy prompts.
pub async fn list_files(t: &dyn Transport, home: &str, cwd: &str) -> AppResult<Vec<String>> {
    // The home folder holds no project files, so skip it before running anything.
    if is_home(home, cwd) {
        return Ok(Vec::new());
    }
    let prune = find_prune();
    // Only folders are pruned: a file named `build` is still listed.
    // -maxdepth goes first: GNU find warns when it follows other expressions.
    let script = format!(
        "cd \"$1\" 2>/dev/null || exit 0; find . -maxdepth {MAX_DEPTH} {prune} -o -type f -print | head -n {MAX_FILES}"
    );
    let argv = vec![
        "sh".to_string(),
        "-c".into(),
        script,
        "sh".into(),
        cwd.to_string(),
    ];
    let o = exec(t, &argv).await?;
    let mut files: Vec<String> = o
        .stdout
        .lines()
        .map(|l| l.strip_prefix("./").unwrap_or(l).to_string())
        .filter(|l| !l.is_empty())
        .collect();
    files.sort();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;

    #[tokio::test]
    async fn lists_files_relative_to_cwd_skipping_heavy_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("my repo");
        for p in [
            "README.md",
            "src/a.ts",
            "src/deep/b.ts",
            "node_modules/x/i.js",
            ".venv/lib/y.py",
            "venv/z.py",
            "target/debug/out",
            ".git/HEAD",
            "a/b/c/d/e/f.txt",
            "a/b/c/d/e/f/g.txt",
            "has space/n.md",
            "scripts/build",
            "dist",
        ] {
            let f = root.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, "").unwrap();
        }
        let got = list_files(
            &LocalTransport,
            "/nonexistent-home",
            &root.to_string_lossy(),
        )
        .await
        .unwrap();
        assert_eq!(
            got,
            vec![
                "README.md",
                "a/b/c/d/e/f.txt",
                "dist",
                "has space/n.md",
                "scripts/build",
                "src/a.ts",
                "src/deep/b.ts"
            ]
        );
    }

    #[tokio::test]
    async fn a_missing_cwd_has_no_files() {
        let got = list_files(
            &LocalTransport,
            "/nonexistent-home",
            "/nonexistent/herdr-app",
        )
        .await
        .unwrap();
        assert!(got.is_empty());
    }

    #[tokio::test]
    async fn the_home_folder_has_no_files() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(home.join("Library/Caches")).unwrap();
        std::fs::write(home.join("Library/Caches/x"), "").unwrap();
        std::fs::write(home.join("notes.md"), "").unwrap();
        let h = home.to_string_lossy().into_owned();
        for (home_arg, cwd) in [
            (h.clone(), h.clone()),
            (h.clone(), format!("{h}/")),
            (format!("{h}/"), h.clone()),
        ] {
            let got = list_files(&LocalTransport, &home_arg, &cwd).await.unwrap();
            assert!(got.is_empty(), "home={home_arg} cwd={cwd}: {got:?}");
        }
    }
}
