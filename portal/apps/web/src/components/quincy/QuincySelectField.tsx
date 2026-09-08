import * as React from "react";

import { Field, FieldError, FieldLabel } from "@/components/reui/field";
import { NativeSelect } from "@/components/quincy/NativeSelect";

type QuincySelectFieldProps = Omit<React.ComponentProps<typeof NativeSelect>, "id"> & {
  id: string;
  label: React.ReactNode;
  error?: React.ReactNode;
};

function QuincySelectField({ id, label, error, "aria-describedby": ariaDescribedby, "aria-errormessage": ariaErrormessage, children, ...selectProps }: QuincySelectFieldProps) {
  const errorId = `${id}-error`;
  const describedBy = error ? [ariaDescribedby, errorId].filter(Boolean).join(" ") : ariaDescribedby;

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <NativeSelect
        id={id}
        aria-describedby={describedBy || undefined}
        aria-errormessage={error ? errorId : ariaErrormessage}
        {...selectProps}
      >
        {children}
      </NativeSelect>
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

export { QuincySelectField };
export type { QuincySelectFieldProps };
