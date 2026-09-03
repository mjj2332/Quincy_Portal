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

  it("keeps the Agent email rule identical in Create and Edit while allowing empty email", () => {
    const invalid = { ...form, agentEmail: "not-an-email" };
    expect(validateProjectFields(invalid).agentEmail).toBe("Enter a valid email address.");
    expect(validateProjectFields(invalid, "edit").agentEmail).toBe("Enter a valid email address.");
    expect(validateProjectFields({ ...form, agentEmail: "" }).agentEmail).toBeUndefined();
    expect(validateProjectFields({ ...form, agentEmail: "" }, "edit").agentEmail).toBeUndefined();
  });

  it("trims the four editable client values in the Edit payload and maps whitespace-only values to null", () => {
    const padded = { ...form, agencyName: " Agency ", agentName: " Agent ", agentEmail: " agent@example.test ", agentPhone: " +61 412 345 678 " };
    expect(editProjectPayload(padded)).toMatchObject({ agencyName: "Agency", agentName: "Agent", agentEmail: "agent@example.test", agentPhone: "+61 412 345 678" });

    const whitespaceOnly = { ...form, agencyName: "  ", agentName: "\t", agentEmail: " \n ", agentPhone: "  " };
    expect(editProjectPayload(whitespaceOnly)).toMatchObject({ agencyName: null, agentName: null, agentEmail: null, agentPhone: null });
  });

  it("omits protected order values and roster fields from the Edit payload", () => {
    const payload = editProjectPayload(form);
    expect(payload).toMatchObject({ street: "12 Test Street", suburb: "Sydney" });
    for (const key of ["orderedServices", "photographerUserIds", "editorUserIds", "orderNo", "orderId", "invoiceAmount", "paymentStatus", "notes"]) expect(payload).not.toHaveProperty(key);
  });

  it("renders protected edit controls as read-only without invoice or payment fields", () => {
    const markup = renderToStaticMarkup(createElement(ProjectFields, {
      form,
      errors: {},
      mode: "edit",
      onChange: () => undefined,
      onToggle: () => undefined,
    }));

    expect(markup).toMatch(/for="project-order-number"[^>]*>Order number<\/label><input[^>]*id="project-order-number"[^>]*(?:readOnly|readonly)=""/);
    expect(markup).toMatch(/for="project-order-id"[^>]*>Order ID<\/label><input[^>]*id="project-order-id"[^>]*(?:readOnly|readonly)=""/);
    expect(markup).toMatch(/<textarea[^>]*(?:readOnly|readonly)=""/);
    const serviceInputs = [...markup.matchAll(/<input type="checkbox"[^>]*><span[^>]*>(?:<strong[^>]*>RAW<\/strong><small[^>]*>Always included<\/small>|Edited photography|Video|Floorplan|Copywriting)<\/span>/g)];
    expect(serviceInputs).toHaveLength(5);
    expect(serviceInputs.every(([input]) => input.includes("disabled=\"\""))).toBe(true);
    expect(markup).not.toContain("Invoice amount");
    expect(markup).not.toContain("Payment status");
    expect(markup).toContain("Order details are managed by the order system and are available here to copy.");
    expect(markup).toContain("Services are fixed after a project is created.");
    expect(markup).toContain("Notes are retained from the original order.");
  });

  it("renders exactly the shared four-control Client contract in Create and Edit", () => {
    const renderClient = (mode: "create" | "edit", errors: Record<string, string> = {}) => {
      const markup = renderToStaticMarkup(createElement(ProjectFields, { form, errors, mode, onChange: () => undefined, onToggle: () => undefined }));
      const start = markup.indexOf('<section class="create-project__section" aria-labelledby="client-heading">');
      return markup.slice(start, markup.indexOf("</section>", start) + "</section>".length);
    };
    const assertClientControls = (markup: string) => {
      const inputs = [...markup.matchAll(/<input\b[^>]*>/g)].map(([input]) => input);

      expect(inputs).toHaveLength(4);
      expect(inputs[0]).not.toContain("type=");
      expect(inputs[1]).not.toContain("type=");
      expect(inputs[2]).toContain('type="email"');
      expect(inputs[3]).toContain('type="tel"');
      expect(inputs.every((input) => !/\s(?:readonly|readOnly|disabled)=""/.test(input))).toBe(true);
      const classTokens = [...markup.matchAll(/class="([^"]*)"/g)].flatMap((match) => (match[1] ?? "").split(/\s+/));
      expect(classTokens).toContain("grid");
      expect(classTokens).not.toContain("[&amp;]:grid");
      for (const id of ["project-agency-name", "project-agent-name", "project-agent-email", "project-agent-phone"]) {
        expect(markup).toContain(`for="${id}"`);
      }
      expect(markup).toContain('aria-invalid="false"');
      expect(markup).not.toContain("project-agent-email-error");
    };
    const createClient = renderClient("create");
    const editClient = renderClient("edit");
    assertClientControls(createClient);
    assertClientControls(editClient);
    expect(editClient).toBe(createClient);

    const invalidClient = renderClient("create", { agentEmail: "Enter a valid email address." });
    const invalidEditClient = renderClient("edit", { agentEmail: "Enter a valid email address." });
    for (const markup of [invalidClient, invalidEditClient]) {
      expect(markup).toContain('aria-invalid="true"');
      expect(markup).toContain('aria-describedby="project-agent-email-error"');
      expect(markup).toContain('aria-errormessage="project-agent-email-error"');
      expect(markup.match(/Enter a valid email address\./g)).toHaveLength(1);
      expect(markup).toContain('role="alert"');
    }
    expect(invalidEditClient).toBe(invalidClient);
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
    expect(markup).not.toMatch(/for="project-order-number"[^>]*>Order number<\/label><input[^>]*id="project-order-number"[^>]*(?:readOnly|readonly)=""/);
    expect(markup).not.toMatch(/for="project-order-id"[^>]*>Order ID<\/label><input[^>]*id="project-order-id"[^>]*(?:readOnly|readonly)=""/);
    expect(markup).not.toMatch(/<textarea[^>]*(?:readOnly|readonly)=""/);
    const editedService = markup.match(/<input type="checkbox"([^>]*)><span[^>]*>Edited photography<\/span>/)?.[1];
    expect(editedService).toBeDefined();
    expect(editedService).not.toMatch(/\sdisabled=""/);
  });
});
