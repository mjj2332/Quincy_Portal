import { afterEach, describe, expect, it } from "vitest";
import { focusTargetAfterClearingSearch } from "./dashboard-helpers";

/**
 * #217, Sol review of the chip row. Clearing the search unmounts the very button that holds
 * focus, so focus must be handed to a control that SURVIVES the clear. The active view button is
 * the first choice, but it does not always exist (archived scope hides the view group) and is not
 * always focusable (`interactionBlocked` disables it -- a disabled button ignores `.focus()`).
 * The toolbar itself (`tabIndex={-1}`) is the target that is always there.
 */
function toolbar(inner: string): HTMLElement {
  document.body.innerHTML = `<div data-testid="dashboard-toolbar" tabindex="-1">${inner}</div>`;
  return document.body.firstElementChild as HTMLElement;
}

afterEach(() => { document.body.replaceChildren(); });

describe("focusTargetAfterClearingSearch (#217)", () => {
  it("prefers the enabled active view button", () => {
    const root = toolbar('<button class="is-active">Active</button><button data-focus-key="dashboard-view-list">List</button><button data-focus-key="dashboard-view-kanban" data-active="true">Kanban</button>');
    expect(focusTargetAfterClearingSearch(root)?.textContent).toBe("Kanban");
  });

  it("archived scope (no view group): falls back to the active scope button", () => {
    const root = toolbar('<button>Active</button><button class="is-active">Archived</button>');
    expect(focusTargetAfterClearingSearch(root)?.textContent).toBe("Archived");
  });

  it("a DISABLED active view button is skipped -- a disabled button cannot take focus", () => {
    const root = toolbar('<button class="is-active">Active</button><button data-focus-key="dashboard-view-kanban" data-active="true" disabled>Kanban</button>');
    expect(focusTargetAfterClearingSearch(root)?.textContent).toBe("Active");
  });

  it("nothing enabled at all: the toolbar itself, which can always take programmatic focus", () => {
    const root = toolbar('<button class="is-active" disabled>Active</button><button data-focus-key="dashboard-view-list" data-active="true" disabled>List</button>');
    const target = focusTargetAfterClearingSearch(root);
    expect(target).toBe(root);
    target!.focus();
    expect(document.activeElement).toBe(root);
  });

  it("no toolbar in the document: null, never a throw", () => {
    expect(focusTargetAfterClearingSearch(null)).toBeNull();
  });
});
