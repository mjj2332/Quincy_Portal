import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { captureBootLanding } from "./lib/boot-timing";
import { ConfirmModalHost } from "./components/ConfirmDialog";
import { preloadDashboardViewChunk } from "./lib/dashboard-view-preload";
import { isGuestReviewPath } from "./guest/guest-path";
import { GuestLoadFailure } from "./guest/GuestLoadFailure";
import "./styles/index.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Quincy Portal could not find its application root.");
}

// #741 12b: the guest review page is a separate tree. It is chosen before anything below, because `captureBootLanding`, the preload and `<App />` all reach the staff `/api`.
if (isGuestReviewPath(window.location.pathname)) {
  // A stale or failed chunk (a deploy replaced it) must not leave a blank page: show a Reload the visitor presses.
  void import("./guest/GuestApp").then(({ GuestApp }) => {
    createRoot(root).render(<StrictMode><GuestApp /></StrictMode>);
  }, () => {
    createRoot(root).render(<GuestLoadFailure />);
  });
} else {
  captureBootLanding(window.location.pathname);
  // #359: fetch the remembered Dashboard view's chunk now, in parallel with the session check.
  preloadDashboardViewChunk();

  createRoot(root).render(
    <StrictMode>
      <App />
      <ConfirmModalHost />
    </StrictMode>,
  );
}
