import * as React from "react";

import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

type QuincyFieldProps = Omit<React.ComponentProps<typeof Input>, "id"> & {
  id: string;
  label: React.ReactNode;
  error?: React.ReactNode;
};

function QuincyField({ id, label, error, "aria-describedby": ariaDescribedby, "aria-errormessage": ariaErrormessage, ...inputProps }: QuincyFieldProps) {
  const errorId = `${id}-error`;
  const describedBy = error ? [ariaDescribedby, errorId].filter(Boolean).join(" ") : ariaDescribedby;

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        aria-describedby={describedBy || undefined}
        aria-errormessage={error ? errorId : ariaErrormessage}
        {...inputProps}
      />
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

export { QuincyField };
export type { QuincyFieldProps };
