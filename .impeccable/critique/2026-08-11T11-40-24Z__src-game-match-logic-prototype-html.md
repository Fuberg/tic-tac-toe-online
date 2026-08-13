---
target: match-logic.prototype.html
total_score: 30
max_score: 36
na_heuristics: 7
p0_count: 0
p1_count: 2
timestamp: 2026-08-11T11-40-24Z
slug: src-game-match-logic-prototype-html
---
Method: dual-agent (A: aad5ecab21946dfdd · B: a277c276644fe578a)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Board/status/log update on every action, but a vanish event isn't visually distinguished from a routine move |
| 2 | Match System / Real World | 4 | Human position labels (верх-лево, центр, etc.) instead of grid indices |
| 3 | User Control and Freedom | 2 | Switching scenario tabs silently wipes current free-play state, no confirm, no undo |
| 4 | Consistency and Standards | 4 | Icons/colors/log formatting consistent throughout |
| 5 | Error Prevention | 2 | Occupied cells are `disabled`, so the on-page instruction to "click a taken cell to see a rejection" is unreachable in free play |
| 6 | Recognition Rather Than Recall | 4 | Full mark-history queue with an "oldest" underline removes the need to remember move order |
| 7 | Flexibility and Efficiency | n/a | Single-session, single-use verification tool — no repeat-use path exists to optimize for |
| 8 | Aesthetic and Minimalist Design | 3 | Clean panels, but the payoff log line has no visual priority over routine move lines |
| 9 | Error Recovery | 4 | Illegal actions log in bold red with a plain-language reason |
| 10 | Help and Documentation | 4 | The question callout names the exact scenario tab that answers the stated question |
| **Total** | | **30/36** | **Good** |

Heuristic 7 scored n/a: this is a throwaway, single-sitting verification artifact with no return visits to optimize for, not a tool anyone will use repeatedly.

## Design Specificity Verdict

**LLM assessment**: Fully grounded, not category-interchangeable. The question callout quotes the exact CONTEXT.md rule (3-mark cap, removal-before-win-check, no draws, forfeit blocks rematch, rematch swaps sides), the reducer's log strings narrate that rule in plain Russian after every action, and all four scenario tabs are hand-built around the exact edge cases named in the brief — including one deliberately titled "Vanishing cancels an expected win," aimed at the specific intuition this prototype exists to correct. This could not be repointed at an unrelated feature without a rewrite.

**Deterministic scan**: `detect.mjs` returned exit 0 with one advisory finding: `em-dash-overuse` (11 em-dashes across the body text, file-level, no line anchor). This is worth treating as a likely false positive rather than an authored-by-AI signal — the copy is Russian, and the em dash is ordinary, idiomatic Russian punctuation (used for dialogue, apposition, and emphasis) at a much higher baseline rate than in English prose. Not actionable.

The static evidence pass caught one real gap Assessment A didn't flag: empty board-cell `<button>` elements (`match-logic.prototype.html:404-411`) render with empty `textContent` and rely only on a `title` attribute for identity — no `aria-label`. `title` isn't reliably exposed by all screen readers and never shows on touch. Everything else checked (inline `onclick`, non-button click handlers, `innerHTML` interpolation sources) came back clean — the five `.innerHTML =` call sites (lines 402, 426-427, 446-448, 554) all source from fixed internal enums or hardcoded scenario strings, not free text.

**Visual overlays**: Not available this run — no browser-automation tool (Playwright/Puppeteer/browser-canvas) was exposed in this session, so live injection and screenshot evidence were skipped. This is a fallback-signal gap, not a "clean" result; treat the visual read below as static-code review only, not confirmed on a rendered page.

## Overall Impression

This is a well-targeted verification prototype — its whole design is organized around making one specific rule debate resolvable by clicking through it, and mostly succeeds. The gap is that the artifact's single payoff moment (the vanish-then-recheck sequence in the "vanish" scenario) is buried in plain-gray log text indistinguishable from routine moves, and the free-play panel's own instructions point at an interaction (clicking an occupied cell) that the UI has disabled. For a throwaway tool whose only job is "make the answer to this question obvious," those two gaps blunt the answer.

## What's Working

- **Step-gated scenario walkthroughs** (`done`/`next`/locked buttons) force a deterministic, replayable sequence — exactly the trust property a logic-verification tool needs; nobody can click out of order and get a misleading result.
- **The marks-list "oldest" underline** appears the moment a player's queue hits 3, letting a reviewer predict the next vanish before it happens — this directly serves the tool's job of building correct intuition.
- **Clean separation of the pure logic module from the UI shell**, explicitly commented "lifts into the real codebase as-is" — smart scoping; the throwaway UI still produces reusable, hand-verified logic for the real implementation.

## Priority Issues

**[P1] Vanish events are invisible in the log and on the board**
Why it matters: the entire question this prototype exists to answer hinges on the moment a mark vanishes right before a win check. That moment currently renders as a plain-gray log line (`pushLog` never tags a `"vanish"` kind, unlike `"illegal"`/`"win"`), identical in weight to routine moves, and the board gives no transition on the emptied cell.
Fix: add a `vanish` log kind with its own color/weight, and toggle a brief highlight/fade class on the removed cell in `render()` when `removedCell != null`.
Suggested command: /impeccable delight (or /impeccable animate for the board transition specifically)

**[P1] The free-play panel's own instructions describe an interaction the UI has disabled**
Why it matters: `.scenario-desc` under "Свободная игра" tells the reviewer to click an occupied cell to see a rejection — but occupied cells are rendered `disabled` (`match-logic.prototype.html:409`), so no click event ever fires and the reducer's own illegal-move guard is unreachable outside the scripted "illegal" tab. A reviewer following the page's own advice sees nothing happen and may read it as a bug.
Fix: either stop disabling occupied cells and let the reducer reject the click (matching the described behavior), or rewrite the copy to point at the "illegal" scenario tab instead.
Suggested command: /impeccable clarify

**[P2] Switching scenario tabs silently discards current free-play state**
Why it matters: a reviewer experimenting freely in the "Свободная игра" panel loses that state with zero warning the moment they click any scenario tab — `startScenario()` unconditionally calls `createState()`. Looks like data loss, not an intentional reset.
Fix: at minimum, a one-line confirm or visible "this resets the board" cue on tab click.
Suggested command: /impeccable clarify

**[P2] The 13-step "vanish" scenario shows every future step label upfront, spoiling its own suspense**
Why it matters: the scenario description sets up "ждём победы по верхней строке..." as a moment of dramatic tension, but step 13's fully-visible label already tells the reviewer the eventual win happens on the left column — undercutting the exact "intuition gets overturned" beat the scenario exists to deliver.
Fix: keep only the current + next step label visible, or blur/collapse future step text until reached.
Suggested command: /impeccable distill

**[P3] Empty board-cell buttons have no accessible name**
Why it matters: cells render with empty `textContent` and only a `title` attribute (`match-logic.prototype.html:404-411`) to identify position — `title` isn't reliably read by screen readers or shown on touch. Low real-world stakes for a single-developer throwaway tool, but a one-line fix.
Fix: add `aria-label="${POS_LABEL[i]}"` alongside `title`.
Suggested command: /impeccable audit

## Persona Red Flags

**Riley (Stress Tester)**: Follows the free-play panel's own instruction to click an occupied cell — nothing happens, no rejection appears, because the button is `disabled`. Reads as a silent bug, not a documentation mismatch. Also loses all free-play board state instantly and without warning by clicking a scenario tab out of curiosity.

**Jordan (First-Timer)**: The page loads on "Быстрая победа," the one scenario where the vanishing-marks rule never actually triggers — not the "vanish" scenario the question callout explicitly points to as the critical case. A first-time reviewer has to notice and self-navigate to tab 2 despite the callout's own emphasis.

## Minor Observations

- Emoji-as-icons (⏱ 🔁 🆕) are a fine, low-effort choice at this throwaway scale — no need to invest in real iconography.
- "Match" (English loanword) sits inside otherwise all-Russian copy; presumably intentional domain terminology carried over from `CONTEXT.md` rather than an inconsistency.
- The em-dash-overuse detector finding (11 instances) is very likely a false positive for Russian-language body copy; no action needed.

## Questions to Consider

- If the payoff sentence ("Победа не засчитана — линия проверяется уже после исчезновения") is the entire answer to the question this prototype exists to answer, why does it read exactly like a routine move log line?
- Was the free-play "click an occupied cell" instruction ever actually tested before being written, given the button is `disabled`?
- Would a two-second fade on the vanishing cell communicate the rule in one glance better than the entire 13-step gated walkthrough does?
