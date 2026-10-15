// Screens and cases adapted from herdr-web-ui's server/prompt.test.ts (MIT, © 2026 devswha).
import { describe, expect, test } from "vitest";
import { answerKeys, cursorKeys, parseFallbackPrompt, parseInteractivePrompt, type ScreenPrompt } from "./screenPrompt";

const labels = (prompt: ScreenPrompt | null) => prompt?.options.map((option) => option.label);

describe("interactive prompt parsing", () => {
  test("parses Claude questions, approvals, and plans", () => {
    const questionScreen = `
☐ Dataset

Which evaluation dataset should we use?

❯ 1. LM-O
     Occlusion benchmark.
  2. YCB-V
     Household objects.
  3. T-LESS
     Texture-less objects.
  4. Type something.
────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
    const question = parseInteractivePrompt("claude", questionScreen);
    expect(question).toMatchObject({
      agent: "claude",
      kind: "question",
      // a single question is titled by its header chip
      title: "Dataset",
      question: "Which evaluation dataset should we use?",
      multi_select: false,
      custom_option_index: 3,
    });
    expect(labels(question)).toEqual(["LM-O", "YCB-V", "T-LESS"]);
    expect(question?.options[0]?.description).toBe("Occlusion benchmark.");
    expect(parseInteractivePrompt("claude", questionScreen)?.id).toBe(question?.id);

    const approval = parseInteractivePrompt("claude", `
Bash command

  curl -I https://example.com
  Fetch HTTP headers.

This command requires approval

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don’t ask again for: curl *
  3. No

Esc to cancel · Tab to amend · ctrl+e to explain
`);
    expect(approval?.kind).toBe("approval");
    expect(approval?.title).toBe("Fetch HTTP headers.");
    expect(labels(approval)).toEqual(["Yes", "Yes, and don’t ask again for: curl *", "No"]);

    const plan = parseInteractivePrompt("claude", `
Ready to code?

Here is Claude's plan:
Add a heading to the README file.

Claude has written up a plan and is ready to execute. Would you like to proceed?

❯ 1. Yes, auto-accept edits
  2. Yes, manually approve edits
  3. No, refine with Ultraplan on Claude Code on the web
  4. Tell Claude what to change
     shift+tab to approve with this feedback
`);
    expect(plan).toMatchObject({ kind: "plan", title: "Ready to code?", custom_option_index: 3 });
    expect(plan?.body).toContain("Add a heading");
    expect(answerKeys(plan!, { custom_text: "Keep the existing introduction" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] },
      { text: "Keep the existing introduction" },
      { keys: ["shift+tab"] },
    ]);
  });

  // screens captured from Claude Code 2.1.280 (paths shortened)
  test("parses Claude Code 2.1 question tabs, their review, and tool approvals without the old markers", () => {
    const first = parseInteractivePrompt("claude", `
←  ☐ Route  ☐ Author  ✔ Submit  →
Which way should the PR go?
❯ 1. Log in as owner
     Authenticate as the repository owner and open the PR directly on the repo.
  2. Fork
     Push the branch to a fork and open the PR from there.
  3. Type something.
────────────────────────────────────────
  4. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
    expect(first).toMatchObject({ kind: "question", title: "Route · 1 of 2", question: "Which way should the PR go?", custom_option_index: 2 });
    expect(labels(first)).toEqual(["Log in as owner", "Fork"]);

    const sets = parseInteractivePrompt("claude", `
←  ☒ Route  ☐ Sets  ✔ Submit  →
Which datasets?
❯ 1. [ ] LM-O
         Include the LM-O dataset.
  2. [ ] YCB-V
         Include the YCB-V dataset.
  3. [ ] T-LESS
         Include the T-LESS dataset.
  4. [ ] Type something
     Next
────────────────────────────────────────
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
    expect(sets).toMatchObject({ title: "Sets · 2 of 2", multi_select: true });
    // → moves on to the next tab: an enter there would pick its first option
    expect(answerKeys(sets!, { option_indices: [0, 2] })).toEqual([
      { keys: ["enter"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }, { keys: ["right"] },
    ]);

    const review = parseInteractivePrompt("claude", `
←  ☒ Route  ☒ Author  ✔ Submit  →
Review your answers
 ● Which way should the PR go?
   → Log in as owner
 ● Who should author the commits?
   → Repo owner
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel
`);
    // a menu: a typed pick submits every answer at once, so the chat asks for Confirm
    expect(review).toMatchObject({ kind: "menu", title: "Review your answers", question: "Ready to submit your answers?", custom_option_index: null });
    expect(review?.body).toContain("→ Repo owner");
    expect(labels(review)).toEqual(["Submit answers", "Cancel"]);

    const bash = parseInteractivePrompt("claude", `
● Deleting the junk directory
  ⎿  $ rm -rf junk
────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
   rm -rf junk
   Delete the junk directory
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp/prompt-lab/junk from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No
 Esc to cancel · Tab to amend
`);
    expect(bash).toMatchObject({ kind: "approval", title: "Bash command", question: "Do you want to proceed?", body: "rm -rf junk\nDelete the junk directory" });
    expect(labels(bash)).toEqual(["Yes", "Yes, and always allow access to /tmp/prompt-lab/junk from this project", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]);
    // a narrow pane wraps a long option: its label still reads whole
    const wrapped = parseInteractivePrompt("claude", `
────────────────────────────────────────
 Bash command
   rm -rf junk
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to
   /tmp/prompt-lab/junk from this project
   3. No
 Esc to cancel · Tab to amend
`);
    expect(labels(wrapped)).toEqual(["Yes", "Yes, and always allow access to /tmp/prompt-lab/junk from this project", "No"]);
    // Claude's own text opens with ● as well: a rule in its table is not the approval's panel
    const underText = parseInteractivePrompt("claude", `
● Results table follows:
────────────────────────────────────────
  run   AR
────────────────────────────────────────
  a     0.66
────────────────────────────────────────
 Bash command
   rm -rf junk
   Delete the junk directory
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 Esc to cancel · Tab to amend
`);
    expect(underText).toMatchObject({ kind: "approval", title: "Bash command", body: "rm -rf junk\nDelete the junk directory" });
    // an unattended session counts down to an auto-deny: the ticking clock is not a new prompt
    const countdown = (left: string) => parseInteractivePrompt("claude", `
────────────────────────────────────────
 Bash command
   rm -rf junk
   Delete the junk directory
 This shell -c script runs rm and could not be checked
 ⚠ Claude Code will automatically deny this request in ${left}, to avoid blocking progress on an unattended session
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 Esc to cancel · Tab to amend
`);
    expect(countdown("0:26")?.id).toBe(countdown("0:25")?.id);
    expect(countdown("0:26")?.body).toBe("rm -rf junk\nDelete the junk directory\nThis shell -c script runs rm and could not be checked");
    // an MCP call is a call too: the first rule under it opens the panel, not a rule in its preview
    const mcp = parseInteractivePrompt("claude", `
● github - create_issue (MCP)(title: "Flaky test")
────────────────────────────────────────
 Tool use
   github - create_issue(title: "Flaky test")
────────────────────────────────────────
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 Esc to cancel · Tab to amend
`);
    expect(mcp).toMatchObject({ kind: "approval", title: "Tool use" });
    expect(answerKeys(bash!, { option_index: 3 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);

    const write = parseInteractivePrompt("claude", `
● Write(hello.txt)
────────────────────────────────────────
 Create file
 hello.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1 hi
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create hello.txt?
 ❯ 1. Yes
   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)
   3. No
 Esc to cancel · Tab to amend
`);
    expect(write).toMatchObject({ kind: "approval", title: "Create file", question: "Do you want to create hello.txt?", body: "hello.txt\n1 hi" });
  });

  test("finds Claude's question tabs over a wrapped question and a cut-off bar, and never answers the next question", () => {
    // a narrow pane: the question wraps over seven lines and the bar loses its right end
    const wrapped = parseInteractivePrompt("claude", `
────────────────────────────
←  ☒ Route  ☐ Author  ✔ Su
Who should author the
commits that go into the
pull request, given that
the fork belongs to the
lab account and the
upstream repository to
its owner?
❯ 1. Keep local
     The local git identity.
  2. Repo owner
     The repository owner.
  3. Type something.
────────────────────────────
  4. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
    expect(wrapped).toMatchObject({
      kind: "question", title: "Author",
      question: "Who should author the commits that go into the pull request, given that the fork belongs to the lab account and the upstream repository to its owner?",
    });
    expect(answerKeys(wrapped!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);

    // a multiple choice alone: → reaches the review of the answers, which has its own card
    const alone = parseInteractivePrompt("claude", `
←  ☐ Sets  ✔ Submit  →
Which datasets?
❯ 1. [ ] LM-O
  2. [ ] YCB-V
  3. [ ] T-LESS
  4. [ ] Type something
     Submit
────────────────────────────
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`);
    expect(alone).toMatchObject({ title: "Sets", multi_select: true });
    expect(answerKeys(alone!, { option_indices: [1] })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }, { keys: ["right"] }]);
  });

  test("titles a Claude approval from its panel, not from rules in a file preview, and joins labels wrapped over lines", () => {
    const edit = parseInteractivePrompt("claude", `
● Write(notes.md)
────────────────────────────────────────
 Create file
 notes.md
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1 # Notes
  2 ────────────────────────────────────────
  3 Results below the rule
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create notes.md?
 ❯ 1. Yes
   2. Yes, and switch to accept edits
   (auto-approve file edits and common
   file commands) for this session
   3. No
 Esc to cancel · Tab to amend
`);
    expect(edit).toMatchObject({ kind: "approval", title: "Create file", question: "Do you want to create notes.md?" });
    expect(labels(edit)).toEqual([
      "Yes", "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session", "No",
    ]);
  });

  test("reads the same question through color escapes", () => {
    const plain = "☐ Pick\n\nWhich one?\n\n❯ 1. Alpha\n     First.\n  2. Beta\n  3. Type something.\n  4. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n";
    const colored = plain
      .replace("❯ 1. Alpha", "\x1b[38;5;153m❯\x1b[0m \x1b[1m1. Alpha\x1b[0m")
      .replace("First.", "\x1b[2mFirst.\x1b[22m")
      .replace("Enter to select", "\x1b[2mEnter to select");
    const a = parseInteractivePrompt("claude", plain);
    expect(a).toMatchObject({ question: "Which one?", options: [{ label: "Alpha", description: "First." }, { label: "Beta" }] });
    expect(parseInteractivePrompt("claude", colored)?.id).toBe(a?.id);
  });

  test("reads the question under a numbered list Claude printed above it", () => {
    const prompt = parseInteractivePrompt("claude", `
⏺ The plan:
  1. Route: app/api/geocode/route.ts.
  2. Proxy: next.config.ts.
  3. Logic: lib/geocode.ts.
  The branch will be feat/location-search.

────────────────────────────
←  ☐ No key  ☐ Enter  ✔ Submit  →

What should /api/geocode do without a key?

❯ 1. Open-Meteo only (Recommended)
     Still finds places.
  2. 503 MISSING_API_KEY
     Reports the missing config.
  3. Type something.
────────────────────────────
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
    expect(prompt).toMatchObject({ kind: "question", question: "What should /api/geocode do without a key?", custom_option_index: 2 });
    expect(prompt?.fallback).toBeUndefined();
    expect(labels(prompt)).toEqual(["Open-Meteo only (Recommended)", "503 MISSING_API_KEY"]);
  });

  test("ignores unknown agents and ordinary output", () => {
    expect(parseInteractivePrompt("other", "Enter to select · ↑/↓ to navigate · Esc to cancel")).toBeNull();
    expect(parseInteractivePrompt("claude", "No response requested. The task is complete.")).toBeNull();
  });
});

describe("Claude's question in a narrow pane", () => {
  // live-captured from Claude Code 2.1.283 in a 44-column herdr pane: the hint wraps
  const narrow = `────────────────────────────────────────────
 ☐ 재현 테스트

│ 재현용 테스트 질문입니다. 지금 이 질문
│ 화면을 백그라운드에서 캡처하고 있으니,
│ 15초쯤 기다렸다가 아무거나 골라 주세요.
│ 기다리는 동안 채팅 모드에 이 질문 카드가
│ 뜨는지도 봐 주시면 좋습니다.

❯ 1. 채팅에 카드가 안 떠요
     채팅 모드에 이 질문이 보이지 않음
  2. 채팅에 카드가 떠요
     채팅 모드에 이 질문이 카드로 보임
  3. Type something.
────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to
cancel
`;

  test("reads the question though its hint wrapped, and knows it is still open", () => {
    const prompt = parseInteractivePrompt("claude", narrow);
    expect(prompt).toMatchObject({
      kind: "question",
      title: "재현 테스트",
      options: [{ label: "채팅에 카드가 안 떠요" }, { label: "채팅에 카드가 떠요" }],
      custom_option_index: 2,
    });
    expect(prompt?.question).toMatch(/^재현용 테스트 질문입니다\./);
  });

  test("does not take an answered menu above later output for an open one", () => {
    expect(parseInteractivePrompt("claude", narrow + "\n● Done.\n\n> ")).toBeNull();
  });
});

describe("Claude's prompt over its background agents", () => {
  // Claude Code 2.1.289 with background agents running draws their panel under whatever owns
  // the screen's end, the prompt's hint included; its counters tick on every redraw (live)
  const agents = (seconds = 58) => `
  ⏺ main
  ◯ Explore  Checking set_passcode and PhoneNormalizable.normalize      5m ${seconds}s · ↓ 130.5k tokens
  ◯ Explore  Reading LimitService tier_limit resolution                 5m ${seconds}s · ↓ 165.5k tokens
`;
  const question = `
 ☐ Scope

Bạn muốn phạm vi cập nhật đến đâu?

❯ 1. Sửa cái đang có (Recommended)
     Cho 6 workflow + utils + load scripts chạy đúng với BE hiện tại.
  2. Sửa + viết workflow mới
     Như trên, thêm script cho tính năng mới của BE.
  3. Type something.
────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

  test("reads the question under the panel as it reads it without one, whatever the counters say", () => {
    const plain = parseInteractivePrompt("claude", question);
    const prompt = parseInteractivePrompt("claude", question + agents());
    expect(prompt).toMatchObject({ kind: "question", title: "Scope", question: "Bạn muốn phạm vi cập nhật đến đâu?", custom_option_index: 2, chat: true });
    expect(labels(prompt)).toEqual(["Sửa cái đang có (Recommended)", "Sửa + viết workflow mới"]);
    expect(prompt?.id).toBe(plain?.id);
    expect(parseInteractivePrompt("claude", question + agents(59))?.id).toBe(prompt?.id);
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("reads an approval under the panel", () => {
    const approval = parseInteractivePrompt("claude", `
Bash command

  curl -I https://example.com
  Fetch HTTP headers.

This command requires approval

Do you want to proceed?
❯ 1. Yes
  2. No

Esc to cancel · Tab to amend · ctrl+e to explain
${agents()}`);
    expect(approval?.kind).toBe("approval");
    expect(labels(approval)).toEqual(["Yes", "No"]);
  });

  test("still takes an answered question above later output for no prompt", () => {
    expect(parseInteractivePrompt("claude", `${question}\n● Done.\n\n> \n${agents()}`)).toBeNull();
  });
});

describe("Claude's unnumbered menus", () => {
  // Claude Code 2.1.285 on a folder it has not seen, as herdr's pane read shows it (live)
  const trust = (selected: 0 | 1 = 0, after = "") => `
❯ claude --model claude-haiku-4-5-20251001

────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 /home/user/projects/new-app

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ${selected === 0 ? "❯" : " "} No, exit
 ${selected === 1 ? "❯" : " "} Yes, I trust this folder

 Enter to confirm · Esc to cancel
${after}`;

  test("reads the folder-trust check as a menu with its question and both rows", () => {
    const prompt = parseInteractivePrompt("claude", trust())!;
    expect(prompt).not.toBeNull();
    expect(prompt.kind).toBe("menu");
    expect(prompt.title).toBe("Accessing workspace");
    expect(prompt.question).toBe("Is this a project you created or one you trust?");
    expect(labels(prompt)).toEqual(["No, exit", "Yes, I trust this folder"]);
    expect(prompt.body).toContain("Claude Code'll be able to read, edit, and execute files here.");
  });

  test("answers from the native cursor, and keeps its id when only the cursor moves", () => {
    const prompt = parseInteractivePrompt("claude", trust())!;
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    const moved = parseInteractivePrompt("claude", trust(1))!;
    expect(moved.id).toBe(prompt.id);
    expect(answerKeys(moved, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
    expect(() => answerKeys(prompt, { custom_text: "maybe" })).toThrow();
  });

  test("is gone once the menu is answered and Claude draws under it", () => {
    expect(parseInteractivePrompt("claude", trust(1, " ▐▛███▛█   Claude Code v2.1.285\n❯ Try \"fix typecheck errors\"\n"))).toBeNull();
  });

  test("keeps a label a narrow pane wrapped as one row", () => {
    // 24 columns: the panel's sentences and the second row both reach the edge and wrap
    const narrow = (selected: 0 | 1) => `
 Accessing workspace:

 Quick safety check: Is
 this a project you
 created or one you
 trust?

 ${selected === 0 ? "❯" : " "} No, exit
 ${selected === 1 ? "❯" : " "} Yes, I trust this
   folder

 Enter to confirm · Esc
 to cancel
`;
    const prompt = parseInteractivePrompt("claude", narrow(0))!;
    expect(labels(prompt)).toEqual(["No, exit", "Yes, I trust this folder"]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(labels(parseInteractivePrompt("claude", narrow(1)))).toEqual(["No, exit", "Yes, I trust this folder"]);
  });

  test("never takes the next row for a wrapped label when a row is the widest line", () => {
    // nothing else on screen reaches as far as the first row, so it says nothing of the pane's
    // width: the line under it may be its tail or the next row, and a guess answers the wrong row
    const two = (selected: 0 | 1) => `
 Trust?

 ${selected === 0 ? "❯" : " "} Yes, trust this folder and continue
 ${selected === 1 ? "❯" : " "} No, exit

 Enter to confirm · Esc to cancel
`;
    expect(parseInteractivePrompt("claude", two(0))).toBeNull();
    // with the cursor on it, the second line is a row for certain
    expect(labels(parseInteractivePrompt("claude", two(1)))).toEqual(["Yes, trust this folder and continue", "No, exit"]);
    // merged, this would show two options and answer the second with one Down, the real `Yes`
    const three = `
 Trust?

 ❯ No, exit and keep this folder untrusted
   Yes
   Yes, and allow hooks too

 Enter to confirm · Esc to cancel
`;
    expect(parseInteractivePrompt("claude", three)).toBeNull();
    const panel = ` Trust? The first row is not the widest line here, so this one tells the width.\n${three.slice(" Trust?\n".length + 1)}`;
    const prompt = parseInteractivePrompt("claude", panel);
    expect(labels(prompt)).toEqual(["No, exit and keep this folder untrusted", "Yes", "Yes, and allow hooks too"]);
    expect(answerKeys(prompt!, { option_index: 2 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("leaves numbered rows and a menu without one selected row to the other readers", () => {
    expect(parseInteractivePrompt("claude", "Pick one\n\n❯ 1. First\n  2. Second\n\nEnter to confirm · Esc to cancel\n")).toBeNull();
    expect(parseInteractivePrompt("claude", "Pick one\n\n  First\n  Second\n\nEnter to confirm · Esc to cancel\n")).toBeNull();
  });
});

describe("the fallback card for a blocked pane no reader knows", () => {
  test("offers a numbered menu at the screen's end as options answered by their number", () => {
    const prompt = parseFallbackPrompt("gjc", `
 Apply these 3 file changes?
 src/a.ts, src/b.ts, src/c.ts

 › 1. Apply all
   2. Review each
   3. Discard

 ↵ choose · esc back
`);
    expect(prompt.kind).toBe("menu");
    expect(prompt.fallback).toBe(true);
    expect(prompt.question).toBe("Apply these 3 file changes?");
    expect(prompt.body).toBe("src/a.ts, src/b.ts, src/c.ts");
    expect(labels(prompt)).toEqual(["Apply all", "Review each", "Discard", "Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ text: "3" }]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ text: "1" }]);
    expect(() => answerKeys(prompt, { custom_text: "no" })).toThrow();
  });

  test("offers Enter and Esc after the rows, for a program that reads a whole line", () => {
    const prompt = parseFallbackPrompt("gjc", "Pick a profile:\n1. Work\n2. Home\n\nEnter a number >\n");
    expect(labels(prompt)).toEqual(["Work", "Home", "Enter", "Esc"]);
    // the number goes alone; the Enter that submits it is its own tap
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ text: "2" }]);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 3 })).toEqual([{ keys: ["esc"] }]);
  });

  test("joins the lines the last row wraps onto into its label", () => {
    const prompt = parseFallbackPrompt("gjc", "Trust this folder?\n\n❯ 1. No, exit\n  2. Yes, trust folder and\n     allow all commands without asking\n\n Enter to confirm\n");
    expect(labels(prompt)).toEqual(["No, exit", "Yes, trust folder and allow all commands without asking", "Enter", "Esc"]);
  });

  test("reads no menu when the last row's wrapped label ends in its own letter key", () => {
    const prompt = parseFallbackPrompt("gjc", "Access?\n1. Read only\n2. Full access, every file and\n   command (f)\n\nEnter to select\n");
    expect(labels(prompt)).toEqual(["Enter", "Esc"]);
    // or ends the row's first line, a description wrapped under it
    expect(labels(parseFallbackPrompt("gjc", "Access?\n1. Cancel\n2. Full access (f)\n   Allows writing to every file\n\nType f, then Enter\n"))).toEqual(["Enter", "Esc"]);
  });

  test("takes the last line for a hint only when it names a way to choose", () => {
    const menu = (hint: string) => labels(parseFallbackPrompt("gjc", `Pick one:\n1. Alpha\n2. Beta\n\n${hint}\n`));
    // a plain Enter or Press asks for something else: a digit typed there is no answer
    for (const hint of ["Enter recovery code", "Enter your password", "Enter your phone number", "Press any key", "Enter to continue"]) {
      expect(menu(hint)).toEqual(["Enter", "Esc"]);
    }
    expect(labels(parseFallbackPrompt("gjc", "1. A\n2. B\nEnter recovery code\n"))).toEqual(["Enter", "Esc"]);
    for (const hint of ["Enter to select", "↵ choose · esc back", "Enter to confirm · Esc to cancel", "Enter a number", "Type 1-2", "↑/↓ to move", "Tab/arrows to navigate"]) {
      expect(menu(hint)).toEqual(["Alpha", "Beta", "Enter", "Esc"]);
    }
  });

  test("reads no menu unless its hint is the screen's last line, with only the last row's wrap above it", () => {
    // a new prompt under the hint takes what is typed now: a digit there is no menu answer
    expect(labels(parseFallbackPrompt("gjc", "Pick:\n1. Read only\n2. Full access\nEnter to select\nEnter recovery code ABCD\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Pick:\n1. Read only\n2. Full access\n\nEnter to select\nWaiting for the token\n"))).toEqual(["Enter", "Esc"]);
    // a line under the last row, not indented past its number, is not its wrap
    expect(labels(parseFallbackPrompt("gjc", "Pick:\n  1. Read only\n  2. Full access\n  Saved.\nEnter to select\n"))).toEqual(["Enter", "Esc"]);
    // nor a hint inside the last row's wrap, with a new prompt under it
    expect(labels(parseFallbackPrompt("gjc", "Done:\n1. Read settings\n2. Load profiles\n   Profiles loaded\n   Enter to continue\nEnter recovery code ABCD\n"))).toEqual(["Enter", "Esc"]);
    // nor an input field there, or more output than a wrapped label
    expect(labels(parseFallbackPrompt("gjc", "Done:\n1. Load configuration\n2. Connect to account\n   Authentication required\n   Password:\nEnter password and press Enter\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Done:\n1. Load configuration\n2. Connect to account\n   Connected to example.com\n   Authentication required\n   Waiting\nEnter to continue\n"))).toEqual(["Enter", "Esc"]);
    // a wrapped label's own words are no hint
    expect(labels(parseFallbackPrompt("gjc", "Access?\n1. Cancel\n2. Allow access to the\n   selected account number only\n\nEnter to select\n"))).toEqual(["Cancel", "Allow access to the selected account number only", "Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Where?\n1. Here\n2. Allow the agent to\n   choose a directory\n\nEnter to select\n"))).toEqual(["Here", "Allow the agent to choose a directory", "Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Retry?\n1. Never\n2. Retry with a maximum\n   attempt count: 3\n\nEnter to select\n"))).toEqual(["Never", "Retry with a maximum attempt count: 3", "Enter", "Esc"]);
    // a hint right under the last row, indented like its wrap, is still the hint
    expect(labels(parseFallbackPrompt("gjc", "Pick a profile:\n1. Work\n2. Home\n   Enter a number >\n"))).toEqual(["Work", "Home", "Enter", "Esc"]);
  });

  test("keeps a wrapped label on its own row, since each row starts with its number", () => {
    const prompt = parseFallbackPrompt("gjc", "Trust this folder?\n\n❯ 1. No, exit and keep this folder\n     untrusted\n  2. Yes, trust folder\n  3. Yes, trust and allow hooks\n\n Enter to confirm\n");
    expect(labels(prompt)).toEqual(["No, exit and keep this folder untrusted", "Yes, trust folder", "Yes, trust and allow hooks", "Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ text: "2" }]);
  });

  test("guesses no options for an unnumbered menu, offering the keys its hint names", () => {
    const prompt = parseFallbackPrompt("claude", "Continue?\n\n  Yes\n❯ No\n  Later\n\n ↑/↓ to move · Enter to choose\n");
    expect(prompt.title).toBe("Waiting for input");
    expect(prompt.question).toBe("Continue?");
    expect(labels(prompt)).toEqual(["↑", "↓", "Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }]);
  });

  test("reads no menu once a new prompt or input box follows it", () => {
    const done = parseFallbackPrompt("claude", "Pick one\n\n  1. Deny\n❯ 2. Allow\n\n● Done.\n❯ \n");
    expect(labels(done)).toEqual(["Enter", "Esc"]);
    const quoted = parseFallbackPrompt("claude", "> quoted example\n❯ Deny\n  Allow all\n");
    expect(labels(quoted)).toEqual(["Enter", "Esc"]);
  });

  test("reads a numbered list as no menu without a hint to choose, or before an input field", () => {
    expect(labels(parseFallbackPrompt("gjc", "My plan:\n\n1. Inspect files\n2. Remove backups\n\nPassword:\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Pick:\n1. A\n2. B\nEnter a number\nChoice: 2\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Access?\n1. Read only (r)\n2. Full access (f)\nType r or f, then Enter\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Pick\n1. One\n❯ \n2. Two\nEnter to select\n"))).toEqual(["Enter", "Esc"]);
  });

  test("offers no letters or arrows for an input box, a quote or a word", () => {
    expect(labels(parseFallbackPrompt("claude", 'The installer prints "Overwrite? (y/n)".\n❯ \n'))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("claude", "Done.\n❯ Explain why the installer asks (y/n)\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("claude", "Use arrow functions in the patch.\nArrowhead metadata loaded\n"))).toEqual(["Enter", "Esc"]);
  });

  test("without a menu, shows the screen's last lines and offers Enter and Esc", () => {
    const prompt = parseFallbackPrompt("codex", "Working on it\n\nPress any key to review the diff (q to quit)\n");
    expect(prompt.title).toBe("Waiting for input");
    expect(prompt.question).toBe("Press any key to review the diff (q to quit)");
    expect(prompt.body).toContain("Working on it");
    expect(labels(prompt)).toEqual(["Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["esc"] }]);
  });

  test("offers a (y/n) question at the screen's end as Yes and No, typing the letter alone", () => {
    const prompt = parseFallbackPrompt("gjc", " config.json already exists.\n Overwrite it? (y/n)\n Press Enter to keep it, or Esc to abort\n");
    expect(prompt.question).toBe("Overwrite it? (y/n)");
    expect(labels(prompt)).toEqual(["Yes (y)", "No (n)", "Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ text: "y" }]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ text: "n" }]);
    expect(labels(parseFallbackPrompt("gjc", "Delete the branch? [Y/n] "))).toEqual(["Yes (y)", "No (n)", "Enter", "Esc"]);
  });

  test("offers no letters for a (y/n) only mentioned above the prompt", () => {
    const prompt = parseFallbackPrompt("codex", 'The installer prints "Overwrite config? (y/n)".\nIt then exits.\n\n› Ask Codex to do anything\n  100% context left\n');
    expect(labels(prompt)).toEqual(["Enter", "Esc"]);
  });

  test("takes the question from the line that asks it, not the hint below", () => {
    const prompt = parseFallbackPrompt("gjc", "Found 3 stale caches.\nClear them now?\nPress Enter to continue, Esc to skip\n");
    expect(prompt.question).toBe("Clear them now?");
    expect(prompt.body).toBe("Found 3 stale caches.\nPress Enter to continue, Esc to skip");
    expect(labels(prompt)).toEqual(["Enter", "Esc"]);
  });

  test("gives the same id to the same screen, and another to a changed one", () => {
    const screen = "Pick\n\n❯ 1. One\n  2. Two\n\n Enter to select\n";
    expect(parseFallbackPrompt("omo", screen).id).toBe(parseFallbackPrompt("omo", screen).id);
    expect(parseFallbackPrompt("omo", screen.replace("Two", "Three")).id).not.toBe(parseFallbackPrompt("omo", screen).id);
    const context = (command: string) => [`$ ${command}`, ...Array.from({ length: 14 }, (_, i) => `line ${i}`), "Run it?", "", "❯ 1. Yes", "  2. No", "", " Enter to select"].join("\n");
    expect(parseFallbackPrompt("gjc", context("rm -rf important")).id).not.toBe(parseFallbackPrompt("gjc", context("rm safe.tmp")).id);
    const keys = (command: string) => [`$ ${command}`, ...Array.from({ length: 18 }, (_, i) => `line ${i}`), "Proceed? (y/n)"].join("\n");
    expect(parseFallbackPrompt("gjc", keys("rm -rf important")).id).not.toBe(parseFallbackPrompt("gjc", keys("rm safe.tmp")).id);
    const footer = (end: string) => `Pick\n\n❯ 1. One\n  2. Two\n\n ${end}\n`;
    expect(parseFallbackPrompt("gjc", footer("Enter to select")).id).not.toBe(parseFallbackPrompt("gjc", footer("Enter to select · done")).id);
  });
});

// Screens captured from pi 0.87.1 running /model, at 140 columns and at 46 (herdr-web-ui).
describe("pi's model picker", () => {
  const FOOTER = "\n────────────────────────────────────────\n/tmp/app\n0.0%/215k (auto)                                        some-model • medium\n";
  const MODEL_HINT = " Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel";
  const wide = `────────────────────────────────────────

Only showing models from configured providers. Use /login to add providers.
>

→ ✓ vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default
    vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]
Could not refresh llama.cpp; showing cached models.
${MODEL_HINT}
────────────────────────────────────────${FOOTER}`;

  test("reads the catalogue as a question naming the model in use", () => {
    const prompt = parseInteractivePrompt("pi", wide)!;
    expect(prompt).toMatchObject({
      agent: "pi",
      kind: "question",
      question: "Select model (currently vllm/Qwen/Qwen3.8-27B [lwsa-platform])",
      multi_select: false,
      custom_option_index: null,
    });
    // pi's note under the rows is no model
    expect(labels(prompt)).toEqual(["vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default", "vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]"]);
    // the cursor is on the first row: one down picks the second
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
  });

  test("navigates up from where pi drew the cursor", () => {
    const moved = wide.replace(
      "→ ✓ vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default\n    vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]",
      "  ✓ vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default\n→ vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]",
    );
    const prompt = parseInteractivePrompt("pi", moved)!;
    expect(prompt.question).toBe("Select model (currently vllm/Qwen/Qwen3.8-27B [lwsa-platform])");
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
  });

  test("asks plainly when no row carries the tick", () => {
    expect(parseInteractivePrompt("pi", wide.replace("→ ✓ vllm", "→ vllm"))?.question).toBe("Select model");
  });

  test("is read only for pi", () => {
    expect(parseInteractivePrompt("claude", wide)).toBeNull();
  });

  test("ignores rows above the filter line, left from before /model", () => {
    const earlier = wide.replace(
      "Only showing models",
      "→ old-model [stale-provider]\n    other-model [stale-provider]\n\nOnly showing models",
    );
    expect(labels(parseInteractivePrompt("pi", earlier))).toEqual(labels(parseInteractivePrompt("pi", wide)));
  });

  test("voids the reading when a row is cut inside its provider bracket", () => {
    const cut = wide.replace("Could not refresh", "    another-model [provider-\nCould not refresh");
    expect(parseInteractivePrompt("pi", cut)).toBeNull();
    const half = `────────────────────────

>

→ ✓ vllm/Qwen/Qwen3.8-27B [lwsa-
    vllm-flash/Qwen3.8-Flash-Next
${MODEL_HINT}
────────────────────────${FOOTER}`;
    expect(parseInteractivePrompt("pi", half)).toBeNull();
  });

  test("needs two rows and a cursor", () => {
    expect(parseInteractivePrompt("pi", wide.replace("    vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]\n", ""))).toBeNull();
    expect(parseInteractivePrompt("pi", wide.replace("→ ✓ vllm/Qwen", "  ✓ vllm/Qwen"))).toBeNull();
  });

  const narrow = `──────────────────────────────

Only showing models from configured providers.
Use /login to add providers.
>

→ ✓ vllm-flash/Qwen3.8-Flash-Next
[lwsa-platform] · default
    vllm/Qwen/Qwen3.8-27B [lwsa-platform]

  Model Name: qwen-3-8-flash

  Refreshing model catalogs…

  Enter to select · Ctrl+S to set as default ·
Escape/Ctrl+C to cancel
──────────────────────────────
/tmp/pn
0.0%/215k (auto)  vllm-flash/Qwen3.8-Flash-Nex
`;

  test("joins the rows and the hint a narrow pane wraps", () => {
    const prompt = parseInteractivePrompt("pi", narrow)!;
    expect(labels(prompt)).toEqual(["vllm-flash/Qwen3.8-Flash-Next [lwsa-platform] · default", "vllm/Qwen/Qwen3.8-27B [lwsa-platform]"]);
    expect(prompt.question).toBe("Select model (currently vllm-flash/Qwen3.8-Flash-Next [lwsa-platform])");
  });

  test("goes stale once the hint is buried under later output", () => {
    expect(parseInteractivePrompt("pi", `${narrow}Some later output\nand more\n`)).toBeNull();
  });
});

describe("Claude's question with previews", () => {
  // live-captured from Claude Code 2.1.289: an AskUserQuestion whose options carry a `preview`
  // draws the options on the left, the cursor option's preview boxed on the right, a notes line
  // under it, and "Chat about this" unnumbered under a rule; there is no "Type something." row
  const previews = [
    ["+------------------------+", "| o  09:00  Started      |", "| |                      |", "| o  09:15  Building     |", "+------------------------+"],
    ["+------------------------+", "| ( Started   09:00 )    |", "|                        |", "| ( Done      09:30 )    |", "+------------------------+"],
    ["+------------------------+", "| Started         09:00  |", "| Done            09:30  |", "|                        |", "+------------------------+"],
  ];
  const rows = ["Timeline (Recommended)", "Card / pill", "Minimal"];
  const screenWith = ({ cursor = 0, chat = false, notes = "press n to add notes", editing = false } = {}) => {
    const box = previews[cursor]!.map((line) => `│ ${line}               │`);
    const right = ["┌──────────────────────────────────────────┐", ...box, "└──────────────────────────────────────────┘"];
    const left = rows.map((label, i) => `${i === cursor ? "❯" : " "} ${i + 1}. ${label}`);
    const body = right.map((line, i) => `${(left[i] ?? "").padEnd(34)}${line}`);
    return `
────────────────────────────────────────────────────────────────────────────────
 ☐ Style

Pick a layout?

${body.join("\n")}

                                  Notes: ${notes}

────────────────────────────────────────────────────────────────────────────────
${chat ? "❯" : " "} Chat about this

Enter to select · ↑/↓ to navigate · n to add notes · ${editing ? "ctrl+g to edit in Nvim · " : ""}Esc to cancel
`;
  };

  test("reads the options from the left column and the cursor option's preview from the box", () => {
    const prompt = parseInteractivePrompt("claude", screenWith({ cursor: 1 }));
    expect(prompt).toMatchObject({
      kind: "question", title: "Style", question: "Pick a layout?", multi_select: false,
      custom_option_index: null, chat: true, notes: true,
      preview: { index: 1, text: previews[1]!.join("\n") },
    });
    expect(labels(prompt)).toEqual(rows);
    expect(prompt?.options.every((option) => option.description === null)).toBe(true);
  });

  test("keeps its id while the cursor, and so the preview, moves", () => {
    const first = parseInteractivePrompt("claude", screenWith({ cursor: 0 }));
    expect(parseInteractivePrompt("claude", screenWith({ cursor: 2 }))?.id).toBe(first?.id);
    expect(parseInteractivePrompt("claude", screenWith({ chat: true }))?.id).toBe(first?.id);
  });

  test("moves the cursor onto an option to show its preview, from the cursor's row or Chat about this", () => {
    const prompt = parseInteractivePrompt("claude", screenWith({ cursor: 1 }))!;
    expect(cursorKeys(prompt, 0)).toEqual(["up"]);
    expect(cursorKeys(prompt, 2)).toEqual(["down"]);
    expect(cursorKeys(prompt, 1)).toEqual([]);
    expect(cursorKeys(prompt, 3)).toBeNull();
    expect(cursorKeys(parseInteractivePrompt("claude", screenWith({ chat: true }))!, 0)).toEqual(["up", "up", "up"]);
    // a question without previews has no preview to show
    const plain = `
☐ Dataset

Which dataset?

❯ 1. LM-O
  2. YCB-V
  3. Type something.
────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
    expect(cursorKeys(parseInteractivePrompt("claude", plain)!, 1)).toBeNull();
  });

  test("answers an option, with notes, and Chat about this, from the cursor", () => {
    const prompt = parseInteractivePrompt("claude", screenWith({ cursor: 1 }))!;
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 0, notes: " keep it\nshort " })).toEqual([
      { keys: ["up"] }, { keys: ["n"] }, { text: "keep it short" }, { keys: ["enter"] },
    ]);
    expect(answerKeys(prompt, { chat: true })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
    expect(() => answerKeys(prompt, { custom_text: "x" })).toThrow();
  });

  test("counts from Chat about this when the cursor is there, though the last option keeps its ❯", () => {
    const prompt = parseInteractivePrompt("claude", screenWith({ cursor: 2, chat: true }))!;
    expect(prompt.preview?.index).toBe(2);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt, { chat: true })).toEqual([{ keys: ["enter"] }]);
  });

  test("leaves a screen whose notes are being typed to the fallback, where keys would type into them", () => {
    expect(parseInteractivePrompt("claude", screenWith({ notes: "Add notes on this design…", editing: true }))).toBeNull();
    expect(parseInteractivePrompt("claude", screenWith({ notes: "hello" }))).toBeNull();
  });

  test("reads a preview a narrow pane wrapped inside its box", () => {
    // live-captured in a 70-column pane
    const narrow = `
 ☐ Style

Pick a layout?

❯ 1. Timeline (Recommended)       ┌──────────────────────────────────┐
  2. Card / pill                  │ +------------------------------- │
  3. Minimal                      │ -------+                         │
                                  │ | o 09:00  Started session       │
                                  │        |                         │
                                  └──────────────────────────────────┘

                                  Notes: press n to add notes

──────────────────────────────────────────────────────────────────────
  Chat about this

Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel
`;
    const prompt = parseInteractivePrompt("claude", narrow);
    expect(labels(prompt)).toEqual(rows);
    expect(prompt?.preview).toEqual({ index: 0, text: "+-------------------------------\n-------+\n| o 09:00  Started session\n       |" });
  });

  test("offers Chat about this on a plain single question too", () => {
    const prompt = parseInteractivePrompt("claude", `
☐ Route

Which way?

  1. Log in
❯ 2. Fork
  3. Type something.
────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`)!;
    expect(prompt).toMatchObject({ chat: true });
    expect(prompt.notes).toBeUndefined();
    expect(answerKeys(prompt, { chat: true })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
    expect(() => answerKeys(prompt, { option_index: 0, notes: "x" })).toThrow();
  });
});
