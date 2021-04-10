#!/bin/sh

# Create all needed directories
mkdir -p /app/data/.spamassassin/db

rc-status boot
rc-service rsyslog restart

unbound-checkconf

rc-status default
rc-service unbound restart

./sa-update.sh

rc-status default
rc-service spamd restart

node index.js