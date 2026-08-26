import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ConfirmModalHost } from "./components/ConfirmDialog";
import "./styles/index.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Quincy Portal could not find its application root.");
}

createRoot(root).render(
  <StrictMode>
    <App />
    <ConfirmModalHost />
  </StrictMode>,
);
