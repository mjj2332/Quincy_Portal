import { FloatingFocusManager, FloatingPortal, useFloating } from "@floating-ui/react";
import { useId, type JSX, type MutableRefObject, type ReactNode } from "react";

export type ModalProps = {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  testId?: string;
  initialFocus?: MutableRefObject<HTMLElement | null> | number;
};

export function Modal({ title, eyebrow, children, footer, onClose, wide = false, testId, initialFocus }: ModalProps): JSX.Element {
  const titleId = `modal-title-${useId()}`;
  const { context, refs } = useFloating({ open: true });

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }

  return <FloatingPortal>
    <div data-confirm-modal-root={testId === "confirm-modal" ? "" : undefined}>
      <FloatingFocusManager context={context} modal returnFocus initialFocus={initialFocus}>
      <div className="scrim" onClick={onClose}>
        <div ref={refs.setFloating} className={`modal${wide ? " modal--wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid={testId} onClick={(event) => event.stopPropagation()} onKeyDown={handleKeyDown}>
          {(eyebrow || title) && <div className="modal__head">
            {eyebrow && <div className="ey" style={{ marginBottom: 10 }}>{eyebrow}</div>}
            {title && <h3 className="serif" id={titleId}>{title}</h3>}
          </div>}
          <div className="modal__body">{children}</div>
          {footer && <div className="modal__foot">{footer}</div>}
        </div>
      </div>
      </FloatingFocusManager>
    </div>
  </FloatingPortal>;
}
