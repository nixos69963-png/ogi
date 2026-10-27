# Working in `cli/`

This folder is a standalone Bun/TypeScript CLI. It is not part of the TanStack
app that surrounds it — no React, no Vite, no package ecosystem. The one
exception is the terminal: the full screen is built on OpenTUI (`@opentui/core`
plus its native win32-x64 renderer), and everything else stays hand-written.

## Commands

```bash
bun bin/agent.ts doctor          # is this machine able to run it
bun test                         # the suite; must pass before anything is called done
bun run typecheck                # strict tsc via the parent's node_modules
bun run check                    # both
```

There is no build step and no linter. `bun test` running green is the gate.

`bunfig.toml` keeps `projects/**` out of the test run. That folder is where the
agent puts what it built, and a generated `*_test.ts` in there is output — running
it, or counting its failures as ours, is not part of the gate.

## Rules of this codebase

- **One runtime dependency: the screen.** OpenTUI is the terminal renderer and
  nothing else. If another capability needs a package, it gets written by hand or
  it does not ship — that is why the CDP client is a WebSocket and GitHub is REST.
- **`resources/` is reference material.** Read it, never import from it, never
  edit it. The Python projects in there are someone else's code, kept as evidence
  for how this one was designed.
- **Modules import through subpath aliases** — `#core/*`, `#tools/*`,
  `#guard/*`, `#factory/*`, `#browser/*`, `#ui/*`, `#tui/*` — with an explicit
  `.ts` extension. Relative imports break the aliases and the tests.
- **A new tool is one file export plus three facts:** what it does, its
  `effect` (`read` / `compute` / `write` / `outward`), and a `describe` line for
  the approval prompt. Then it goes in `src/tools/index.ts`, gets a station
  share in `src/factory/plan.ts` if the line should have it, and gets a test.
- **Effect is a security claim, not a label.** Something that reaches a person or
  a system is `outward` and nothing may auto-approve it. When in doubt, grade it
  higher and say why in the tool's `description`.
- **The approval tier widens the project, never the floor.** `ask` · `auto` ·
  `full` decide how much of the `write` effect runs unasked; `describe()`'s `hard`
  is what does not, whatever the tier — reaching the machine, a file that cannot
  be re-created, a path outside the workspace. A new gate goes through `hard`,
  never through `risky`, because `auto` and `full` let `risky` writes through by
  design. Unattended, a gate is refused rather than assumed.
- **Every promise in the system brief is enforced somewhere else too** — the
  guard, the approver, the budget. Adding a rule to the prompt without a check
  that refuses is documentation, not safety.
- **Comments explain why, and only where the why is not obvious** (a constraint,
  a subtle invariant, a workaround). The header comment on each file is the
  design note for the next reader, including the failure it prevents.
- **Never put a secret in argv, a URL, or the log.** If a tool needs a credential
  it reads it from config once and passes it through the environment or a header.
- **The renderer shows actions, not the harness.** A tool prints as a `●` bullet —
  verb plus the one argument that names its target — and its answer prints under
  it as `⌄ ✓ 0.2s · +2 −1 · 91 chars`, with the diff rows after that for a file
  that changed. Budget notes, stuck warnings and compaction stay in history.
  `finish` prints no bullet — the caller prints the report once. Anything a
  result line should carry goes through `ToolResult.data`, not by parsing text.
  Colour and the ticking status line are TTY-only: `createRenderer({ sink })` is
  how a test reads the run in order, so new display code gets written against
  the sink first.
- **One row on the screen answers at a time.** The live tick line is owned by
  `terminal.ts` (`liveRowText`), and the prompt block draws it as its first row;
  anything that takes over the screen — `choose()` in `src/ui/select.ts`, the
  slash palette in `src/ui/input.ts` — borrows keys from the single hub in
  `src/ui/keys.ts` and the screen through `borrowScreen()`, then hands both back.
  Never add a second stdin listener, a second redraw of the prompt, or a
  `readline` question in the interactive path: a picker drawn over the ticking
  line is how an approval prompt becomes unreadable.
- **The full screen owns its rows, not the terminal.** `src/tui/` draws with the
  same verb table as the line UI (`verbFor`/`subjectOf`/`restCount` in
  `src/ui/render.ts`), but colour travels as `Segment { tone, text }` through
  `src/tui/rows.ts` — never an ANSI string parsed back out of `style`. The tones
  resolve to explicit ink (`RGBA.fromHex`) in that one file, so recolouring means
  editing the table there and nowhere else. **Ink, not blocks:** no `border` on a
  panel and no painted selection row. The pointer is the `❯` glyph and the chosen
  word takes its colour (`#b1b9f9`); separation is a grey hairline. Typing happens
  between two hairlines (`overbar`/`underbar`), the `/` and `@` lists open above
  them, the mode line below; a pane takes all three rows' place and brings its own
  single hairline, so the screen never carries a second set of rules. A tool prints
  as a green `●` with a bold white name and its answer hangs under a `⎿`; a line
  the operator typed keeps its own grey band. The only fills on the screen are that
  band, the `? question` chip, and the diff's `addedBg`/`removedBg`. Panel
  heights are arithmetic (chrome rows + a diff measured from the patch), with
  `flexShrink: 0` on every panel and the transcript as the only child allowed to
  shrink; a panel that negotiates its height with Yoga is how a footer ends up
  painted over the middle choice. Keys arrive through one global
  `renderer.keyInput` listener that `preventDefault()`s before the focused input
  sees them, and Ctrl+C is handled ahead of every pane so the stop button always
  works. Prove a screen with `createTestRenderer` + `captureCharFrame` and a
  scripted `transport`, as in `test/tui.test.ts`; `captureSpans` is how you assert
  ink (each span carries `fg`/`bg` as an `RGBA` buffer), which is how the
  no-blue-blocks rule is tested rather than trusted.

## Testing conventions

- No model, no token, no network. `test/helpers.ts` supplies a temp workspace and
  a scripted turn-player keyed by role; the scripted model records the tool list
  and brief each role received, which is how capability limits are proved.
- Anything with an approval path is tested both attended and unattended: the
  unattended case is where an `outward` call must come back refused.
- Bugs found in a live run get a regression test that fails without the fix. Run
  the test against the un-fixed file before believing it covers anything.
