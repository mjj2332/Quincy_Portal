import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { captureBootLanding } from "./lib/boot-timing";
import { ConfirmModalHost } from "./components/ConfirmDialog";
import { preloadDashboardViewChunk } from "./lib/dashboard-view-preload";
import "./styles/index.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Quincy Portal could not find its application root.");
}

captureBootLanding(window.location.pathname);
// #359: fetch the remembered Dashboard view's chunk now, in parallel with the session check.
preloadDashboardViewChunk();

createRoot(root).render(
  <StrictMode>
    <App />
    <ConfirmModalHost />
  </StrictMode>,
);
