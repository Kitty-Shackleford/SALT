# Reference Table Contract (UI modernization card 5/9)

`/server-players` is the reference table page: server context + search/filter/sort
+ pagination + dense table. Cards 6/7 (and any later table page) adopt this
contract instead of copy-paste.

Audit decision: a grep of `public/` shows many pages contain `<table>`, but none
share identical markup (every table is bespoke), so the extraction is a **shared
CSS block**, not a shared JS component. The block lives in
`public/css/shell.css` ("Reference table contract" section). Every shell page
already loads `shell.css`; a non-shell page adds
`<link rel="stylesheet" href="/css/shell.css">` between `theme.css` and
`tailwind.css`.

## Markup skeleton

```html
<div class="dzc-table-wrap">
  <table class="dzc-table">
    <thead>
      <tr>
        <!-- sortable column -->
        <th scope="col" data-sort="col" aria-sort="none">
          <button type="button" class="dzc-sort">Column
            <span class="dzc-sort-dir" aria-hidden="true"></span></button>
        </th>
        <!-- plain column -->
        <th scope="col">Plain</th>
      </tr>
    </thead>
    <tbody>
      <tr class="dzc-row">
        <td data-label="Column">value</td>
        <td data-label="Plain" class="dzc-num">42</td>
        <!-- row actions, last column -->
        <td data-label="Actions">
          <div class="dzc-row-actions">
            <button class="dzc-btn">Quiet</button>
            <button class="dzc-btn is-danger">Destructive</button>
          </div>
        </td>
      </tr>
      <!-- state rows replace all body rows while loading/empty/error -->
      <tr class="dzc-state-row"><td colspan="N">Loading…</td></tr>
      <tr class="dzc-state-row is-error"><td colspan="N">❌ …</td></tr>
    </tbody>
  </table>
  <div class="dzc-table-foot">
    <span>1–50 of 1,234</span>
    <div class="flex items-center gap-1 ml-auto">
      <button class="dzc-btn" disabled aria-label="First page">«</button>
      <button class="dzc-btn" disabled aria-label="Previous page">‹</button>
      <span class="dzc-page-ind">Page 1 / 25</span>
      <button class="dzc-btn" aria-label="Next page">›</button>
      <button class="dzc-btn" aria-label="Last page">»</button>
    </div>
    <span class="dzc-freshness" aria-live="polite">updated 12s ago</span>
  </div>
</div>
```

## Class inventory

| Class | Role |
| --- | --- |
| `.dzc-table-wrap` | Bordered, rounded surface; keeps the sticky header inside the card. |
| `.dzc-table` | 13px body, `border-collapse`. |
| `thead th` | Sticky under the shell topbar (`.dzc-shell .dzc-table thead th`), 8–9px padding, 11px uppercase muted label. |
| `.dzc-sort` / `.dzc-sort-dir` | Sort interaction lives on the `<button>` (keyboard focus, `:focus-visible` ring); the `<th>` carries `aria-sort="none\|ascending\|descending"` — update both from one place. |
| `.dzc-num` | Right-aligned, `font-variant-numeric: tabular-nums`. Use for every numeric column. |
| `.dzc-muted` / `.dzc-faint` | Secondary / tertiary text (12px muted, faint). |
| `.dzc-row` | Data row: hover fill, `.is-selected` = `--dzc-accent-soft` fill + inset 2px accent bar on the first cell. Selection is exclusive; re-click clears. |
| `.dzc-state-row` | Loading / empty / error row (one full-width row, `colspan`). `.is-error` switches to `--dzc-danger`. |
| `.dzc-badge` (+ `.is-danger`, `.is-warn`) | Compact pill: platform, ALT, review confidence. |
| `.dzc-btn` (+ `.is-danger`, `.is-warn`, `.is-stat`) | Quiet icon+label button. Row actions go in a right-aligned `.dzc-row-actions`. Destructive = `.is-danger` — it is visually distinct, never a default-styled button. |
| `.dzc-table-foot` | Pagination footer: "X of Y" + page controls + `.dzc-freshness` ("updated Xs ago", tick from a page-level interval while a selection is loaded). |
| `.dzc-card`, `.dzc-input`, `.dzc-note-warn`, `.dzc-list-item` | Shared card/input/warning-note/list-entry chrome for table pages. |

## Rules

- **Tokens only.** Every color is a `--dzc-*` token (or a `color-mix()` off one)
  so the table is correct under all 5 base themes + the holiday layer. No
  hardcoded Tailwind color utilities for table chrome.
- **Density.** 8–9px cell padding, 13px body, muted secondary columns.
- **Alignment.** Numerics right-aligned with tabular figures; text left.
- **States.** Loading / empty / error are `tr.dzc-state-row` — never a dead
  table with no rows, never a console error as the only signal.
- **Footer.** The page reports "showing X of Y", page controls, and data
  freshness in one footer under the table.
- **Actions.** Quiet buttons with an icon/emoji + label; destructive actions
  (`Wipe`, destructive clears) are `.is-danger` and confirm via
  `window.confirm` before any destructive POST.
- **Mobile ≤640px.** `thead` hides; rows become stacked cards — each `td`
  renders `label: value` from `data-label`. The page must stay usable on a
  375px phone with no horizontal scroll.
- **XSS.** All API values go through `escHtml()` before `innerHTML` (the
  contract never relaxes the page's existing escape discipline).
- **No backend changes.** Server-side pagination/sort/filter endpoints are
  reused exactly; only presentation changes.

## JS wiring expectations

- One function owns sort state and syncs BOTH `aria-sort` on the `th` and the
  `.dzc-sort-dir` arrow (see `updateSortIndicators` in
  `public/js/server-players.js`).
- Row clicks: action buttons win (`closest('button[data-action]')`), otherwise
  the row toggles selection (exclusive single selection).
- Freshness: page script records `lastLoadedAt` on each successful data load
  and re-renders the label on an interval (15s in the exemplar).
- Server context: pages on the shell pass the selected server to
  `window.dzcShellPollServer(...)` so the topbar context pill stays live —
  the shell never infers authorization from the pill.

## Exemplar

`public/server-players.html` + `public/js/server-players.js` (route
`/server-players`, composed via `renderShellPage`). Verified: search, filter,
sort (click + keyboard, `aria-sort`), pagination, page size, ALT badges,
possible-alt review panel, list management, ban/kick-equivalent row actions,
375px stacked rows.
