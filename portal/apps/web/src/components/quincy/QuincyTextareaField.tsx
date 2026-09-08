import * as React from "react";

import { Field, FieldError, FieldLabel } from "@/components/reui/field";
import { Textarea } from "@/components/reui/textarea";

type QuincyTextareaFieldProps = Omit<React.ComponentProps<typeof Textarea>, "id"> & {
  id: string;
  label: React.ReactNode;
  error?: React.ReactNode;
};

function QuincyTextareaField({ id, label, error, "aria-describedby": ariaDescribedby, "aria-errormessage": ariaErrormessage, ...textareaProps }: QuincyTextareaFieldProps) {
  const errorId = `${id}-error`;
  const describedBy = error ? [ariaDescribedby, errorId].filter(Boolean).join(" ") : ariaDescribedby;

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        aria-describedby={describedBy || undefined}
        aria-errormessage={error ? errorId : ariaErrormessage}
        {...textareaProps}
      />
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

export { QuincyTextareaField };
export type { QuincyTextareaFieldProps };
