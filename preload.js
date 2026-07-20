const { contextBridge, ipcRenderer } = require("electron");

const BACK_ICON = `
  <svg class="kiosk-nav-svg" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 20px !important; height: 20px !important; min-width: 20px !important; min-height: 20px !important; display: block !important;">
    <line x1="19" y1="12" x2="5" y2="12"></line>
    <polyline points="12 19 5 12 12 5"></polyline>
  </svg>
`;

const HOME_ICON = `
  <svg class="kiosk-nav-svg" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 20px !important; height: 20px !important; min-width: 20px !important; min-height: 20px !important; display: block !important;">
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
    <polyline points="9 22 9 12 15 12 15 22"></polyline>
  </svg>
`;

let navContainer = null;
let backBtn = null;

function applyDynamicPosition(container, positionValue) {
  container.style.top = "auto";
  container.style.bottom = "auto";
  container.style.left = "auto";
  container.style.right = "auto";

  switch (positionValue) {
    case "top-left":
      container.style.top = "24px";
      container.style.left = "24px";
      break;
    case "top-right":
      container.style.top = "24px";
      container.style.right = "24px";
      break;
    case "bottom-right":
      container.style.bottom = "24px";
      container.style.right = "24px";
      break;
    case "bottom-left":
    default:
      container.style.bottom = "24px";
      container.style.left = "24px";
      break;
  }
}

async function refreshBackButton() {
  if (!navContainer || !backBtn) return;

  const state = await ipcRenderer.invoke("request-navigation-state");
  applyDynamicPosition(navContainer, state.position);

  if (state.canGoBack) {
    backBtn.style.setProperty("display", "flex", "important");
    backBtn.removeAttribute("disabled");
    backBtn.setAttribute("aria-hidden", "false");
  } else {
    backBtn.style.setProperty("display", "none", "important");
    backBtn.setAttribute("disabled", "true");
    backBtn.setAttribute("aria-hidden", "true");
  }
}

function injectKioskNavigation() {
  if (document.getElementById("kiosk-nav-container")) return;

  navContainer = document.createElement("nav");
  navContainer.id = "kiosk-nav-container";
  navContainer.setAttribute("aria-label", "Kiosk Navigation");

  Object.assign(navContainer.style, {
    position: "fixed",
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
    boxSizing: "border-box", // Insulate container dimensions
  });

  const homeBtn = document.createElement("button");
  homeBtn.innerHTML = HOME_ICON;
  styleIconButton(homeBtn);
  homeBtn.onclick = () => ipcRenderer.send("kiosk-home");

  backBtn = document.createElement("button");
  backBtn.innerHTML = BACK_ICON;
  styleIconButton(backBtn);
  backBtn.onclick = () => ipcRenderer.send("kiosk-back");
  backBtn.style.setProperty("display", "none", "important");

  navContainer.appendChild(homeBtn);
  navContainer.appendChild(backBtn);
  document.body.appendChild(navContainer);

  refreshBackButton();
}

window.addEventListener("DOMContentLoaded", () => {
  injectKioskNavigation();

  const observer = new MutationObserver(() => {
    if (!document.getElementById("kiosk-nav-container") && document.body) {
      injectKioskNavigation();
    } else {
      refreshBackButton();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
});

ipcRenderer.on("update-navigation-state", () => {
  refreshBackButton();
});

function styleIconButton(btn) {
  // Use explicit setProperty with 'important' where global templates cross-contaminate layout bounds
  btn.style.setProperty("display", "flex", "important");
  btn.style.setProperty("align-items", "center", "important");
  btn.style.setProperty("justify-content", "center", "important");
  btn.style.setProperty("background", "none", "important");
  btn.style.setProperty("border", "2px solid transparent", "important");
  btn.style.setProperty("border-radius", "50%", "important");
  btn.style.setProperty("color", "#ffffff", "important");
  btn.style.setProperty("cursor", "pointer", "important");
  btn.style.setProperty("outline", "none", "important");
  btn.style.setProperty("padding", "0", "important");
  btn.style.setProperty("margin", "0", "important");

  // Enforce rigid layout dimensions
  btn.style.setProperty("box-sizing", "border-box", "important");
  btn.style.setProperty("width", "40px", "important");
  btn.style.setProperty("height", "40px", "important");
  btn.style.setProperty("min-width", "40px", "important");
  btn.style.setProperty("min-height", "40px", "important");
  btn.style.setProperty("max-width", "40px", "important");
  btn.style.setProperty("max-height", "40px", "important");
  btn.style.setProperty("flex-shrink", "0", "important");

  btn.style.transition = "background-color 0.15s, border-color 0.15s, transform 0.1s";

  btn.addEventListener("focus", () => {
    btn.style.setProperty("border-color", "#ffffff", "important");
    btn.style.setProperty("background-color", "rgba(255, 255, 255, 0.15)", "important");
  });

  btn.addEventListener("blur", () => {
    btn.style.setProperty("border-color", "transparent", "important");
    btn.style.setProperty("background-color", "transparent", "important");
  });

  btn.addEventListener("mouseenter", () => {
    btn.style.setProperty("background-color", "rgba(255, 255, 255, 0.1)", "important");
  });

  btn.addEventListener("mouseleave", () => {
    if (document.activeElement !== btn) {
      btn.style.setProperty("background-color", "transparent", "important");
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
