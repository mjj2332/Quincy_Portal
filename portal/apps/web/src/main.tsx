import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isDeliveryPagePath } from "@quincy/shared";
import App from "./App";
import { captureBootLanding } from "./lib/boot-timing";
import { ConfirmModalHost } from "./components/ConfirmDialog";
import { preloadDashboardViewChunk } from "./lib/dashboard-view-preload";
import { isGuestReviewPath, isGuestUnsubscribePath } from "./guest/guest-path";
import { mountGuest, mountGuestUnsubscribe } from "./guest/mount-guest";
import { mountDelivery } from "./delivery/mount-delivery";
import "./styles/index.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Quincy Portal could not find its application root.");
}

// #741 12b: the guest review page is a separate tree. It is chosen before anything below, because `captureBootLanding`, the preload and `<App />` all reach the staff `/api`.
if (isGuestReviewPath(window.location.pathname)) {
  mountGuest(root);
} else if (isGuestUnsubscribePath(window.location.pathname)) {
  // #741 15b: the digest email's unsubscribe page is guest too: no staff session, API or router.
  mountGuestUnsubscribe(root);
} else if (isDeliveryPagePath(window.location.pathname)) {
  // #787 slice 9: the public Client Delivery page is guest too: no staff session, API or router. Its chunk (and embla with it) loads only here.
  mountDelivery(root, () => import("./delivery/DeliveryApp"));
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
