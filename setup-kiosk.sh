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

echo "=== Starting Linux Mint Openbox Kiosk Setup ==="

# 1. Install Openbox and temporary tools
echo "Installing Openbox and temporary setup tools (curl, jq)..."
apt update && apt install -y openbox curl jq

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

# 4. Create Openbox directories and add the custom Ctrl+Alt+Shift+E Keybind
echo "Configuring Openbox keybindings for the kiosk user..."
OB_CONFIG_DIR="/home/$KIOSK_USER/.config/openbox"
mkdir -p "$OB_CONFIG_DIR"

# Generate an Openbox configuration mapping C-A-S-e (Ctrl+Alt+Shift+E) to our countdown helper
cat << EOF > "$OB_CONFIG_DIR/rc.xml"
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc" xmlns:xi="http://www.w3.org/2001/XInclude">
  <keyboard>
    <!-- Admin Escape Shortcut: Ctrl + Alt + Shift + E -->
    <keybind key="C-A-S-e">
      <action name="Execute">
        <command>/usr/local/bin/kiosk-logout-countdown.sh</command>
      </action>
    </keybind>
  </keyboard>
</openbox_config>
EOF

# 5. Create the 5-Second Countdown Script
echo "Creating the admin countdown helper script..."
cat << 'EOF' > /usr/local/bin/kiosk-logout-countdown.sh
#!/bin/bash
export DISPLAY=:0

# Display a 5-second progress countdown dialog
(
for i in {1..5}; do
    echo "$((i * 20))"
    echo "# Switching to Login in $((5 - i)) seconds..."
    sleep 1
done
) | zenity --progress --title="Admin Verification" --text="Initializing..." --percentage=0 --timeout=5 --auto-close --width=350 --no-cancel

# If the countdown finishes without being forced shut or interrupted, switch to the greeter
if [ $? -eq 0 ]; then
    dm-tool switch-to-greeter
fi
EOF
chmod +x /usr/local/bin/kiosk-logout-countdown.sh

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

# Give the display server a moment to fully initialize
sleep 3

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

# 8. Create the strict XSession desktop file
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
EOF

# 9. Explicitly override AccountsService to force XFCE to respect the session choice
echo "Configuring AccountsService session target..."
mkdir -p /var/lib/AccountsService/users
cat << EOF > /var/lib/AccountsService/users/$KIOSK_USER
[User]
Session=kiosk
XSession=kiosk
Icon=/usr/share/pixmaps/faces/user-generic.png
SystemAccount=false
EOF

# 10. Configure LightDM for automatic login
echo "Configuring LightDM auto-login..."
mkdir -p /etc/lightdm/lightdm.conf.d
cat << EOF > /etc/lightdm/lightdm.conf.d/70-kiosk.conf
[SeatDefaults]
autologin-user=$KIOSK_USER
autologin-user-timeout=0
user-session=kiosk
EOF

echo "=== Setup Complete! ==="
echo "The system is perfectly integrated. Reboot your computer to test the final kiosk installation."