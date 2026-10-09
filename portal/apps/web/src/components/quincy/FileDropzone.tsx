import * as React from "react";

import { cn } from "@/lib/utils";
import { Button, type ButtonVariant } from "./Button";

/**
 * Quincy-owned file picking for single-file uploads (#741 4d-i). Built from the ReUI `use-file-upload` / `c-file-upload-1` pattern
 * (a hidden input behind a real Button, plus a drop target), minus its preview list and size errors: the caller checks the file.
 * The one hidden `<input type="file">` lives here, in `components/quincy/`, so the screens that use it add no raw primitive.
 */

/** A real Button that opens the file picker. Tab to it, Enter or Space opens the picker; the input itself is not a tab stop. */
export function FilePickButton({ accept, onFile, variant = "secondary", disabled, className, children, ...rest }: {
  accept: string;
  onFile: (file: File) => void;
  variant?: ButtonVariant;
} & Omit<React.ComponentProps<"button">, "onClick" | "type">) {
  const input = React.useRef<HTMLInputElement>(null);
  return <>
    <Button type="button" variant={variant} disabled={disabled} className={className} onClick={() => input.current?.click()} {...rest}>{children}</Button>
    <input
      ref={input}
      type="file"
      accept={accept}
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      data-testid="file-pick-input"
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) onFile(file);
      }}
    />
  </>;
}

/** A drop target for one file. Sets `data-dragging` while a file is over it. Drops are ignored while `disabled`. */
export function FileDropzone({ onFile, disabled, className, children, ...rest }: {
  onFile: (file: File) => void;
  disabled?: boolean;
} & Omit<React.ComponentProps<"div">, "onDrop" | "onDragOver" | "onDragEnter" | "onDragLeave">) {
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
      const file = event.dataTransfer?.files?.[0];
      if (file) onFile(file);
    }}
  >{children}</div>;
}
