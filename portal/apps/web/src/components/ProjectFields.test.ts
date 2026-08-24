import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyProjectForm, ProjectFields, projectFieldsPolicy, type ProjectForm, validateProjectFields } from "./ProjectFields";
import { editProjectPayload } from "../screens/EditProject";

const form: ProjectForm = {
  ...emptyProjectForm,
  street: "12 Test Street",
  suburb: "Sydney",
  orderNo: "ORD-123",
  orderId: "external-order-id",
  invoiceAmount: "not a number",
  paymentStatus: "paid",
  notes: "Original order note",
  orderedServices: ["edited"],
  photographerUserIds: ["photographer-id"],
  editorUserIds: ["editor-id"],
};

describe("project field policies", () => {
  it("keeps create fields editable and validates invoice values", () => {
    expect(projectFieldsPolicy("create")).toEqual({ servicesReadOnly: false, orderReadOnly: false, notesReadOnly: false, showInvoiceAndPayment: true });
    expect(validateProjectFields(form)).toMatchObject({ invoiceAmount: "Enter a numeric invoice amount." });
  });

  it("makes the protected edit sections read-only without validating historical invoice text", () => {
    expect(projectFieldsPolicy("edit")).toEqual({ servicesReadOnly: true, orderReadOnly: true, notesReadOnly: true, showInvoiceAndPayment: false });
    expect(validateProjectFields(form, "edit").invoiceAmount).toBeUndefined();
  });

  it("omits protected order values while retaining editable project and member fields", () => {
    const payload = editProjectPayload(form);
    expect(payload).toMatchObject({ street: "12 Test Street", suburb: "Sydney", photographerUserIds: ["photographer-id"], editorUserIds: ["editor-id"] });
    for (const key of ["orderedServices", "orderNo", "orderId", "invoiceAmount", "paymentStatus", "notes"]) expect(payload).not.toHaveProperty(key);
  });

  it("renders protected edit controls as read-only without invoice or payment fields", () => {
    const markup = renderToStaticMarkup(createElement(ProjectFields, {
      form,
      errors: {},
      mode: "edit",
      onChange: () => undefined,
      onToggle: () => undefined,
    }));

    expect(markup).toMatch(/<span>Order number<\/span><input[^>]*(?:readOnly|readonly)=""/);
    expect(markup).toMatch(/<span>Order ID<\/span><input[^>]*(?:readOnly|readonly)=""/);
    expect(markup).toMatch(/<textarea[^>]*(?:readOnly|readonly)=""/);
    const serviceInputs = [...markup.matchAll(/<input type="checkbox"[^>]*><span>(?:<strong>RAW<\/strong><small>Always included<\/small>|Edited photography|Video|Floorplan|Copywriting)<\/span>/g)];
    expect(serviceInputs).toHaveLength(5);
    expect(serviceInputs.every(([input]) => input.includes("disabled=\"\""))).toBe(true);
    expect(markup).not.toContain("Invoice amount");
    expect(markup).not.toContain("Payment status");
    expect(markup).toContain("Order details are managed by the order system and are available here to copy.");
    expect(markup).toContain("Services are fixed after a project is created.");
    expect(markup).toContain("Notes are retained from the original order.");
  });

  it("renders create controls as editable and includes invoice and payment fields", () => {
    const markup = renderToStaticMarkup(createElement(ProjectFields, {
      form,
      errors: {},
      mode: "create",
      onChange: () => undefined,
      onToggle: () => undefined,
    }));

    expect(markup).toContain("Invoice amount");
    expect(markup).toContain("Payment status");
    expect(markup).not.toMatch(/<span>Order number<\/span><input[^>]*(?:readOnly|readonly)=""/);
    expect(markup).not.toMatch(/<span>Order ID<\/span><input[^>]*(?:readOnly|readonly)=""/);
    expect(markup).not.toMatch(/<textarea[^>]*(?:readOnly|readonly)=""/);
    const editedService = markup.match(/<input type="checkbox"([^>]*)><span>Edited photography<\/span>/)?.[1];
    expect(editedService).toBeDefined();
    expect(editedService).not.toContain("disabled");
  });
});
