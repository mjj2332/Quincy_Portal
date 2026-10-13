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

/** A real Button that opens the file picker. Tab to it, Enter or Space opens the picker; the input itself is not a tab stop. */
export function FilePickButton({ accept, variant = "secondary", disabled, className, children, ...props }: {
  accept: string;
  variant?: ButtonVariant;
} & PickHandler & Omit<React.ComponentProps<"button">, "onClick" | "type">) {
  const { multiple, onFile, onFiles, rest } = splitPickHandler(props);
  const input = React.useRef<HTMLInputElement>(null);
  return <>
    <Button type="button" variant={variant} disabled={disabled} className={className} onClick={() => input.current?.click()} {...rest}>{children}</Button>
    <input
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
    />
  </>;
}

/** A drop target for one file. Sets `data-dragging` while a file is over it. Drops are ignored while `disabled`. */
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
    onDragEnter={(event) => { if (disabled) return; event.preventDefault(); depth.current += 1; setDragging(true); }}
    onDragOver={(event) => { if (!disabled) event.preventDefault(); }}
    onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setDragging(false); }}
    onDrop={(event) => {
      event.preventDefault(); depth.current = 0; setDragging(false);
      if (disabled) return;
      const dropped = Array.from(event.dataTransfer?.files ?? []);
      if (multiple) { if (dropped.length > 0) onFiles(dropped); } else if (dropped[0]) onFile(dropped[0]);
    }}
  >{children}</div>;
}
