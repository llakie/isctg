FROM node:15.12.0-alpine3.13


# spamassassin-client = spamc
# spamassassin-openrc = spamd
RUN apk update && apk add spamassassin \
                          spamassassin-openrc \
                          spamassassin-client \
                          make \
                          alpine-sdk \
                          nano \
                          openrc \
                          rsyslog \
                          db-dev \
                          perl-db \
                          perl-dev \
                          perl-app-cpanminus

# openrc needs this
VOLUME /sys/fs/cgroup

# Build and install Perl DB_file package
RUN cpanm DB_File::HASHINFO

# Update Spamassassin rules
RUN sa-update

RUN mkdir -p /root/.spamassassin

# Copy .spamassassin user preferences
COPY docker/root/.spamassassin/user_prefs /root/.spamassassin

# Add spamd service at default (user) run-level (Since Alpine uses PID 1, openrc will complain --> softlevel)
RUN rc-update add spamd default && mkdir /run/openrc && touch /run/openrc/softlevel

# Modify the syslog configuration to stop logging kernel events
COPY docker/etc/rsyslog.conf /etc

# Allow tell options for spam daemon
COPY docker/etc/conf.d/spamd /etc/conf.d

# Create all the needed folders
RUN mkdir -p /app

WORKDIR /app

COPY package.json yarn.lock ./

RUN yarn

COPY index.js run.sh ./

RUN chmod +x run.sh

VOLUME /app/data

CMD [ "./run.sh" ]