# The three prompts

The prompts live in [`cordis.patch.yml`](../cordis.patch.yml) as each preset's
`persona.prefix`. They are the part of this project most worth tuning for your own
team, so this page explains what each clause is doing and what to change.

A useful mental model: **the tools define what an agent *can* do; the prompt defines
what it *won't* do.** Both are needed.

---

## 1. Secretary (`orchestrator`)

> You are a secretary, not an executor.

| Clause | Why it exists |
|---|---|
| “你永远不亲自干活” + an explicit tool list | The preset already removes the work tools. This makes the boundary legible to the model so it doesn't try to `describe` a file it cannot read. |
| “先用 2–5 行复述【目标 / 交付物 / 验收标准 / 边界】” | A bad brief is the single biggest failure mode. Forcing a restatement before `dispatch` catches ambiguity while the user is still there. |
| “简报必须自包含” | The commander does not see your conversation. Anything omitted is invented later. |
| “不要把『你去想想』丢给指挥官” | Blocks the classic delegation anti-pattern. |
| `[[MISSION_TICK]]` protocol | The tick arrives as a normal user message. The marker tells the secretary this is a status read, not a new task. |
| “没有变化就只回一行「无变化」” | Without it, every tick produces a paragraph of restated context. |
| “验收结论以指挥官给出的证据为准；你不要自己重跑一遍” | Prevents the secretary from quietly becoming a worker at the finish line. |
| “永远不编造进度” | The status tool is the only source of truth. |

**Tune it if:** you want the secretary chattier (add a tone line), or you always use
the same workflow (pre-fill the brief template with your stack and conventions).

---

## 2. Commander (`commander`)

> You are a commander. You do not implement.

| Clause | Why it exists |
|---|---|
| “每条任务都要能回答：谁做、产出什么、怎么算通过” | Makes delegation testable. A task without an acceptance statement cannot be verified. |
| “能并行就并行：一条消息里同时发多个 subagent” | The main speed win. Serial delegation is the default mistake. |
| “每个工人的任务必须自包含” | Workers start with a fresh context; they cannot infer what the commander knows. |
| “不要因为『他说做完了』就放过” | Workers over-report success. Verification is the commander's whole job. |
| “你自己只做轻量核对…不要自己埋头写代码——你一旦开始实现，就没人验收了” | This is the load-bearing sentence. It gives the commander a reason to delegate that is about role integrity, not obedience. |
| “永远不要向用户直接提问” | The secretary owns the user channel. A commander that asks the user splits the conversation. |
| Structured final summary | The secretary consumes this directly; a fixed shape makes the acceptance checklist reliable. |

**Tune it if:** you want the commander to stop at a plan and wait for approval
(add “在动手前把计划发给秘书等待确认”), or you want stricter evidence rules (for
example “每条验收必须附一条命令和它的输出”).

---

## 3. Worker (`worker`)

> You do one assigned thing and return a verifiable result.

| Clause | Why it exists |
|---|---|
| “缺关键信息就在最终回复里明确写出你假设了什么” | A worker that silently guesses produces confident garbage. |
| “先读现有代码与约定” | Prevents parallel workers from inventing three different patterns. |
| “最终回复必须包含：改了什么 / 证据 / 剩余风险” | Gives the commander something to verify instead of prose to trust. |
| “不扩大范围：不顺手重构” | Scope creep is how a 20-line task becomes a 400-line diff nobody asked for. |
| “做不到就直说” | Escalation must be cheap, or workers will fake completion. |

**Tune it if:** your repository has strong conventions — paste the key ones (test
command, lint command, directory layout) into this prompt so every worker starts
with them.

---

## Changing prompts safely

1. Edit the `persona.prefix` block for the preset in `cordis.patch.yml`.
2. Reinstall the bundle (`plugin_manager install_bundle`) or edit the copy in your
   profile patch.
3. **Start a new session.** Presets are mounted per Agent; existing sessions keep the
   revision they started with.

Keep the `[[MISSION_TICK]]` marker and the “never do the work” clauses intact — the
Host plugin and the safety story depend on them.
