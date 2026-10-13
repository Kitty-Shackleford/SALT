#!/usr/bin/env bash
set -euo pipefail

# Provision a hermes user with key-based SSH and passwordless sudo.
# Usage: sudo PUBLIC_KEY="$(<~/.ssh/id_ed25519.pub)" bash provision_hermes.sh

USERNAME="${USERNAME:-hermes}"
PUBLIC_KEY="${PUBLIC_KEY:-}"
SUDOERS_FILE="/etc/sudoers.d/${USERNAME}"
SSH_CONFIG="/etc/ssh/sshd_config"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "This script must be run as root. Use: sudo bash $0"
    exit 2
  fi
  if [ -z "$PUBLIC_KEY" ]; then
    echo "PUBLIC_KEY is required; pass the public key through the environment."
    exit 2
  fi
}

user_create() {
  if id -u "$USERNAME" >/dev/null 2>&1; then
    echo "User $USERNAME already exists. Skipping useradd."
  else
    echo "Creating user $USERNAME..."
    useradd -m -s /bin/bash -G sudo -d "/home/$USERNAME" -c "Hermes agent" "$USERNAME"
    echo "User created."
  fi
}

install_key() {
  local homedir="/home/$USERNAME"
  local sshdir="$homedir/.ssh"
  local authfile="$sshdir/authorized_keys"

  mkdir -p "$sshdir"
  chown "$USERNAME:$USERNAME" "$sshdir"
  chmod 700 "$sshdir"

  if [ -f "$authfile" ]; then
    if grep -Fxq -- "$PUBLIC_KEY" "$authfile"; then
      echo "Public key already present in $authfile."
    else
      echo "Backing up existing authorized_keys to ${authfile}.bak.$TIMESTAMP and appending key."
      cp -- "$authfile" "${authfile}.bak.$TIMESTAMP"
      printf '%s\n' "$PUBLIC_KEY" >> "$authfile"
    fi
  else
    printf '%s\n' "$PUBLIC_KEY" > "$authfile"
  fi

  chown "$USERNAME:$USERNAME" "$authfile"
  chmod 600 "$authfile"
  echo "Installed SSH public key for $USERNAME."
}

install_sudoers() {
  echo "Installing sudoers file $SUDOERS_FILE (NOPASSWD for $USERNAME)."
  printf '%s\n' "$USERNAME ALL=(ALL) NOPASSWD:ALL" > "$SUDOERS_FILE"
  chmod 440 "$SUDOERS_FILE"
}

disable_password_auth() {
  # Backup sshd_config
  local backup="${SSH_CONFIG}.bak.$TIMESTAMP"
  if [ -f "$SSH_CONFIG" ]; then
    cp -- "$SSH_CONFIG" "$backup"
  fi

  # Set PasswordAuthentication to no. If the directive is present (commented or not) change it; otherwise append.
  if grep -Ei '^\s*PasswordAuthentication\s+' "$SSH_CONFIG" >/dev/null 2>&1; then
    sed -ri 's/^\s*#?\s*PasswordAuthentication\s+.*/PasswordAuthentication no/' "$SSH_CONFIG"
  else
    printf '\n# Enforce key-only auth\nPasswordAuthentication no\n' >> "$SSH_CONFIG"
  fi

  echo "PasswordAuthentication set to no in $SSH_CONFIG (backup at $backup)."

  # Restart sshd
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart sshd || systemctl restart ssh || true
  else
    service ssh restart || service sshd restart || true
  fi
}

verify() {
  echo "Verification:" 
  if id -u "$USERNAME" >/dev/null 2>&1; then
    echo " - user exists: OK"
  else
    echo " - user missing: FAIL"
  fi
  echo " - /home/$USERNAME: "
  ls -ld "/home/$USERNAME" || true
  echo " - /home/$USERNAME/.ssh/authorized_keys:"
  ls -l "/home/$USERNAME/.ssh/authorized_keys" || true
  echo " - sudoers file:"
  if [ -f "$SUDOERS_FILE" ]; then
    echo "   $SUDOERS_FILE present";
  else
    echo "   $SUDOERS_FILE missing";
  fi
  echo " - SSHD PasswordAuthentication directive now:" 
  grep -Ei '^\s*PasswordAuthentication' "$SSH_CONFIG" || true
}

main() {
  require_root
  user_create
  install_key
  install_sudoers
  disable_password_auth
  verify
  echo "Done. To test from another machine: ssh -i ~/.ssh/hermes_agent_id $USERNAME@<server-ip>"
  echo "If you want a more restrictive sudo rule instead of NOPASSWD, edit $SUDOERS_FILE and replace with a limited command list."
}

main "$@"
