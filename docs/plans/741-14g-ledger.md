# #741 14-ui-guest reuse ledger

One line per new UI element on the guest page (`portal/apps/web/src/guest/`). Nothing is hand-built; searches were the installed `components/reui/` and `components/quincy/` first (step 1 of AGENTS.md "Reuse ReUI before building UI"), and each item below was already installed, so steps 2 to 5 were not needed.

| Element | Where | Item |
|---|---|---|
| Approve button | `GuestVideoScreen` header cluster (`guest-approve`) | `reui/button` (default variant, `lucide` Check icon) |
| Request changes button | `GuestVideoScreen` header cluster (`guest-request-changes`) | `reui/button` (outline variant) |
| Confirm dialog for either decision | `GuestDecisionDialog` | `reui/alert-dialog` (`AlertDialogContent/Header/Title/Description/Footer/Cancel/Action`), the same composition as the guest delete-note confirm |
| Optional note field in that dialog | `GuestDecisionDialog` | `reui/textarea` |
| Decision chip ("Approved", "Changes requested") | `GuestDeliveryChips`, video header and list row slot | `reui/badge` (`success-light`, `warning-light`) |
| "Released" chip | `GuestDeliveryChips` | `reui/badge` (`info-light`) |
| Download | `GuestDownload` | `reui/button` rendered as an anchor (`nativeButton={false}`, `render={<a download />}`), the pattern `quincy/ProjectShowIn` uses |
| Premium-locked reason | `GuestDownload` | plain text with a `lucide` Lock icon, in the label type token; no control, so no ReUI item applies |
| Download all trigger | `GuestDownloadAll`, list header and video header | `reui/button` (outline) |
| Download all dialog | `GuestDownloadAll` | `reui/dialog` (`DialogContent/Header/Title/Description/Footer`), as `GuestVerifyDialog` |
| Included films and left-out films rows | `GuestDownloadAll` | `reui/item` (`ItemGroup`, `Item variant="outline" size="sm"`, `ItemContent`, `ItemTitle`, `ItemDescription`), as the Video list rows |
| Download zip action | `GuestDownloadAll` | `reui/button` rendered as an anchor to the 14b zip route |
| Try again / Close in the dialog | `GuestDownloadAll` | `reui/button` |
| Decision and cap/nothing messages | `GuestDecisionDialog`, `GuestDownloadAll`, `GuestVideoScreen` | inline `<p>` in the body-small / label type tokens, as the guest note forms' problem lines |

No raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>` or role widget was added, so `config/ui-primitive-allowlist.ts` is unchanged.
