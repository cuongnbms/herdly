import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useTheme } from "./settings/theme";
import { initLayout } from "./sidebar/groups";
import { layoutLoad, layoutSave } from "./lib/ipc";
import { trackCmdHeld } from "./chat/fileLinks";

// Before the first paint, so a light theme does not flash dark.
document.documentElement.dataset.theme = useTheme.getState().theme;

trackCmdHeld();

// The sidebar layout is read from its file before the first render, so it never shows empty.
void initLayout({ load: layoutLoad, save: layoutSave }).then(() =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  ),
);
