const { contextBridge, ipcRenderer } = require("electron");

const BACK_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="19" y1="12" x2="5" y2="12"></line>
    <polyline points="12 19 5 12 12 5"></polyline>
  </svg>
`;

const HOME_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
    <polyline points="9 22 9 12 15 12 15 22"></polyline>
  </svg>
`;

let navContainer = null;
let backBtn = null;

function injectKioskNavigation() {
  // Prevent duplicate injections
  if (document.getElementById("kiosk-nav-container")) return;

  // 1. Create a compact container
  navContainer = document.createElement("nav");
  navContainer.id = "kiosk-nav-container";
  navContainer.setAttribute("aria-label", "Kiosk Navigation");

  Object.assign(navContainer.style, {
    position: "fixed",
    bottom: "24px",
    left: "24px",
    zIndex: "99999999",
    display: "flex",
    gap: "6px",
    backgroundColor: "rgba(15, 15, 15, 0.9)",
    padding: "6px",
    borderRadius: "40px",
    boxShadow: "0 4px 20px rgba(0, 0, 0, 0.4)",
    backdropFilter: "blur(8px)",
    border: "1.5px solid rgba(255, 255, 255, 0.15)",
    userSelect: "none",
  });

  // 2. Create the Home Icon Button
  const homeBtn = document.createElement("button");
  homeBtn.innerHTML = HOME_ICON;
  homeBtn.setAttribute("aria-label", "Return to the main kiosk home screen");
  styleIconButton(homeBtn);
  homeBtn.onclick = () => ipcRenderer.send("kiosk-home");

  // 3. Create the Back Icon Button
  backBtn = document.createElement("button");
  backBtn.innerHTML = BACK_ICON;
  backBtn.setAttribute("aria-label", "Go back to the previous page");
  styleIconButton(backBtn);
  backBtn.onclick = () => ipcRenderer.send("kiosk-back");

  // Initially hidden until main process broadcast sets state
  backBtn.style.display = "none";

  navContainer.appendChild(homeBtn);
  navContainer.appendChild(backBtn);
  document.body.appendChild(navContainer);
}

window.addEventListener("DOMContentLoaded", () => {
  injectKioskNavigation();

  // SPA Guard: Monitor the DOM. If an SPA wipes document.body, re-inject immediately.
  const observer = new MutationObserver(() => {
    if (!document.getElementById("kiosk-nav-container") && document.body) {
      injectKioskNavigation();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
});

// Event listener optimized to update styling instantly on main process notice
ipcRenderer.on("update-navigation-state", (event, canGoBack) => {
  if (!backBtn) return;
  if (canGoBack) {
    backBtn.style.display = "flex";
    backBtn.removeAttribute("disabled");
    backBtn.setAttribute("aria-hidden", "false");
  } else {
    backBtn.style.display = "none";
    backBtn.setAttribute("disabled", "true");
    backBtn.setAttribute("aria-hidden", "true");
  }
});

function styleIconButton(btn) {
  Object.assign(btn.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "2px solid transparent",
    borderRadius: "50%",
    color: "#ffffff",
    cursor: "pointer",
    width: "40px",
    height: "40px",
    padding: "0",
    outline: "none",
    transition: "background-color 0.15s, border-color 0.15s, transform 0.1s",
  });

  btn.addEventListener("focus", () => {
    btn.style.borderColor = "#ffffff";
    btn.style.backgroundColor = "rgba(255, 255, 255, 0.15)";
  });

  btn.addEventListener("blur", () => {
    btn.style.borderColor = "transparent";
    btn.style.backgroundColor = "transparent";
  });

  btn.addEventListener("mouseenter", () => {
    btn.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
  });

  btn.addEventListener("mouseleave", () => {
    if (document.activeElement !== btn) {
      btn.style.backgroundColor = "transparent";
    }
  });

  const pressStart = () => {
    btn.style.transform = "scale(0.9)";
  };
  const pressEnd = () => {
    btn.style.transform = "scale(1)";
  };

  btn.addEventListener("mousedown", pressStart);
  btn.addEventListener("mouseup", pressEnd);
  btn.addEventListener("touchstart", pressStart, { passive: true });
  btn.addEventListener("touchend", pressEnd, { passive: true });
}
