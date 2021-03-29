# ISCTG - IMAP Spam Container "To Go"

## Introduction

Are you tired of Spam? Do you want to have your spamfilter run on your NAS? The target of this project is, to make this achievable as easy as possible. One IMAP account per container.

## Supported architectures

- AMD64
- ARM64

## How to build it

The image is built using `docker buildx` build system. You can also get the latest version from DockerHUB _llakie/isctg_

### Prepare your builder

- `docker buildx create --name multi-arch-builder`
- `docker buildx ls`<br>
  Check, that the _docker-container_ driver is used for your newly created _multi-archi-builder_
- `docker buildx use multi-arch-builder`
- `docker buildx inspect --bootstrap`<br>
  Starts your build container

### Build the image

- `docker buildx build --platform linux/amd64,linux/arm64 -f docker/Dockerfile -t isctg:latest .`

## How to run it

- You need to create a data directory of the following structure
  
  ```text
  <data dir>
  L- config.json
  ```

  During runtime a _.spamassassin_ folder will be created automatically inside the data directory for persistence reasons.

- Your _config.json_ has to have the following format

  ```json
  {
    "imap": {                       // This config block will be passed directly to node-imap. So all options can be specified as of this module
        "host": "",                 
        "port": 993,
        "user": "",
        "password": "",
        "tls": true,
        "keepalive": true
    },
    "paths": {                      // Specify the full paths to the folders
        "inbox": "INBOX",           // Your mail inbox
        "ham": "INBOX.Ham",         // Training folder containing non-spam messages
        "spam": "INBOX.Spam"        // Training folder, which contains Spam messages
    },
    "spamassassin": {
        "minSpamScore": 5,          // This spam score has be exceeded for a message to be spam
        "maxHamScore": 2.5,         // This spam score has to be lower than this value for a message to be ham
        "batchSize": 100            // Maximum amount of messages, which will be processed as a single chunk of your inbox
    },
    "trackIntervalMs": 20000        // The infinite loop checkSpam, checkHam, checkInbox will be paused for the given amount of time
  }
  ```

- `docker run --rm -v <path to data dir>:/app/data isctg:latest`<br>
  OR<br>
  `docker run --rm -v <path to data dir>:/app/data llakie/isctg:latest`