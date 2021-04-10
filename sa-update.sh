#!/bin/sh

sa-update --gpghomedir /var/lib/spamassassin/sa-update-keys
rc1=$?
sa-update --nogpg --channel spamassassin.heinlein-support.de
rc2=$?

if [ $rc1 -eq 0 ] || [ $rc2 -eq 0 ]; then
    # An update is available
    sa-compile
    chmod -R go-w,go+rX /var/lib/spamassassin/compiled
fi