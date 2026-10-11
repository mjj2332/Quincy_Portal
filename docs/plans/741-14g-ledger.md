# #741 14-ui-guest reuse ledger

One line per new UI element on the guest page (`portal/apps/web/src/guest/`). Nothing is hand-built; searches were the installed `components/reui/` and `components/quincy/` first (step 1 of AGENTS.md "Reuse ReUI before building UI"), and each item below was already installed, so steps 2 to 5 were not needed.

| Element | Where | Item |
|---|---|---|
| Approve button | `GuestVideoScreen` header cluster (`guest-approve`) | `reui/button` (default variant, `lucide` Check icon; outline once the shown Version is approved, so the action matching the current decision is never the solid primary) |
| Request changes button | `GuestVideoScreen` header cluster (`guest-request-changes`) | `reui/button` (outline variant) |
| Confirm dialog for either decision | `GuestDecisionDialog` | `reui/alert-dialog` (`AlertDialogContent/Header/Title/Description/Footer/Cancel/Action`), the same composition as the guest delete-note confirm |
| Optional note field in that dialog | `GuestDecisionDialog` | `reui/textarea` inside `reui/field` `Field` + `FieldLabel` ("Note for the studio (optional)"), as `GuestVerifyDialog` |
| Decision chip ("Approved", "Changes requested") | `GuestDeliveryChips`, video header and list row slot | `reui/badge` (`success-light`, `warning-light`); the text relies on the on-inverse tone text roles (Token decision below) |
| "Released" chip | `GuestDeliveryChips` | `reui/badge` (`info-light`); relies on the on-inverse `--info-foreground` (Token decision below) |
| Download | `GuestDownload` | `reui/button` rendered as an anchor (`nativeButton={false}`, `render={<a download />}`), the pattern `quincy/ProjectShowIn` uses |
| Premium-locked reason | `GuestDownload` | plain text with a `lucide` Lock icon, in the label type token; no control, so no ReUI item applies |
| Download all trigger | `GuestDownloadAll`, list header and video header | `reui/button` (outline) |
| Download all dialog | `GuestDownloadAll` | `reui/dialog` (`DialogContent/Header/Title/Description/Footer`), as `GuestVerifyDialog` |
| Included films and left-out films rows | `GuestDownloadAll` | `reui/item` (`ItemGroup`, `Item variant="outline" size="sm"`, `ItemContent`, `ItemTitle`, `ItemDescription`), as the Video list rows |
| Download zip action | `GuestDownloadAll` | `reui/button` rendered as an anchor to the 14b zip route |
| Try again / Close in the dialog | `GuestDownloadAll` | `reui/button` |
| Decision and cap/nothing messages | `GuestDecisionDialog`, `GuestDownloadAll`, `GuestVideoScreen` | inline `<p>` in the body-small / label type tokens, as the guest note forms' problem lines |

No raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>` or role widget was added, so `config/ui-primitive-allowlist.ts` is unchanged.

## Token decision (settled plan)

On the guest film header (`data-surface="inverse"`) the Badge `success-light` / `warning-light` / `info-light` variants render their text from `--success-foreground` / `--warning-foreground` / `--info-foreground`, which `tokens/inverse.css` never redefined (measured 2.29:1 / 2.59:1 / 1.57:1 on ink-800). Settled fix: re-scope only the text roles (`--success-foreground`, `--warning-foreground`, `--info-foreground`, `--destructive-wash-foreground`) in the inverse block to new on-inverse palette steps, and restore them in the `data-surface="default"` block. The fill roles (`--success`, `--warning`, `--info`, `--destructive`) are untouched, since filled badges put white text on them. design-reviewer recommended this (option a) over an outline chip, because `success-outline` reads the same dark text role.

Blast radius checked: every other `data-surface="inverse"` site either restores via a `data-surface="default"` panel, reads `--signal-*` directly, or uses no tone roles.

Owner-reviewable hex values (in `tokens/colors.css`): `--signal-positive-on-inverse` #9cc48f (10.09:1 on ink-900, 9.39:1 on ink-800), `--signal-info-on-inverse` #a9bad3 (10.04:1 / 9.34:1), `--signal-critical-on-inverse` #e8968f (8.66:1 / 8.06:1). Caution reuses `--signal-caution-on-inverse` (star-amber #f0a020, 9.20:1 / 8.56:1). Guarded by "inverse.css re-scopes the tone text roles in both blocks" in `styles/design-system-guards.test.ts`.
