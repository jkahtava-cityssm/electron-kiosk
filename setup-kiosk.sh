#!/bin/bash

# Ensure the script is run as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run this script as root (use sudo)."
  exit 1
fi

# ================= CONFIGURATION =================
KIOSK_USER="kiosk"
KIOSK_URL="https://ssmpl.bibliocommons.com"
KIOSK_NAV_POSITION="bottom-left" # Choices: top-left, top-right, bottom-left, bottom-right
KIOSK_IDLE_MINUTES=10            # Inactivity timeout in minutes (0 to disable)
# =================================================

# 0. Detect Linux Mint Desktop Environment Flavor
if [ -f /etc/linuxmint/info ]; then
    . /etc/linuxmint/info
fi

if [ "$EDITION" = "Xfce" ]; then
    echo "Detected Linux Mint XFCE (Lightweight Edition)."
    ADMIN_SESSION="xfce"
elif [ "$EDITION" = "Cinnamon" ]; then
    echo "Detected Linux Mint Cinnamon (Standard Edition)."
    ADMIN_SESSION="cinnamon"
elif [ "$EDITION" = "MATE" ]; then
    echo "Detected Linux Mint MATE (Classic Edition)."
    ADMIN_SESSION="mate"
else
    echo "Error: Unsupported or missing Linux Mint Desktop environment detected ('$EDITION')."
    echo "This script only supports XFCE, Cinnamon, or MATE. Exiting setup."
    exit 1
fi

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
apt update && apt install -y openbox zenity wmctrl xprintidle xdotool curl jq

# Check if electron-kiosk is already installed and remove it
if dpkg -s electron-kiosk &>/dev/null; then
    echo "Existing installation of electron-kiosk detected. Removing it first..."
    apt purge -y electron-kiosk
else
    echo "No existing installation of electron-kiosk detected."
fi

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
if ! getent group nopasswdlogin &>/dev/null; then
    groupadd -r nopasswdlogin
fi
usermod -aG nopasswdlogin "$KIOSK_USER"

# 4. Create Openbox directories and add the custom Keybinds
echo "Configuring Openbox keybindings for the kiosk user..."
OB_CONFIG_DIR="/home/$KIOSK_USER/.config/openbox"
mkdir -p "$OB_CONFIG_DIR"

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

# 5. Create the Interactive Logout Prompt Script
echo "Creating the admin logout prompt script..."
cat << 'EOF' > /usr/local/bin/kiosk-logout-prompt.sh
#!/bin/bash

USER_UID=$(id -u)
RUNTIME_DIR="/run/user/$USER_UID"

if [ -d "$RUNTIME_DIR" ]; then
    LOCKDIR="$RUNTIME_DIR/kiosk_logout_prompt.lock"
else
    LOCKDIR="/tmp/kiosk_logout_prompt_$USER_UID.lock"
fi

if ! mkdir "$LOCKDIR" 2>/dev/null; then
    wmctrl -R "Admin Verification" 2>/dev/null
    exit 0
fi

trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT

(
    for i in {1..15}; do
        if wmctrl -l | grep -q "Admin Verification"; then
            wmctrl -R "Admin Verification"
            wmctrl -a "Admin Verification"
            wmctrl -r "Admin Verification" -b add,above
            break
        fi
        sleep 0.1
    done
) &

zenity --question \
       --title="Admin Verification" \
       --text="Are you sure you want to end this session and switch users?" \
       --ok-label="Switch User" \
       --cancel-label="Cancel" \
       --width=350

if [ $? -eq 0 ]; then
    rmdir "$LOCKDIR" 2>/dev/null

    # 1. Signal intentional admin exit
    touch /tmp/admin_switch_flag

    # 2. Kill kiosk session to drop back to greeter
    pkill -KILL -u kiosk
fi
EOF

chmod +x /usr/local/bin/kiosk-logout-prompt.sh

# 6. Pre-configure the Electron App's config.json
echo "Pre-configuring Electron application URL..."
APP_CONFIG_DIR="/home/$KIOSK_USER/.config/electron-kiosk"
mkdir -p "$APP_CONFIG_DIR"
cat << EOF > "$APP_CONFIG_DIR/config.json"
{
  "url": "$KIOSK_URL",
  "position": "$KIOSK_NAV_POSITION"
}
EOF

# 7. Create the Kiosk execution script
echo "Creating kiosk launch script..."
cat << EOF > /usr/local/bin/kiosk-session.sh
#!/bin/bash

# Clear leftover locks
uid=\$(id -u)
rm -rf "/run/user/\$uid/kiosk_logout_prompt.lock"
rm -rf "/tmp/kiosk_logout_prompt_\$uid.lock"

export DISPLAY=:0
export DBUS_SESSION_BUS_ADDRESS=autolaunch:

# Disable screen saver, screen blanking, and display sleep
xset -dpms
xset s off
xset s noblank

# Start Openbox
openbox --config-file /home/$KIOSK_USER/.config/openbox/rc.xml &

# --- IN-SESSION IDLE RESET DAEMON ---
IDLE_LIMIT_MINS=$KIOSK_IDLE_MINUTES

if [ "\$IDLE_LIMIT_MINS" -gt 0 ]; then
    IDLE_LIMIT_MS=\$(( IDLE_LIMIT_MINS * 60 * 1000 ))
    (
        export DISPLAY=:0
        while true; do
            sleep 3
            
            IS_ACTIVE=\$(loginctl show-session \$(loginctl | grep $KIOSK_USER | awk '{print \$1}') -p Active --value 2>/dev/null)
            
            if [ "\$IS_ACTIVE" = "yes" ]; then
                CURRENT_IDLE=\$(xprintidle 2>/dev/null)
                
                if [[ "\$CURRENT_IDLE" =~ ^[0-9]+\$ ]] && [ "\$CURRENT_IDLE" -ge "\$IDLE_LIMIT_MS" ]; then
                    echo "Idle threshold reached (\$IDLE_LIMIT_MINS mins). Resetting kiosk session..."
                    pkill -KILL -u $KIOSK_USER
                    break
                fi
            fi
        done
    ) &
fi
# ------------------------------------

# App Launcher
while true; do
    sleep 1
    electron-kiosk
done
EOF

chmod +x /usr/local/bin/kiosk-session.sh

# 7.5 Session wrapper script
echo "Creating the session-wrapper override script..."
cat << 'EOF' > /usr/local/bin/kiosk-session-wrapper.sh
#!/bin/bash
case "$USER" in
    kiosk)
        exec /usr/local/bin/kiosk-session.sh
        ;;
    *)
        exec "$@"
        ;;
esac
EOF

chmod +x /usr/local/bin/kiosk-session-wrapper.sh

# 7.7 LightDM Restart Cleanup Hook
echo "Creating the LightDM session-cleanup hook..."
cat << 'EOF' > /usr/local/bin/kiosk-logout-restart.sh
#!/bin/bash
if [ "$USER" = "kiosk" ]; then
    if [ -f /tmp/admin_switch_flag ]; then
        rm -f /tmp/admin_switch_flag
    else
        systemctl restart lightdm
    fi
fi
EOF

chmod +x /usr/local/bin/kiosk-logout-restart.sh

# 7.8 LightDM Login Cleanup Script
echo "Creating the LightDM session-setup cleaner hook..."
cat << EOF > /usr/local/bin/kiosk-login-cleanup.sh
#!/bin/bash

rm -rf /tmp/kiosk_logout_prompt_*.lock
rm -f /tmp/admin_switch_flag

for user_dir in /run/user/*; do
    if [ -d "\$user_dir" ]; then
        rm -rf "\$user_dir/kiosk_logout_prompt.lock"
    fi
done

if [ "\$USER" = "$KIOSK_USER" ]; then
    if [ -d "/opt/kiosk_template" ]; then
        echo "Resetting kiosk user profile..."
        find /home/$KIOSK_USER -mindepth 1 -delete 2>/dev/null
        cp -a /opt/kiosk_template/. /home/$KIOSK_USER/
        chown -R $KIOSK_USER:$KIOSK_USER /home/$KIOSK_USER
    fi
fi

exit 0
EOF

chmod +x /usr/local/bin/kiosk-login-cleanup.sh

# 8. Create XSession desktop file
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

# 8.5 Hide default system sessions
echo "Hiding default desktop session choices..."
SESSION_LIST=("openbox.desktop")
if [ "$ADMIN_SESSION" = "xfce" ]; then
    SESSION_LIST+=("xfce.desktop")
elif [ "$ADMIN_SESSION" = "mate" ]; then
    SESSION_LIST+=("mate.desktop")
else
    SESSION_LIST+=("cinnamon.desktop" "cinnamon2d.desktop")
fi

for session in "${SESSION_LIST[@]}"; do
    FILE_PATH="/usr/share/xsessions/$session"
    if [ -f "$FILE_PATH" ]; then
        sed -i '/^NoDisplay=/d' "$FILE_PATH"
        echo "NoDisplay=true" >> "$FILE_PATH"
        echo "-> Successfully modified $session"
    else
        echo "-> Warning: $session not found, skipping."
    fi
done

# 9. Configure AccountsService
echo "Configuring AccountsService session targets..."
mkdir -p /var/lib/AccountsService/users

cat << EOF > /var/lib/AccountsService/users/$KIOSK_USER
[User]
Session=kiosk
XSession=kiosk
Icon=/usr/share/pixmaps/faces/user-generic.png
SystemAccount=false
EOF

cat << EOF > /var/lib/AccountsService/users/$ADMIN_USER
[User]
Session=$ADMIN_SESSION
XSession=$ADMIN_SESSION
Icon=/usr/share/pixmaps/faces/user-generic.png
SystemAccount=false
EOF

ADMIN_HOME="/home/$ADMIN_USER"
if [ "$ADMIN_SESSION" = "xfce" ]; then
    echo "Resetting XFCE configurations to Linux Mint defaults for $ADMIN_USER..."
    pkill -u "$ADMIN_USER" -x xfce4-panel 2>/dev/null
    pkill -u "$ADMIN_USER" -x xfconfd 2>/dev/null
    pkill -u "$ADMIN_USER" -x xfsettingsd 2>/dev/null

    rm -rf "$ADMIN_HOME/.config/xfce4"
    rm -rf "$ADMIN_HOME/.cache/sessions"

    mkdir -p "$ADMIN_HOME/.config"
    if [ -d "/usr/share/mint-artwork/xfce/xfce4" ]; then
        cp -r /usr/share/mint-artwork/xfce/xfce4 "$ADMIN_HOME/.config/"
    else
        mkdir -p "$ADMIN_HOME/.config/xfce4/xfconf"
        cp -r /etc/xdg/xfce4/xfconf/xfce-perchannel-xml "$ADMIN_HOME/.config/xfce4/xfconf/"
    fi
fi

if [ -d "$ADMIN_HOME/.config" ]; then
    chown -R "$ADMIN_USER:$ADMIN_USER" "$ADMIN_HOME/.config"
fi

# 10. Configure LightDM
echo "Configuring LightDM auto-login..."
mkdir -p /etc/lightdm/lightdm.conf.d
cat << EOF > /etc/lightdm/lightdm.conf.d/70-kiosk.conf
[Seat:*]
autologin-user=$KIOSK_USER
autologin-user-timeout=0
session-wrapper=/usr/local/bin/kiosk-session-wrapper.sh
session-setup-script=/usr/local/bin/kiosk-login-cleanup.sh
session-cleanup-script=/usr/local/bin/kiosk-logout-restart.sh
autologin-in-background=false
pam-autologin-service=lightdm-autologin
EOF

# 10.5 Seed user .dmrc files
echo "Seeding default .dmrc session files..."
echo -e "[Desktop]\nSession=kiosk" > /home/$KIOSK_USER/.dmrc
chmod 644 /home/$KIOSK_USER/.dmrc

echo -e "[Desktop]\nSession=$ADMIN_SESSION" > /home/$ADMIN_USER/.dmrc
chown $ADMIN_USER:$ADMIN_USER /home/$ADMIN_USER/.dmrc
chmod 644 /home/$ADMIN_USER/.dmrc

# Set permissions for kiosk user home before snapshotting
chown -R $KIOSK_USER:$KIOSK_USER /home/$KIOSK_USER

# 10.8 Create pristine kiosk home template NOW (after all files are placed)
echo "Creating pristine kiosk home directory template..."
rm -rf /opt/kiosk_template
mkdir -p /opt/kiosk_template
cp -a /home/$KIOSK_USER/. /opt/kiosk_template/

# 11. Hide session chooser from greeter
echo "Hiding desktop environment session chooser from login screen..."
mkdir -p /etc/lightdm
cat << EOF > /etc/lightdm/slick-greeter.conf
[Greeter]
show-sessions=false
EOF

echo "=== Setup Complete! ==="
echo "The system is perfectly integrated. Reboot your computer to test the final kiosk installation."

for i in {10..1}; do
    echo -ne "Rebooting in $i seconds... Press ANY KEY to cancel the reboot.\r"
    read -r -s -n 1 -t 1 key_pressed
    if [ $? -eq 0 ]; then
        echo -e "\n\n[!] Reboot canceled. You can now inspect the system or manually reboot later."
        exit 0
    fi
done

echo -e "\n\nNo key pressed. Rebooting now..."
sleep 1
reboot