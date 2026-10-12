# #787 slice 7 web: reuse ledger

One line per new UI element in `portal/apps/web/src/delivery/DeliveryDownloadAll.tsx`. Nothing is hand-built; no `ui-primitive-allowlist` change.

- Download all trigger: `components/reui/button` (`variant="outline"`) + lucide `DownloadIcon`, as `guest/GuestDownloadAll`.
- Dialog shell: `components/reui/dialog` (`Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`); explicit `sm:max-w-[520px]` (lesson "Quincy's --container-* tokens are page widths, not dialog widths").
- Size choice (Web-size / Full-res): `components/reui/radio-group` (`RadioGroup`, `RadioGroupItem`) inside `components/reui/field` (`FieldLabel`, `Field`, `FieldContent`, `FieldTitle`, `FieldDescription`), ReUI's selectable-card radio composition.
- "In the zip: N photos · X" summary: a plain `h3` heading in the guest dialog's heading style (as `guest/GuestDownloadAll`'s "In the zip"), parallel to the left-out section; bytes from `guest/guest-format` `formatBytes`.
- "Not included (locked)" list: `components/reui/item` (`ItemGroup`, `Item`, `ItemContent`, `ItemTitle`, `ItemDescription`), as the guest dialog's Left out list.
- Preparing / ready / timeout status: `components/quincy/Notice` + `components/reui/spinner`; copy and polling from `lib/use-prepared-download` and `components/PreparedZipNotice` (`PREPARING_COPY`, `PREPARE_FAILED_COPY`), no copy invented.
- Download zip (disabled with `components/reui/spinner` while preparing, so the footer holds its height; the ready one): `components/reui/button` rendering `<a href download>` (`nativeButton={false}`), as `guest/GuestDownloadAll`.
- Check again / Try again / Close: `components/reui/button` `variant="outline"`.
- Slot placement: existing `components/quincy/SectionHead` `actions` in `DeliveryPage` (unchanged element, now also on the Premium panel when there is no Photos tab).
