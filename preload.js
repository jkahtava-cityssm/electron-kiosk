// preload.js
const { contextBridge, ipcRenderer } = require("electron");

// Wait for the webpage DOM to be ready
window.addEventListener("DOMContentLoaded", () => {
  // 1. Create a container for our floating controls
  const navContainer = document.createElement("div");
  navContainer.id = "kiosk-nav-container";

  // Apply elegant, touch-friendly CSS styling
  Object.assign(navContainer.style, {
    position: "fixed",
    bottom: "30px",
    right: "30px",
    zIndex: "99999999", // Ensure it sits on top of all website elements
    display: "flex",
    gap: "12px",
    backgroundColor: "rgba(0, 0, 0, 0.85)",
    padding: "10px 18px",
    borderRadius: "30px",
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.3)",
    backdropFilter: "blur(5px)",
    border: "1px solid rgba(255, 255, 255, 0.1)",
    userSelect: "none",
  });

  // 2. Create the Back Button
  const backBtn = document.createElement("button");
  backBtn.innerHTML = "⬅ Back";
  styleButton(backBtn);
  backBtn.onclick = () => ipcRenderer.send("kiosk-back");

  // 3. Create the Home Button
  const homeBtn = document.createElement("button");
  homeBtn.innerHTML = "🏠 Home";
  styleButton(homeBtn);
  homeBtn.onclick = () => ipcRenderer.send("kiosk-home");

  // Append buttons to container, and container to body
  navContainer.appendChild(backBtn);
  navContainer.appendChild(homeBtn);
  document.body.appendChild(navContainer);

  // 4. Periodically check if we can go back, hide the back button if we are on the home page
  setInterval(async () => {
    const canGoBack = await ipcRenderer.invoke("kiosk-can-go-back");
    backBtn.style.display = canGoBack ? "block" : "none";
  }, 500);
});

// Helper function to style the buttons uniformly
function styleButton(btn) {
  Object.assign(btn.style, {
    background: "none",
    border: "none",
    color: "#ffffff",
    fontSize: "16px",
    fontWeight: "bold",
    cursor: "pointer",
    padding: "6px 12px",
    fontFamily: "system-ui, -apple-system, sans-serif",
    outline: "none",
  });

  // Add a quick active touch state feedback
  btn.addEventListener("touchstart", () => (btn.style.opacity = "0.5"));
  btn.addEventListener("touchend", () => (btn.style.opacity = "1"));
}
