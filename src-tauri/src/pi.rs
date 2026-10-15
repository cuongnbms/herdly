//! Talking to the `pi` coding agent on a Machine.

use crate::error::AppResult;
use crate::files::paths::{io_error, script_argv};
use crate::transport::{exec, Transport};
use serde::Serialize;

/// A model `pi --list-models` reports.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PiModel {
    pub provider: String,
    pub id: String,
}

/// Puts pi's own folder first on PATH (its `#!/usr/bin/env node` needs node beside it).
const LIST_MODELS_SCRIPT: &str = r#"PATH="${1%/*}:$PATH" exec "$1" --list-models"#;

pub fn list_models_argv(pi: &str) -> Vec<String> {
    script_argv(LIST_MODELS_SCRIPT, &[pi])
}

/// Rows of the table under the `provider model …` header; anything before it is ignored.
pub fn parse_list_models(stdout: &str) -> Vec<PiModel> {
    let mut in_table = false;
    let mut out = Vec::new();
    for line in stdout.lines() {
        let mut tok = line.split_whitespace();
        let (Some(a), Some(b)) = (tok.next(), tok.next()) else {
            continue;
        };
        if !in_table {
            in_table = a == "provider" && b == "model";
            continue;
        }
        out.push(PiModel {
            provider: a.into(),
            id: b.into(),
        });
    }
    out
}

pub async fn list_models(t: &dyn Transport, pi: &str) -> AppResult<Vec<PiModel>> {
    let out = exec(t, &list_models_argv(pi)).await?;
    if out.status != 0 {
        return Err(io_error(out.status, &out.stderr));
    }
    Ok(parse_list_models(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;

    fn m(provider: &str, id: &str) -> PiModel {
        PiModel {
            provider: provider.into(),
            id: id.into(),
        }
    }
    const TABLE: &str = "provider      model                  context  max-out  thinking  images\n\
9router       ag/gemini-3.8-flash    1M       128K     yes       yes   \n\
alias         high-model             1M       262.1K   yes       yes   \n\
\n";

    #[test]
    fn parses_list_models_table() {
        assert_eq!(
            parse_list_models(TABLE),
            vec![
                m("9router", "ag/gemini-3.8-flash"),
                m("alias", "high-model")
            ]
        );
    }
    #[test]
    fn skips_lines_before_the_header() {
        let out = format!("Warning: errors loading models.json:\nbad thing\n{TABLE}");
        assert_eq!(parse_list_models(&out).len(), 2);
    }
    #[test]
    fn no_header_is_empty() {
        assert_eq!(parse_list_models(""), vec![]);
        assert_eq!(
            parse_list_models("No models available. Run pi login\n"),
            vec![]
        );
    }
    #[test]
    fn argv_puts_pi_folder_first_on_path() {
        let argv = list_models_argv("/opt/node/bin/pi");
        assert_eq!(&argv[..2], &["sh", "-c"]);
        assert_eq!(argv.last().unwrap(), "/opt/node/bin/pi");
        assert!(argv[2].contains(r#"PATH="${1%/*}:$PATH" exec "$1" --list-models"#));
    }
    #[tokio::test]
    async fn runs_pi_and_reports_failures() {
        let d = tempfile::tempdir().unwrap();
        let ok = d.path().join("pi");
        std::fs::write(
            &ok,
            format!("#!/bin/sh\n[ \"$1\" = --list-models ] || exit 2\ncat <<'EOF'\n{TABLE}EOF\n"),
        )
        .unwrap();
        let bad = d.path().join("pi-bad");
        std::fs::write(&bad, "#!/bin/sh\necho 'models.json broken' >&2\nexit 1\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        for p in [&ok, &bad] {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let got = list_models(&LocalTransport, ok.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(got.len(), 2);
        let e = list_models(&LocalTransport, bad.to_str().unwrap())
            .await
            .unwrap_err();
        assert_eq!(e.code, "io");
        assert_eq!(e.message, "models.json broken");
    }
}
