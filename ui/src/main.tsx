import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { WorkspaceDraftProvider } from "./WorkspaceDrafts";
import "./index.css";
import "./chat/shell.css";
import "./config.css";
import { applyTheme, readTheme } from "./chat/theme";

applyTheme(readTheme());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WorkspaceDraftProvider><App /></WorkspaceDraftProvider>
  </React.StrictMode>,
);
