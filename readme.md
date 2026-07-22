# Electron Kiosk App

A lightweight Electron-based kiosk system designed specifically for **Linux Mint (XFCE, Cinnamon, or MATE)**. This application launches a full-screen, locked-down web environment with built-in navigation overlays, auto-recovery on crashes.

---

## Quick Start Deployment

Follow these quick steps to deploy the application on your target machine.

### 1. Configure the Installation Script

Create a copy of `setup-kiosk.sh` or edit it directly to point to your target website. Change the `KIOSK_URL` configuration property near the top of the script:

```bash

# ================= CONFIGURATION =================

KIOSK_USER="kiosk"
KIOSK_URL="https://your-target-url.com"
KIOSK_NAV_POSITION="bottom-left" # Choices: top-left, top-right, bottom-left, bottom-right
KIOSK_IDLE_MINUTES=10            # Inactivity timeout in minutes (0 to disable)
# =================================================
```

### 2. Run the Installer

Make the setup script executable and run it with root privileges.

```bash
sudo chmod +x setup-kiosk.sh
sudo ./setup-kiosk.sh
```

### 3. Reboot

The installer will automatically countdown and reboot the machine. Upon restarting, the system will log directly into the secure kiosk environment.

---

## Admin Commands & Controls

Because the application runs in a highly restricted full-screen layout, specific keyboard shortcuts are provisioned via Openbox for system maintenance:

| Shortcut                           | Action                 | Description                                                                                                  |
| :--------------------------------- | :--------------------- | :----------------------------------------------------------------------------------------------------------- |
| **`Ctrl` + `Alt` + `Shift` + `E`** | **Exit Kiosk Session** | Spawns a secure, forced-focus admin verification dialog asking to safely log out back to the LightDM screen. |
| **`Ctrl` + `Alt` + `Shift` + `R`** | **Restart Kiosk App**  | Force-kills and re-initializes the Electron instance without logging out of the OS session.                  |

---

## Features & Architecture

### System Hardening (`setup-kiosk.sh`)

- **Stateless Resets:** Every time the kiosk logs in, it completely wipes its local `/home/kiosk` space and pulls fresh configurations from a pristine template located in `/opt/kiosk_template`.
- **Passwordless Security:** Creates a dedicated unprivileged `kiosk` user bound to a strict LightDM wrapper profile (`/usr/local/bin/kiosk-session-wrapper.sh`).
- **Display Defenses:** Completely blocks display power management (`dpms`), screen blanking, and standard screen savers.
- **Greeter Lockout:** Hides the manual desktop selection menu on the LightDM login screen to prevent tampering.

### Secure Window Management (`main.js`)

- **Tracking Parameter Stripping:** Automatically intercepts incoming links, popups, and HTTP redirects, scrubbing out common tracking schemas (e.g., `utm_*`, `gclid`, `fbclid`).
- **Popup Prevention:** Dynamically blocks standard `target="_blank"` triggers and routes them through a programmatically controlled child window loop.
- **Self-Healing Loop:** Listens for unresponsive states or out-of-memory crashes (`render-process-gone`) and automatically reloads the web application within 5 seconds.
- **Chrome Compatibility:** Appends flags like `ignore-gpu-blocklist` to guarantee high performance on older or specialized hardware.

### User Navigation Overlay (`preload.js`)

- Inserts a floating high-contrast, blurred navigation utility dock directly into the bottom-left corner of the DOM.
- **Home Button:** Navigates back to the root application URL, clears the underlying Chromium session storage, and purges cookies, cache, and localStorage data.
- **Dynamic Back Button:** Uses a 500ms poller checking Electron's history backend. The button automatically hides when a user is resting on the landing page, preventing empty historical back-stepping.

---

## File Summary

- **`main.js`**: Core Electron framework routing, privacy filter hooks, crash mitigation engines, and child process handlers.
- **`preload.js`**: Injection script handling high-contrast accessible SVG UI, touchscreen tap tracking, and navigation states.
- **`setup-kiosk.sh`**: Monolithic automated systems engineer mapping Openbox configurations, window rules (`wmctrl`/`zenity`), and LightDM profile setups.
