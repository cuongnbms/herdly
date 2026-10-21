//! Recognises the prompt pi sends when the user invokes a Skill.
use super::SkillUse;

const CHAINED_START: &str = "The user explicitly invoked the \"";
const CHAINED_MID: &str = "\" skill. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions.\n\n<skill-instruction name=\"";
const CHAINED_END: &str = "\n</skill-instruction>";
const REQUEST_START: &str = "\n\n<user-request>\n";
const REQUEST_END: &str = "\n</user-request>";
const LEGACY_START: &str = "<skill name=\"";
const LEGACY_END: &str = "\n</skill>";

/// Split `s` at the first `"`: the text before it, and the text after it.
fn until_quote(s: &str) -> Option<(&str, &str)> {
    s.split_once('"')
}

fn valid_name(n: &str) -> bool {
    (1..=200).contains(&n.chars().count()) && !n.contains(['\r', '\n', '<', '>'])
}

fn valid_path(p: &str) -> bool {
    (1..=4096).contains(&p.chars().count()) && !p.contains(['\r', '\n'])
}

/// Read the `P">\n` part shared by both forms: the location, then the rest after `">`.
fn location_and_rest(s: &str) -> Option<(&str, &str)> {
    let (path, rest) = until_quote(s)?;
    let rest = rest.strip_prefix(">\n")?;
    valid_path(path).then_some((path, rest))
}

/// The text after the body, which ends at the first `end`.
fn after_body<'a>(s: &'a str, end: &str) -> Option<&'a str> {
    s.split_once(end).map(|(_, r)| r)
}

/// One chained block at the start of `s`: the Skill and the text after the block.
fn chained_block(s: &str) -> Option<(SkillUse, &str)> {
    let s = s.strip_prefix(CHAINED_START)?;
    let (name, s) = until_quote(s)?;
    // `until_quote` already consumed the closing quote of the first name.
    let s = s.strip_prefix(&CHAINED_MID[1..])?;
    let s = s.strip_prefix(name)?;
    let s = s.strip_prefix("\" location=\"")?;
    let (path, s) = location_and_rest(s)?;
    let rest = after_body(s, CHAINED_END)?;
    valid_name(name).then(|| {
        (
            SkillUse {
                name: name.to_string(),
                path: path.to_string(),
            },
            rest,
        )
    })
}

fn parse_chained(text: &str) -> Option<(Vec<SkillUse>, String)> {
    let mut skills = vec![];
    let mut rest = text;
    loop {
        let (skill, after) = chained_block(rest)?;
        skills.push(skill);
        if after.is_empty() {
            return Some((skills, String::new()));
        }
        if let Some(request) = after
            .strip_prefix(REQUEST_START)
            .and_then(|r| r.strip_suffix(REQUEST_END))
        {
            return Some((skills, request.trim().to_string()));
        }
        rest = after.strip_prefix("\n\n")?;
    }
}

fn parse_legacy(text: &str) -> Option<(Vec<SkillUse>, String)> {
    let s = text.strip_prefix(LEGACY_START)?;
    let (name, s) = until_quote(s)?;
    let s = s.strip_prefix(" location=\"")?;
    let (path, s) = location_and_rest(s)?;
    let after = after_body(s, LEGACY_END)?;
    let request = if after.is_empty() {
        ""
    } else {
        after.strip_prefix("\n\n")?
    };
    valid_name(name).then(|| {
        (
            vec![SkillUse {
                name: name.to_string(),
                path: path.to_string(),
            }],
            request.trim().to_string(),
        )
    })
}

/// Recognise a pi Skill-invocation prompt. Returns the Skills and the user's request
/// (trimmed; empty when there is none). Anything that deviates from the format is None.
pub(crate) fn parse_skill_prompt(text: &str) -> Option<(Vec<SkillUse>, String)> {
    if text.starts_with(CHAINED_START) {
        parse_chained(text)
    } else {
        parse_legacy(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn block(n: &str, p: &str) -> String {
        format!("The user explicitly invoked the \"{n}\" skill. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions.\n\n<skill-instruction name=\"{n}\" location=\"{p}\">\n# {n}\nbody\n</skill-instruction>")
    }
    fn s(n: &str, p: &str) -> SkillUse {
        SkillUse {
            name: n.into(),
            path: p.into(),
        }
    }
    #[test]
    fn one_skill_with_request() {
        let t = format!(
            "{}\n\n<user-request>\nfix the bug\n</user-request>",
            block("review", "/h/.pi/skills/review/SKILL.md")
        );
        assert_eq!(
            parse_skill_prompt(&t),
            Some((
                vec![s("review", "/h/.pi/skills/review/SKILL.md")],
                "fix the bug".into()
            ))
        );
    }
    #[test]
    fn chained_skills_without_request() {
        let t = format!(
            "{}\n\n{}",
            block("a", "/a/SKILL.md"),
            block("b", "/b/SKILL.md")
        );
        assert_eq!(
            parse_skill_prompt(&t),
            Some((
                vec![s("a", "/a/SKILL.md"), s("b", "/b/SKILL.md")],
                "".into()
            ))
        );
    }
    #[test]
    fn legacy_form() {
        let t = "<skill name=\"tdd\" location=\"/t/SKILL.md\">\nbody\n</skill>\n\nwrite tests";
        assert_eq!(
            parse_skill_prompt(t),
            Some((vec![s("tdd", "/t/SKILL.md")], "write tests".into()))
        );
        let bare = "<skill name=\"tdd\" location=\"/t/SKILL.md\">\nbody\n</skill>";
        assert_eq!(
            parse_skill_prompt(bare),
            Some((vec![s("tdd", "/t/SKILL.md")], "".into()))
        );
    }
    #[test]
    fn near_misses_are_none() {
        assert_eq!(parse_skill_prompt("just text"), None);
        let mismatch = block("a", "/a/SKILL.md").replacen("name=\"a\"", "name=\"b\"", 1);
        assert_eq!(parse_skill_prompt(&mismatch), None);
        let trailing = format!("{}\n\nloose text", block("a", "/a/SKILL.md"));
        assert_eq!(parse_skill_prompt(&trailing), None);
        let unclosed = block("a", "/a/SKILL.md").replace("\n</skill-instruction>", "");
        assert_eq!(parse_skill_prompt(&unclosed), None);
        let chained_nobody = block("a", "/a/SKILL.md").replace("\n# a\nbody", "");
        assert_eq!(parse_skill_prompt(&chained_nobody), None);
        assert_eq!(parse_skill_prompt("<skill name=\"x\" location=\"/p\">\n</skill>"), None);
    }
    #[test]
    fn empty_body_with_blank_line_is_accepted() {
        let chained = block("a", "/a/SKILL.md").replace("# a\nbody", "");
        assert_eq!(parse_skill_prompt(&chained), Some((vec![s("a", "/a/SKILL.md")], "".into())));
        let legacy = "<skill name=\"x\" location=\"/p\">\n\n</skill>";
        assert_eq!(parse_skill_prompt(legacy), Some((vec![s("x", "/p")], "".into())));
    }
}
