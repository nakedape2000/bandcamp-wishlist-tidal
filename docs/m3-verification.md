# M3 Verification Runbook

Run from the repository root. None of these steps writes to TIDAL.

## 1. Automated checks

```bash
bun run verify:m3
```

Expected: all tests pass, typecheck and formatting checks exit successfully, and
both empty-database CLI checks report `0 review item(s). Provider writes: 0.`

## 2. Prepare a disposable copy of real data

```bash
cp ./output/m2-real.sqlite /tmp/bcts-m3-acceptance.sqlite
```

All decisions below are stored in this copy, not in the working database.

## 3. Check the CLI

```bash
BCTS_DATABASE=/tmp/bcts-m3-acceptance.sqlite bun run sync -- review list --status needs_review
BCTS_DATABASE=/tmp/bcts-m3-acceptance.sqlite bun run sync -- review browse
```

In `browse`, verify that `n` and `p` move through releases, candidate details
include score and evidence, and `q` exits. You may approve/reject/defer one item
in this disposable database. Every result must say `Provider writes: 0`.

## 4. Check the local review desk

```bash
BCTS_DATABASE=/tmp/bcts-m3-acceptance.sqlite bun run review:web
```

Open `http://127.0.0.1:4173` and check:

1. The default view contains the real review queue and Bandcamp artwork.
2. Search, status, and minimum-score filters reduce the queue correctly.
3. Selecting a release shows its Bandcamp link, candidates, TIDAL links,
   artwork, scores, release details, and score explanation.
4. Selecting another candidate and approving it shows a confirmation toast that
   no TIDAL write was made.
5. `Pending additions` increases and lists the selected album while `Writes now`
   remains `0`.
6. Clicking `Pending additions` replaces the review queue with the dry-run
   additions view; clicking `Review queue` restores the queue.
7. Refreshing the page preserves the decision.
8. Editing artist/title/label persists after refresh.
9. The browser developer console contains no errors.

Stop the server with `Ctrl+C`.

## 5. Check decision portability

```bash
BCTS_DATABASE=/tmp/bcts-m3-acceptance.sqlite bun run sync -- review export /tmp/bcts-review-decisions.json
BCTS_DATABASE=/tmp/bcts-m3-acceptance.sqlite bun run sync -- review import /tmp/bcts-review-decisions.json --yes
```

Expected: export and import succeed, decisions remain visible, and the import
reports `Provider writes: 0`.

## 6. Check an empty database

```bash
bun run review:web -- --database /tmp/bcts-m3-empty.sqlite --port 4174
```

Open `http://127.0.0.1:4174`. Expected: the review queue and pending plan both
show a clean empty state, with no crash and `0` writes. Stop with `Ctrl+C`.

M3 is accepted when every check above matches. No `--apply` command is part of
this runbook.
