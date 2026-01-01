import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./ui/pages/App";
import "./styles/app.css";
import "./styles/hammer.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
