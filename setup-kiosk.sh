#!/bin/bash

# Ensure the script is run as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run this script as root (use sudo)."
  exit 1
fi

# ================= CONFIGURATION =================
KIOSK_USER="kiosk"
KIOSK_URL="https://ssmpl.bibliocommons.com"
# =================================================

# Detect the real user who ran the script with sudo
IF_SUDO_USER="${SUDO_USER:-$USER}"

if [ "$IF_SUDO_USER" = "root" ] || [ -z "$IF_SUDO_USER" ]; then
    echo "Warning: You ran this directly as root, so we cannot safely detect your regular admin user."
    read -p "Please enter your regular admin username: " ADMIN_USER
else
    ADMIN_USER="$IF_SUDO_USER"
    echo "Detected regular admin user: $ADMIN_USER"
fi

echo "=== Starting Linux Mint Openbox Kiosk Setup ==="

# 1. Install Openbox, Zenity, wmctrl, and temporary setup tools
echo "Installing Openbox, Zenity, wmctrl, and setup tools..."
apt update && apt install -y openbox zenity wmctrl curl jq

echo "Fetching latest release details from GitHub..."
DEB_URL=$(curl -s https://api.github.com/repos/jkahtava-cityssm/electron-kiosk/releases/latest \
  | jq -r '.assets[] | select(.name | endswith("amd64.deb")) | .browser_download_url')

if [ -z "$DEB_URL" ] || [ "$DEB_URL" == "null" ]; then
    echo "Error: Could not find an amd64.deb file in the latest GitHub release."
    apt purge -y curl jq
    apt autoremove -y --purge
    exit 1
fi

echo "Downloading $DEB_URL..."
TEMP_DEB="/tmp/electron-kiosk_latest_amd64.deb"
curl -L "$DEB_URL" -o "$TEMP_DEB"

echo "Installing electron-kiosk..."
apt install -y "$TEMP_DEB"
rm "$TEMP_DEB"

# 2. Hardening: Uninstall temporary download tools and clean up orphan dependencies
echo "Hardening system: Uninstalling curl and jq..."
apt purge -y curl jq
apt autoremove -y --purge
apt clean

# 3. Create the Kiosk user (if it doesn't already exist)
if id "$KIOSK_USER" &>/dev/null; then
    echo "User '$KIOSK_USER' already exists."
else
    echo "Creating user '$KIOSK_USER'..."
    adduser --disabled-password --gecos "" "$KIOSK_USER"
fi

echo "Configuring passwordless login for '$KIOSK_USER'..."
# Create the 'nopasswdlogin' group if it doesn't already exist
if ! getent group nopasswdlogin &>/dev/null; then
    groupadd -r nopasswdlogin
fi
# Add the kiosk user to the passwordless login group
usermod -aG nopasswdlogin "$KIOSK_USER"

# 4. Create Openbox directories and add the custom Keybinds
echo "Configuring Openbox keybindings for the kiosk user..."
OB_CONFIG_DIR="/home/$KIOSK_USER/.config/openbox"
mkdir -p "$OB_CONFIG_DIR"

# Generate an Openbox configuration mapping:
# - C-A-S-e (Ctrl+Alt+Shift+E) to standard logout confirmation prompt
# - C-A-S-r (Ctrl+Alt+Shift+R) to restart electron-kiosk
cat << EOF > "$OB_CONFIG_DIR/rc.xml"
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc" xmlns:xi="http://www.w3.org/2001/XInclude">
  <keyboard>
    <!-- Admin Escape Shortcut: Ctrl + Alt + Shift + E -->
    <keybind key="C-A-S-e">
      <action name="Execute">
        <command>/usr/local/bin/kiosk-logout-prompt.sh</command>
      </action>
    </keybind>
    <!-- Kiosk Restart Shortcut: Ctrl + Alt + Shift + R -->
    <keybind key="C-A-S-r">
      <action name="Execute">
        <command>pkill -f electron-kiosk</command>
      </action>
    </keybind>
  </keyboard>
  <applications>
    <!-- Force Zenity dialogs to stay focused, centered, and always on top of the Electron kiosk -->
    <application class="Zenity" name="zenity">
      <focus>yes</focus>
      <layer>above</layer>
      <center>yes</center>
    </application>
  </applications>
</openbox_config>
EOF

# 5. Create the Interactive Logout Prompt Script (with multi-launch avoidance & focus forcing)
echo "Creating the admin logout prompt script..."
cat << 'EOF' > /usr/local/bin/kiosk-logout-prompt.sh
#!/bin/bash

# Define a self-cleaning lock directory path using the user's systemd runtime directory
USER_UID=$(id -u)
RUNTIME_DIR="/run/user/$USER_UID"

if [ -d "$RUNTIME_DIR" ]; then
    LOCKDIR="$RUNTIME_DIR/kiosk_logout_prompt.lock"
else
    LOCKDIR="/tmp/kiosk_logout_prompt_$USER_UID.lock"
fi

# Prevent multiple dialogs from spawning if the keys are held down
if ! mkdir "$LOCKDIR" 2>/dev/null; then
    # Another instance of this dialog is already open. 
    # Instead of exiting silently, let's aggressively bring the existing Zenity dialog to the front!
    wmctrl -R "Admin Verification" 2>/dev/null
    exit 0
fi

# Ensure the lock directory is deleted on standard cancel/close events
trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT

# Background helper: Wait briefly for the Zenity window to spawn, then force it to focus & layer on top
(
    # Poll up to 1.5 seconds for the window to appear
    for i in {1..15}; do
        if wmctrl -l | grep -q "Admin Verification"; then
            # Found it! Bring to current desktop, raise window, set 'always on top', and focus keyboard
            wmctrl -R "Admin Verification"
            wmctrl -a "Admin Verification"
            wmctrl -r "Admin Verification" -b add,above
            break
        fi
        sleep 0.1
    done
) &

# Use zenity to pop up a clean, modern question dialog box
zenity --question \
       --title="Admin Verification" \
       --text="Are you sure you want to end this session?" \
       --ok-label="Log Out" \
       --cancel-label="Cancel" \
       --width=350

if [ $? -eq 0 ]; then
    # Manually clean up right before triggering the kill switch, 
    # though systemd will wipe the /run/user/UID directory anyway!
    rmdir "$LOCKDIR" 2>/dev/null
    loginctl terminate-session self
fi
EOF

chmod +x /usr/local/bin/kiosk-logout-prompt.sh

# 6. Pre-configure the Electron App's config.json
echo "Pre-configuring Electron application URL..."
APP_CONFIG_DIR="/home/$KIOSK_USER/.config/electron-kiosk"
mkdir -p "$APP_CONFIG_DIR"
cat << EOF > "$APP_CONFIG_DIR/config.json"
{
  "url": "$KIOSK_URL"
}
EOF

# Fix permissions across the home directory files
chown -R $KIOSK_USER:$KIOSK_USER /home/$KIOSK_USER/.config

# 7. Create the Kiosk execution script
echo "Creating kiosk launch script..."
cat << 'EOF' > /usr/local/bin/kiosk-session.sh
#!/bin/bash

# Extra fail-safe cleanup: Clear user's session-lock when starting up
uid=$(id -u)
rm -rf "/run/user/$uid/kiosk_logout_prompt.lock"
rm -rf "/tmp/kiosk_logout_prompt_$uid.lock"

# Force standard environment pathing and map to primary display
export DISPLAY=:0
export DBUS_SESSION_BUS_ADDRESS=autolaunch:

# Disable screen saver, screen blanking, and power saving
xset -dpms
xset s off
xset s noblank

# Start Openbox window manager in the background using our custom configuration
openbox --config-file /home/kiosk/.config/openbox/rc.xml &

# Persistent loop to restart the app if a user somehow closes it
while true; do
    electron-kiosk
    sleep 2
done
EOF

chmod +x /usr/local/bin/kiosk-session.sh

# 7.5 Create a LightDM session wrapper to force session assignment by username
echo "Creating the session-wrapper override script..."
cat << 'EOF' > /usr/local/bin/kiosk-session-wrapper.sh
#!/bin/bash
# $1 is the path to the session executable passed by LightDM

case "$USER" in
    kiosk)
        # Force the kiosk script no matter what LightDM or .dmrc requested
        exec /usr/local/bin/kiosk-session.sh
        ;;
    *)
        # Allow admin/other users to run their selected session normally
        exec "$@"
        ;;
esac
EOF

chmod +x /usr/local/bin/kiosk-session-wrapper.sh


# 7.8 Create a LightDM Login Cleanup Script
# This runs as root whenever ANY user logs in, completely deleting any persistent locks.
echo "Creating the LightDM session-setup cleaner hook..."
cat << 'EOF' > /usr/local/bin/kiosk-login-cleanup.sh
#!/bin/bash
# This script is executed by LightDM as root immediately before a session starts.

# 1. Clean up temporary directory locks for all potential login users
rm -rf /tmp/kiosk_logout_prompt_*.lock

# 2. Clean up dynamic user runtime directory locks
for user_dir in /run/user/*; do
    if [ -d "$user_dir" ]; then
        rm -rf "$user_dir/kiosk_logout_prompt.lock"
    fi
done

exit 0
EOF

chmod +x /usr/local/bin/kiosk-login-cleanup.sh


# 8. Create the strict XSession desktop file with NoDisplay enabled
echo "Creating XSession desktop file..."
cat << EOF > /usr/share/xsessions/kiosk.desktop
[Desktop Entry]
Version=1.0
Name=Kiosk Mode
Comment=Directly boots into the Kiosk script using Openbox
Exec=/usr/local/bin/kiosk-session.sh
Icon=openbox
Type=Application
DesktopNames=Openbox
NoDisplay=true
EOF

# 8.5 Hide default system sessions from the login menu chooser
echo "Hiding Openbox and XFCE desktop session choices..."
for session in "openbox.desktop" "xfce.desktop"; do
    FILE_PATH="/usr/share/xsessions/$session"
    if [ -f "$FILE_PATH" ]; then
        # Remove any existing NoDisplay entry to prevent duplicates, then append it fresh
        sed -i '/^NoDisplay=/d' "$FILE_PATH"
        echo "NoDisplay=true" >> "$FILE_PATH"
        echo "-> Successfully modified $session"
    else
        echo "-> Warning: $session not found, skipping."
    fi
done

# 9. Explicitly override AccountsService targets for both users
echo "Configuring AccountsService session targets..."
mkdir -p /var/lib/AccountsService/users

# Configure Kiosk user session target
cat << EOF > /var/lib/AccountsService/users/$KIOSK_USER
[User]
Session=kiosk
XSession=kiosk
Icon=/usr/share/pixmaps/faces/user-generic.png
SystemAccount=false
EOF

# Configure Admin user session target to force Xfce
echo "Configuring AccountsService session target for $ADMIN_USER..."
cat << EOF > /var/lib/AccountsService/users/$ADMIN_USER
[User]
Session=xfce
XSession=xfce
Icon=/usr/share/pixmaps/faces/user-generic.png
SystemAccount=false
EOF

# --- CRITICAL XFCE RESET FIX ---
echo "Forcibly resetting XFCE configurations to Linux Mint defaults for $ADMIN_USER..."

# 1. Stop active XFCE daemons running under the admin user's name
pkill -u "$ADMIN_USER" -x xfce4-panel
pkill -u "$ADMIN_USER" -x xfconfd
pkill -u "$ADMIN_USER" -x xfsettingsd

# 2. Clean out the broken configs and cached XFCE session states
ADMIN_HOME="/home/$ADMIN_USER"
rm -rf "$ADMIN_HOME/.config/xfce4"
rm -rf "$ADMIN_HOME/.cache/sessions"

# 3. Create a clean structure and inject Mint's true design defaults
mkdir -p "$ADMIN_HOME/.config"
if [ -d "/usr/share/mint-artwork/xfce/xfce4" ]; then
    cp -r /usr/share/mint-artwork/xfce/xfce4 "$ADMIN_HOME/.config/"
    echo "-> Successfully restored Linux Mint XFCE system templates"
else
    # Fallback to general system configurations if artwork is missing
    mkdir -p "$ADMIN_HOME/.config/xfce4/xfconf"
    cp -r /etc/xdg/xfce4/xfconf/xfce-perchannel-xml "$ADMIN_HOME/.config/xfce4/xfconf/"
    echo "-> Fallback: copied standard system etc/xdg profiles"
fi

# 4. Correctly lock permissions to the Admin User
chown -R "$ADMIN_USER:$ADMIN_USER" "$ADMIN_HOME/.config"
# -------------------------------

# 10. Configure LightDM for automatic login
echo "Configuring LightDM auto-login..."
mkdir -p /etc/lightdm/lightdm.conf.d
cat << EOF > /etc/lightdm/lightdm.conf.d/70-kiosk.conf
[Seat:*]
autologin-user=$KIOSK_USER
autologin-user-timeout=0
user-session=kiosk
autologin-session=kiosk
session-wrapper=/usr/local/bin/kiosk-session-wrapper.sh
session-setup-script=/usr/local/bin/kiosk-login-cleanup.sh
EOF

# 10.5 Generate and lock user .dmrc files
echo "Seeding default .dmrc session files..."

# Kiosk .dmrc
echo -e "[Desktop]\nSession=kiosk" > /home/$KIOSK_USER/.dmrc
chown $KIOSK_USER:$KIOSK_USER /home/$KIOSK_USER/.dmrc
chmod 644 /home/$KIOSK_USER/.dmrc

# Admin .dmrc
echo -e "[Desktop]\nSession=xfce" > /home/$ADMIN_USER/.dmrc
chown $ADMIN_USER:$ADMIN_USER /home/$ADMIN_USER/.dmrc
chmod 644 /home/$ADMIN_USER/.dmrc

# 11. Prevent manual desktop/session selection on the LightDM login screen
echo "Hiding desktop environment session chooser from login screen..."
mkdir -p /etc/lightdm
cat << EOF > /etc/lightdm/slick-greeter.conf
[Greeter]
show-sessions=false
EOF

echo "=== Setup Complete! ==="
echo "The system is perfectly integrated. Reboot your computer to test the final kiosk installation."

# Reboot countdown hook
for i in {10..1}; do
    echo -ne "Rebooting in $i seconds... Press ANY KEY to cancel the reboot.\r"
    
    # -t 1 waits exactly 1 second for a single character input
    read -r -s -n 1 -t 1 key_pressed
    if [ $? -eq 0 ]; then
        echo -e "\n\n[!] Reboot canceled. You can now inspect the system or manually reboot later."
        exit 0
    fi
done

echo -e "\n\nNo key pressed. Rebooting now..."
sleep 1
reboot