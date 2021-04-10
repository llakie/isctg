FROM node:15.12.0-alpine3.13

RUN apk update && apk add spamassassin \
                          spamassassin-openrc \
                          spamassassin-client \
                          spamassassin-compiler \
                          make \
                          alpine-sdk \
                          nano \
                          openrc \
                          rsyslog \
                          db-dev \
                          perl-db \
                          perl-dev \
                          perl-app-cpanminus \
                          unbound

# openrc needs this
VOLUME /sys/fs/cgroup

# Build and install Perl DB_file package
RUN cpanm DB_File::HASHINFO

# Add spamd service at default (user) run-level (Since Alpine uses PID 1, openrc will complain --> softlevel)
RUN rc-update add spamd default && mkdir /run/openrc && touch /run/openrc/softlevel

# Add DNS service at default
RUN rc-update add unbound default

# Copy .spamassassin user preferences
# COPY docker/root/.spamassassin/user_prefs /root/.spamassassin
COPY docker/etc/mail/spamassassin/local.cf /etc/mail/spamassassin

# Copy DNS configuration
COPY docker/etc/unbound/unbound.conf /etc/unbound

# Modify the syslog configuration to stop logging kernel events
COPY docker/etc/rsyslog.conf /etc

# Allow tell options for spam daemon
COPY docker/etc/conf.d/spamd /etc/conf.d

RUN mkdir /etc/mail/spamassassin/plugins/

WORKDIR /tmp

# From Reply header SA PlugIn
RUN wget https://github.com/extremeshok/spamassassin-extremeshok_fromreplyto/archive/1.3.1.tar.gz
RUN tar -zxvf 1.3.1.tar.gz
RUN cp /tmp/spamassassin-extremeshok_fromreplyto-1.3.1/plugins/* /etc/mail/spamassassin/plugins/
RUN cp /tmp/spamassassin-extremeshok_fromreplyto-1.3.1/01_extremeshok_fromreplyto.cf /etc/mail/spamassassin

# Create all the needed folders
RUN mkdir -p /app

WORKDIR /app

COPY package.json yarn.lock ./

RUN yarn

COPY index.js run.sh sa-update.sh ./

RUN chmod +x run.sh && chmod +x sa-update.sh

VOLUME /app/data

CMD [ "./run.sh" ]