import React from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { Popup } from "./Popup";

const container = document.getElementById("root");
if (!container) {
  throw new Error("root element missing from popup HTML");
}

createRoot(container).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
);
