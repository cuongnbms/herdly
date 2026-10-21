//! Slash commands an Agent offers in a Pane: its built-ins plus the commands,
//! prompts and skills found in folders on the Pane's Machine.
use crate::error::AppResult;
use crate::transport::{exec, Transport};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<&'static str>,
}

const BUILTIN_CLAUDE: &[&str] = &[
    "clear",
    "compact",
    "config",
    "cost",
    "help",
    "init",
    "memory",
    "model",
    "permissions",
    "review",
    "status",
    "doctor",
    "login",
    "logout",
    "pr-comments",
    "release-notes",
    "terminal-setup",
    "vim",
];
const BUILTIN_CODEX: &[&str] = &[
    "clear", "compact", "diff", "help", "model", "new", "quit", "review", "status",
];
// pi's own palette, less /tree: the chat cannot leave pi's tree browser once it opens it.
const BUILTIN_PI: &[&str] = &[
    "settings",
    "model",
    "thinking",
    "scoped-models",
    "login",
    "logout",
    "llama",
    "new",
    "resume",
    "name",
    "session",
    "fork",
    "clone",
    "compact",
    "import",
    "copy",
    "export",
    "share",
    "bug",
    "trust",
    "reload",
    "hotkeys",
    "changelog",
    "quit",
];

const PI_DESCRIPTIONS: &[(&str, &str)] = &[
    ("settings", "Open settings menu"),
    ("model", "<provider/model> — Select model"),
    ("thinking", "<level> — Set thinking level"),
    ("scoped-models", "Enable/disable models for Ctrl+P cycling"),
    ("login", "<provider> — Configure provider authentication"),
    ("logout", "Remove provider authentication"),
    ("llama", "[t] Manage llama.cpp router models"),
    ("new", "Start a new session"),
    ("resume", "Resume a different session"),
    ("name", "Set session display name"),
    ("session", "Show session info and stats"),
    ("fork", "Create a new fork from a previous user message"),
    (
        "clone",
        "Duplicate the current session at the current position",
    ),
    ("compact", "Manually compact the session context"),
    ("import", "Import and resume a session from a JSONL file"),
    ("copy", "Copy last agent message to clipboard"),
    (
        "export",
        "Export session (HTML default, or specify path: .html/.jsonl)",
    ),
    ("share", "Share session as a secret GitHub gist"),
    ("bug", "<description> — Report a bug to the Pi developers"),
    ("trust", "Save project trust decision for future sessions"),
    (
        "reload",
        "Reload keybindings, extensions, skills, prompts, themes, and context files",
    ),
    ("hotkeys", "Show all keyboard shortcuts"),
    ("changelog", "Show changelog entries"),
    ("quit", "Quit pi"),
];

const DESCRIPTIONS: &[(&str, &str)] = &[
    ("clear", "Clear the conversation"),
    ("compact", "Compact conversation context"),
    ("config", "Open configuration"),
    ("cost", "Show token usage and cost"),
    ("help", "Show available commands"),
    ("init", "Initialize project instructions"),
    ("memory", "Edit agent memory"),
    ("model", "Choose a model"),
    ("permissions", "Manage tool permissions"),
    ("review", "Review changes"),
    ("status", "Show session status"),
    ("doctor", "Check the installation"),
    ("login", "Sign in"),
    ("logout", "Sign out"),
    ("pr-comments", "Fetch pull request comments"),
    ("release-notes", "Show release notes"),
    ("terminal-setup", "Configure terminal integration"),
    ("vim", "Toggle Vim mode"),
    ("new", "Start a new session"),
    ("sessions", "List sessions"),
    ("exit", "Exit the agent"),
    ("diff", "Show the current diff"),
    ("quit", "Exit the agent"),
];

fn lookup(table: &'static [(&str, &str)], name: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == name).map(|(_, v)| *v)
}

fn builtins(agent: &str) -> Vec<SlashCommand> {
    let names = match agent {
        "claude" => BUILTIN_CLAUDE,
        "pi" => BUILTIN_PI,
        "codex" => BUILTIN_CODEX,
        _ => return Vec::new(),
    };
    names
        .iter()
        .map(|name| SlashCommand {
            name: (*name).to_string(),
            description: (if agent == "pi" {
                lookup(PI_DESCRIPTIONS, name)
            } else {
                None
            })
            .or_else(|| lookup(DESCRIPTIONS, name))
            .map(str::to_string)
            .unwrap_or_else(|| format!("Run /{name}")),
            source: "builtin",
            trigger: None,
        })
        .collect()
}

/// Split `---\n…\n---` frontmatter off `markdown`: (frontmatter body, rest).
fn frontmatter(markdown: &str) -> Option<(&str, &str)> {
    let after = markdown.strip_prefix("---")?;
    let nl = after.find('\n')?;
    if !after[..nl].trim().is_empty() {
        return None;
    }
    let body = &after[nl + 1..];
    let mut pos = 0usize;
    for line in body.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Some((&body[..pos.saturating_sub(1)], &body[pos + line.len()..]));
        }
        pos += line.len();
    }
    None
}

fn unquote(s: &str) -> &str {
    for q in ['"', '\''] {
        if let Some(inner) = s.strip_prefix(q).and_then(|r| r.strip_suffix(q)) {
            return inner;
        }
    }
    s
}

fn field<'a>(front: &'a str, key: &str) -> Option<&'a str> {
    front.lines().find_map(|line| {
        let v = line.strip_prefix(key)?.strip_prefix(':')?.trim();
        (!v.is_empty()).then_some(v)
    })
}

/// A one-line description: frontmatter `description:`, else the first non-blank line.
pub fn description(markdown: &str) -> String {
    let fm = frontmatter(markdown);
    if let Some(found) = fm.and_then(|(front, _)| field(front, "description")) {
        return unquote(found).chars().take(120).collect();
    }
    let body = fm.map_or(markdown, |(_, rest)| rest);
    body.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .chars()
        .take(120)
        .collect()
}

/// `name:` from a SKILL.md's frontmatter when it is a valid name, else `dir`.
pub fn skill_name(markdown: &str, dir: &str) -> String {
    let named = frontmatter(markdown)
        .and_then(|(front, _)| field(front, "name"))
        .map(unquote);
    match named {
        Some(n)
            if !n.is_empty()
                && n.chars()
                    .all(|c| c.is_alphanumeric() || matches!(c, '_' | ':' | '-')) =>
        {
            n.to_string()
        }
        _ => dir.to_string(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RootKind {
    /// `<dir>/*/SKILL.md`
    Skills,
    /// `**/*.md`, `a/b.md` named `a:b`
    Commands,
    /// `<dir>/*.md`, direct children only
    Prompts,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Root {
    pub kind: RootKind,
    pub dir: String,
    pub source: &'static str,
    pub prefix: String,
    pub trigger: Option<&'static str>,
}

fn root(
    kind: RootKind,
    dir: String,
    source: &'static str,
    prefix: &str,
    trigger: Option<&'static str>,
) -> Root {
    Root {
        kind,
        dir,
        source,
        prefix: prefix.to_string(),
        trigger,
    }
}

/// The folders an Agent reads commands from (plugins excluded).
pub fn roots(agent: &str, home: &str, cwd: Option<&str>) -> Vec<Root> {
    use RootKind::*;
    // A Pane working in the home folder has no project folders of its own.
    let cwd = cwd.filter(|c| c.trim_end_matches('/') != home.trim_end_matches('/'));
    let mut out = Vec::new();
    match agent {
        "claude" => {
            out.push(root(
                Commands,
                format!("{home}/.claude/commands"),
                "user",
                "",
                None,
            ));
            if let Some(c) = cwd {
                out.push(root(
                    Commands,
                    format!("{c}/.claude/commands"),
                    "project",
                    "",
                    None,
                ));
            }
            out.push(root(
                Skills,
                format!("{home}/.claude/skills"),
                "skill",
                "",
                None,
            ));
            if let Some(c) = cwd {
                out.push(root(
                    Skills,
                    format!("{c}/.claude/skills"),
                    "skill",
                    "",
                    None,
                ));
            }
        }
        "pi" => {
            out.push(root(
                Prompts,
                format!("{home}/.pi/agent/prompts"),
                "user",
                "",
                None,
            ));
            out.push(root(
                Skills,
                format!("{home}/.pi/agent/skills"),
                "skill",
                "skill:",
                None,
            ));
            out.push(root(
                Skills,
                format!("{home}/.agents/skills"),
                "skill",
                "skill:",
                None,
            ));
        }
        "codex" => {
            out.push(root(
                Prompts,
                format!("{home}/.codex/prompts"),
                "user",
                "prompts:",
                None,
            ));
            out.push(root(
                Skills,
                format!("{home}/.codex/skills"),
                "skill",
                "",
                Some("$"),
            ));
            if let Some(c) = cwd {
                out.push(root(
                    Skills,
                    format!("{c}/.codex/skills"),
                    "skill",
                    "",
                    Some("$"),
                ));
            }
        }
        _ => {}
    }
    out
}

/// Skill and command roots of the Claude plugins turned on in settings.json.
pub fn plugin_roots(settings_json: &str, installed_json: &str) -> Vec<Root> {
    let parse = |s: &str| serde_json::from_str::<Value>(s).unwrap_or(Value::Null);
    let settings = parse(settings_json);
    let installed = parse(installed_json);
    let Some(enabled) = settings.get("enabledPlugins").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (id, on) in enabled {
        if on != &Value::Bool(true) {
            continue;
        }
        let Some(path) = installed
            .get("plugins")
            .and_then(|p| p.get(id))
            .and_then(|v| v.get(0))
            .and_then(|v| v.get("installPath"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let prefix = format!("{}:", id.split('@').next().unwrap_or(id));
        out.push(root(
            RootKind::Skills,
            format!("{path}/skills"),
            "plugin",
            &prefix,
            None,
        ));
        out.push(root(
            RootKind::Commands,
            format!("{path}/commands"),
            "plugin",
            &prefix,
            None,
        ));
    }
    out
}

const SCAN: &str = r#"
idx=0
for spec in "$@"; do
  kind=${spec%%:*}
  dir=${spec#*:}
  if [ -d "$dir" ]; then
    case $kind in
      skills)
        for f in "$dir"/*/SKILL.md; do
          [ -f "$f" ] || continue
          printf '\036%s\037%s\n' "$idx" "${f#"$dir"/}"
          head -c 4096 "$f"
        done ;;
      prompts)
        for f in "$dir"/*.md; do
          [ -f "$f" ] || continue
          printf '\036%s\037%s\n' "$idx" "${f#"$dir"/}"
          head -c 4096 "$f"
        done ;;
      commands)
        find -H "$dir" -type f -name '*.md' | while IFS= read -r f; do
          printf '\036%s\037%s\n' "$idx" "${f#"$dir"/}"
          head -c 4096 "$f"
        done ;;
    esac
  fi
  idx=$((idx+1))
done
"#;

const PLUGIN_FILES: &str = r#"cat "$1/.claude/settings.json" 2>/dev/null; printf '\036'; cat "$1/.claude/plugins/installed_plugins.json" 2>/dev/null"#;

fn sh(script: &str, args: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut argv: Vec<String> = vec!["sh".into(), "-c".into(), script.into(), "sh".into()];
    argv.extend(args);
    argv
}

fn command_name(kind: RootKind, rel: &str, markdown: &str) -> String {
    match kind {
        RootKind::Skills => skill_name(markdown, rel.split('/').next().unwrap_or(rel)),
        RootKind::Commands => rel.strip_suffix(".md").unwrap_or(rel).replace('/', ":"),
        RootKind::Prompts => rel.strip_suffix(".md").unwrap_or(rel).to_string(),
    }
}

/// An Agent's built-in Slash commands plus those found on the Machine, sorted by name.
pub async fn list_commands(
    t: &dyn Transport,
    agent: &str,
    home: &str,
    cwd: Option<&str>,
) -> AppResult<Vec<SlashCommand>> {
    let mut out = builtins(agent);
    if out.is_empty() {
        return Ok(out);
    }
    let mut all = roots(agent, home, cwd);
    if agent == "claude" {
        let o = exec(t, &sh(PLUGIN_FILES, [home.to_string()])).await?;
        let (settings, installed) = o.stdout.split_once('\x1e').unwrap_or((&o.stdout, ""));
        all.extend(plugin_roots(settings, installed));
    }
    if !all.is_empty() {
        let args = all.iter().map(|r| {
            let kind = match r.kind {
                RootKind::Skills => "skills",
                RootKind::Commands => "commands",
                RootKind::Prompts => "prompts",
            };
            format!("{kind}:{}", r.dir)
        });
        let o = exec(t, &sh(SCAN, args)).await?;
        for chunk in o.stdout.split('\x1e').skip(1) {
            let Some((idx, rest)) = chunk.split_once('\x1f') else {
                continue;
            };
            let Some((rel, markdown)) = rest.split_once('\n') else {
                continue;
            };
            let Some(r) = idx.parse::<usize>().ok().and_then(|i| all.get(i)) else {
                continue;
            };
            out.push(SlashCommand {
                name: format!("{}{}", r.prefix, command_name(r.kind, rel, markdown)),
                description: description(markdown),
                source: r.source,
                trigger: r.trigger,
            });
        }
    }
    out.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then(a.source.cmp(b.source))
            .then(a.trigger.cmp(&b.trigger))
    });
    // A user and a project skill of one name are one row; the sort is stable, so the user's stays.
    out.dedup_by(|b, a| a.name == b.name && a.source == b.source && a.trigger == b.trigger);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;
    use std::fs;
    use std::path::Path;

    fn write(p: &Path, s: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, s).unwrap();
    }
    fn find<'a>(c: &'a [SlashCommand], name: &str) -> &'a SlashCommand {
        c.iter().find(|x| x.name == name).unwrap_or_else(|| {
            panic!(
                "no {name} in {:?}",
                c.iter().map(|x| &x.name).collect::<Vec<_>>()
            )
        })
    }
    fn has(c: &[SlashCommand], name: &str) -> bool {
        c.iter().any(|x| x.name == name)
    }

    #[test]
    fn description_reads_frontmatter_then_body() {
        assert_eq!(
            description("---\nname: x\ndescription: \"Does X\"\n---\nbody"),
            "Does X"
        );
        assert_eq!(
            description("---\nname: x\n---\n\n# Title line\nmore"),
            "# Title line"
        );
        assert_eq!(description("plain first line\nsecond"), "plain first line");
        assert_eq!(description(&"y".repeat(300)).chars().count(), 120);
    }

    #[test]
    fn skill_name_prefers_a_valid_frontmatter_name() {
        assert_eq!(
            skill_name("---\nname: brainstorming\n---\n", "brain"),
            "brainstorming"
        );
        assert_eq!(skill_name("---\nname: has space\n---\n", "dir"), "dir");
        assert_eq!(skill_name("no frontmatter", "dir"), "dir");
    }

    #[test]
    fn plugin_roots_only_for_enabled_plugins_with_an_install_path() {
        let settings = r#"{"enabledPlugins":{"superpowers@market":true,"off@market":false,"lost@market":true}}"#;
        let installed = r#"{"plugins":{"superpowers@market":[{"installPath":"/p/sp"}],"off@market":[{"installPath":"/p/off"}]}}"#;
        let got: Vec<(String, String)> = plugin_roots(settings, installed)
            .into_iter()
            .map(|r| (r.dir, r.prefix))
            .collect();
        assert_eq!(
            got,
            vec![
                ("/p/sp/skills".to_string(), "superpowers:".to_string()),
                ("/p/sp/commands".to_string(), "superpowers:".to_string()),
            ]
        );
        assert!(plugin_roots("not json", installed).is_empty());
    }

    #[tokio::test]
    async fn lists_claude_builtins_commands_skills_and_plugins() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home dir");
        let cwd = tmp.path().join("proj");
        let plugin = home.join("plugin");
        write(
            &home.join(".claude/commands/deploy.md"),
            "---\ndescription: Ship it\n---\n",
        );
        write(
            &home.join(".claude/commands/git/sync.md"),
            "Sync branches\n",
        );
        write(&cwd.join(".claude/commands/local.md"), "Project cmd\n");
        write(
            &home.join(".claude/skills/brain/SKILL.md"),
            &format!(
                "---\nname: brainstorming\ndescription: Design first\n---\n{}",
                "x".repeat(8000)
            ),
        );
        write(
            &home.join(".claude/skills/.hidden/SKILL.md"),
            "---\nname: hidden\n---\n",
        );
        write(
            &plugin.join("skills/tdd/SKILL.md"),
            "---\ndescription: Red green\n---\n",
        );
        write(&plugin.join("commands/review.md"), "Review it\n");
        write(
            &home.join(".claude/settings.json"),
            r#"{"enabledPlugins":{"sp@m":true}}"#,
        );
        write(
            &home.join(".claude/plugins/installed_plugins.json"),
            &format!(
                r#"{{"plugins":{{"sp@m":[{{"installPath":"{}"}}]}}}}"#,
                plugin.display()
            ),
        );
        let got = list_commands(
            &LocalTransport,
            "claude",
            &home.to_string_lossy(),
            Some(&cwd.to_string_lossy()),
        )
        .await
        .unwrap();
        assert_eq!(find(&got, "compact").source, "builtin");
        assert_eq!(find(&got, "deploy").description, "Ship it");
        assert_eq!(find(&got, "deploy").source, "user");
        assert_eq!(find(&got, "git:sync").description, "Sync branches");
        assert_eq!(find(&got, "local").source, "project");
        assert_eq!(find(&got, "brainstorming").source, "skill");
        assert_eq!(find(&got, "brainstorming").description, "Design first");
        assert_eq!(find(&got, "sp:tdd").source, "plugin");
        assert_eq!(find(&got, "sp:review").description, "Review it");
        assert!(!has(&got, "hidden"));
        let names: Vec<&str> = got.iter().map(|c| c.name.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
    }

    #[tokio::test]
    async fn pi_and_codex_name_their_commands_their_own_way() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let cwd = tmp.path().join("proj");
        write(&home.join(".pi/agent/prompts/fix.md"), "Fix it\n");
        write(&home.join(".pi/agent/prompts/sub/deep.md"), "Too deep\n");
        write(
            &home.join(".pi/agent/skills/lint/SKILL.md"),
            "---\ndescription: Lint\n---\n",
        );
        write(
            &home.join(".agents/skills/web/SKILL.md"),
            "---\ndescription: Web\n---\n",
        );
        write(&home.join(".codex/prompts/plan.md"), "Plan it\n");
        write(
            &home.join(".codex/skills/doc/SKILL.md"),
            "---\ndescription: Docs\n---\n",
        );
        write(
            &cwd.join(".codex/skills/proj/SKILL.md"),
            "---\ndescription: Proj\n---\n",
        );
        let h = home.to_string_lossy();
        let c = cwd.to_string_lossy();

        let pi = list_commands(&LocalTransport, "pi", &h, Some(&c))
            .await
            .unwrap();
        assert_eq!(find(&pi, "fix").source, "user");
        assert_eq!(find(&pi, "skill:lint").source, "skill");
        assert_eq!(find(&pi, "skill:web").description, "Web");
        assert!(!has(&pi, "deep") && !has(&pi, "sub:deep"));
        assert_eq!(find(&pi, "settings").description, "Open settings menu");

        let codex = list_commands(&LocalTransport, "codex", &h, Some(&c))
            .await
            .unwrap();
        assert_eq!(find(&codex, "prompts:plan").source, "user");
        assert_eq!(find(&codex, "doc").trigger, Some("$"));
        assert_eq!(find(&codex, "proj").trigger, Some("$"));
        assert_eq!(find(&codex, "diff").trigger, None);
    }

    #[tokio::test]
    async fn follows_a_symlinked_commands_root() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        write(&tmp.path().join("dotfiles/cmds/deploy.md"), "Ship it\n");
        fs::create_dir_all(home.join(".claude")).unwrap();
        std::os::unix::fs::symlink(
            tmp.path().join("dotfiles/cmds"),
            home.join(".claude/commands"),
        )
        .unwrap();
        let got = list_commands(&LocalTransport, "claude", &home.to_string_lossy(), None)
            .await
            .unwrap();
        assert_eq!(find(&got, "deploy").source, "user");
    }

    fn count(c: &[SlashCommand], name: &str) -> usize {
        c.iter().filter(|x| x.name == name).count()
    }

    #[tokio::test]
    async fn a_skill_in_both_user_and_project_folders_is_listed_once() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let cwd = tmp.path().join("proj");
        write(
            &home.join(".claude/skills/foo/SKILL.md"),
            "---\ndescription: User foo\n---\n",
        );
        write(
            &cwd.join(".claude/skills/foo/SKILL.md"),
            "---\ndescription: Project foo\n---\n",
        );
        write(
            &home.join(".codex/skills/bar/SKILL.md"),
            "---\ndescription: User bar\n---\n",
        );
        write(
            &cwd.join(".codex/skills/bar/SKILL.md"),
            "---\ndescription: Project bar\n---\n",
        );
        let (h, c) = (home.to_string_lossy(), cwd.to_string_lossy());
        let claude = list_commands(&LocalTransport, "claude", &h, Some(&c))
            .await
            .unwrap();
        assert_eq!(count(&claude, "foo"), 1);
        assert_eq!(find(&claude, "foo").description, "User foo");
        let codex = list_commands(&LocalTransport, "codex", &h, Some(&c))
            .await
            .unwrap();
        assert_eq!(count(&codex, "bar"), 1);
    }

    #[tokio::test]
    async fn a_pane_in_the_home_folder_lists_each_command_once() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        write(&home.join(".claude/commands/deploy.md"), "Ship it\n");
        write(
            &home.join(".claude/skills/foo/SKILL.md"),
            "---\ndescription: Foo\n---\n",
        );
        let h = home.to_string_lossy();
        for cwd in [h.to_string(), format!("{h}/")] {
            let got = list_commands(&LocalTransport, "claude", &h, Some(&cwd))
                .await
                .unwrap();
            assert_eq!(count(&got, "deploy"), 1);
            assert_eq!(find(&got, "deploy").source, "user");
            assert_eq!(count(&got, "foo"), 1);
            assert!(got.iter().all(|c| c.source != "project"));
        }
    }

    #[tokio::test]
    async fn other_agents_have_no_commands() {
        let got = list_commands(&LocalTransport, "gemini", "/nonexistent", None)
            .await
            .unwrap();
        assert!(got.is_empty());
    }
}
