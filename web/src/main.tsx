import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Socket } from "./socket";
import { useWeb } from "./store";

const { apply, setConn } = useWeb.getState();
const socket = new Socket(`ws://${location.host}/ws`, { frame: apply, conn: setConn });
socket.start();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App socket={socket} />
  </StrictMode>,
);
