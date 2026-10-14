import * as React from "react";

import { cn } from "@/lib/utils";
import { Button, type ButtonVariant } from "./Button";

/**
 * Quincy-owned file picking for single-file uploads (#741 4d-i). Built from the ReUI `use-file-upload` / `c-file-upload-1` pattern
 * (a hidden input behind a real Button, plus a drop target), minus its preview list and size errors: the caller checks the file.
 * The one hidden `<input type="file">` lives here, in `components/quincy/`, so the screens that use it add no raw primitive.
 */

/** One file at a time (the default), or a list when `multiple`: the two shapes cannot be mixed. */
type PickHandler = { multiple?: false; onFile: (file: File) => void; onFiles?: undefined } | { multiple: true; onFiles: (files: File[]) => void; onFile?: undefined };
function splitPickHandler<P extends PickHandler>(props: P) {
  const { multiple, onFile, onFiles, ...rest } = props;
  return { multiple: multiple === true, onFile: onFile as (file: File) => void, onFiles: onFiles as (files: File[]) => void, rest: rest as Omit<P, "multiple" | "onFile" | "onFiles"> };
}

/** The hidden `<input type="file">` and its change handler, shared by `FilePickButton` and `useFilePick`. */
function PickInput({ input, accept, multiple, onFile, onFiles }: { input: React.RefObject<HTMLInputElement | null>; accept: string; multiple: boolean; onFile: (file: File) => void; onFiles: (files: File[]) => void }) {
  return <input
    ref={input}
    type="file"
    name="file"
    accept={accept}
    multiple={multiple}
    className="sr-only"
    tabIndex={-1}
    aria-hidden="true"
    data-testid="file-pick-input"
    onChange={(event) => {
      // Read the list before the reset: clearing `value` empties the live FileList.
      const picked = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (multiple) { if (picked.length > 0) onFiles(picked); } else if (picked[0]) onFile(picked[0]);
    }}
  />;
}

/** A real Button that opens the file picker. Tab to it, Enter or Space opens the picker; the input itself is not a tab stop. */
export function FilePickButton({ accept, variant = "secondary", disabled, className, children, ...props }: {
  accept: string;
  variant?: ButtonVariant;
} & PickHandler & Omit<React.ComponentProps<"button">, "onClick" | "type">) {
  const { multiple, onFile, onFiles, rest } = splitPickHandler(props);
  const input = React.useRef<HTMLInputElement>(null);
  return <>
    <Button type="button" variant={variant} disabled={disabled} className={className} onClick={() => input.current?.click()} {...rest}>{children}</Button>
    <PickInput input={input} accept={accept} multiple={multiple} onFile={onFile} onFiles={onFiles} />
  </>;
}

/**
 * The same picker for a control that is not a button of ours (a menu item, #884): render `input` once beside the control and call `open` from its click handler,
 * synchronously, since iOS refuses `input.click()` from a later tick. Keep `input` out of a portalled popup, which unmounts when the menu closes.
 */
export function useFilePick({ accept, onFile }: { accept: string; onFile: (file: File) => void }) {
  const ref = React.useRef<HTMLInputElement>(null);
  const open = React.useCallback(() => { ref.current?.click(); }, []);
  const input = <PickInput input={ref} accept={accept} multiple={false} onFile={onFile} onFiles={() => undefined} />;
  return { open, input };
}

/** A drop target for one file. Sets `data-dragging` while a file is over it. Drops are ignored while `disabled`. Drag events stop here, so a zone inside another zone (a tile in the collection, #884) takes its own drop alone. */
export function FileDropzone({ disabled, className, children, ...props }: {
  disabled?: boolean;
} & PickHandler & Omit<React.ComponentProps<"div">, "onDrop" | "onDragOver" | "onDragEnter" | "onDragLeave">) {
  const { multiple, onFile, onFiles, rest } = splitPickHandler(props);
  const [dragging, setDragging] = React.useState(false);
  const depth = React.useRef(0);
  return <div
    {...rest}
    data-dragging={dragging ? "true" : undefined}
    className={cn(className)}
    onDragEnter={(event) => {
      event.stopPropagation();
      if (disabled || !Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
      event.preventDefault(); depth.current += 1; setDragging(true);
    }}
    onDragOver={(event) => { event.stopPropagation(); if (!disabled) event.preventDefault(); }}
    onDragLeave={(event) => { event.stopPropagation(); depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setDragging(false); }}
    onDrop={(event) => {
      event.preventDefault(); event.stopPropagation(); depth.current = 0; setDragging(false);
      if (disabled) return;
      const dropped = Array.from(event.dataTransfer?.files ?? []);
      if (multiple) { if (dropped.length > 0) onFiles(dropped); } else if (dropped[0]) onFile(dropped[0]);
    }}
  >{children}</div>;
}
