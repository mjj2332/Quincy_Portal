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

/** The props a drop target spreads on its element: the four drag handlers and `data-dragging` while a file is over it. */
export type FileDropTargetProps = Pick<React.HTMLAttributes<HTMLElement>, "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop"> & { "data-dragging": "true" | undefined };

/**
 * FileDropzone's drop logic as a hook (#938), for elements FileDropzone cannot be: a table row the data grid renders (`quincy/VideoRows`). One hook serves any number of
 * targets, each named by a `key` (a row's id); `targetProps(key, …)` is spread on that element and `dragging` is the key a file is over now. Drag events stop at the target,
 * so a target inside another (a row in the collection's body) takes its own drop alone; drops are ignored while `disabled`. `onFiles` gets every dropped file, never an empty list.
 */
export function useFileDropTarget() {
  const [dragging, setDragging] = React.useState<string | null>(null);
  const depths = React.useRef(new Map<string, number>());
  const targetProps = React.useCallback((key: string, { disabled = false, onFiles }: { disabled?: boolean; onFiles: (files: File[]) => void }): FileDropTargetProps => {
    const depth = () => depths.current.get(key) ?? 0;
    const release = () => setDragging((current) => (current === key ? null : current));
    return {
      "data-dragging": dragging === key ? "true" : undefined,
      onDragEnter: (event) => {
        event.stopPropagation();
        if (disabled || !Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
        event.preventDefault(); depths.current.set(key, depth() + 1); setDragging(key);
      },
      onDragOver: (event) => { event.stopPropagation(); if (!disabled) event.preventDefault(); },
      onDragLeave: (event) => { event.stopPropagation(); const next = Math.max(0, depth() - 1); depths.current.set(key, next); if (next === 0) release(); },
      onDrop: (event) => {
        event.preventDefault(); event.stopPropagation(); depths.current.set(key, 0); release();
        if (disabled) return;
        const dropped = Array.from(event.dataTransfer?.files ?? []);
        if (dropped.length > 0) onFiles(dropped);
      },
    };
  }, [dragging]);
  return { dragging, targetProps };
}

/** A drop target for one file. Sets `data-dragging` while a file is over it. Drops are ignored while `disabled`. Drag events stop here, so a zone inside another zone (a tile in the collection, #884) takes its own drop alone. */
export function FileDropzone({ disabled, className, children, ...props }: {
  disabled?: boolean;
} & PickHandler & Omit<React.ComponentProps<"div">, "onDrop" | "onDragOver" | "onDragEnter" | "onDragLeave">) {
  const { multiple, onFile, onFiles, rest } = splitPickHandler(props);
  const { targetProps } = useFileDropTarget();
  return <div
    {...rest}
    {...targetProps("zone", { disabled: disabled === true, onFiles: (dropped) => { if (multiple) onFiles(dropped); else onFile(dropped[0]!); } })}
    className={cn(className)}
  >{children}</div>;
}
