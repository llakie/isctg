const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Imap = require('imap');
const Stream = require('stream');

class ImapClient {
    constructor(config) {
        this.config = config;
        this.imap = null;
    }

    connect() {
        if (this.imap !== null && this.imap.state !== 'disconnected') {
            return Promise.resolve(this.imap);
        }

        this.imap = new Imap(this.config);

        return new Promise((resolve, reject) => {
            this.imap.once('ready', () => {
                this.imap.off('error', reject);
                this.imap.on('error', this.__onImapError.bind(this));
                resolve(this.imap);
            });
    
            this.imap.once('error', reject);

            this.imap.connect();
        });
    }

    disconnect(graceful = true) {
        if (this.imap === null || this.imap.state === 'disconnected') {
            return;
        }

        if (graceful) {
            this.imap.end();
            return;
        }

        this.imap.destroy();
    }

    getMailboxPaths() {
        return this.__getClient()
            .then(client => {
                return new Promise((resolve, reject) => {
                    this.imap.getBoxes((err, mailboxes) => {
                        if (err) {
                            reject(err);
                        } else {
                            const mboxPaths = [];

                            const addMailboxPathsFor = (child, path, mboxPaths = []) => {
                                mboxPaths.push(path);
                                
                                if (!Object.prototype.hasOwnProperty.call(child, 'children')) {
                                    return mboxPaths;
                                }

                                for (let subFolder in child.children) {
                                    addMailboxPathsFor(child.children[subFolder], [path, subFolder].join(child.delimiter), mboxPaths);
                                }

                                return mboxPaths;
                            };

                            for (let mailbox of Object.keys(mailboxes)) {
                                addMailboxPathsFor(mailboxes[mailbox], mailbox, mboxPaths);
                            }

                            resolve(mboxPaths);
                        }
                    })
                });
            });
    }

    openMailbox(mboxPath) {
        return this.__getClient()
            .then(client => {
                if (client.__box) {
                    if (client.__box.name === mailbox) {
                        // Already opened --> internal API used
                        return;
                    }
                    
                    return this.closeMailbox().then(() => client);
                }

                return client;
            })
            .then(client => {
                return new Promise((resolve, reject) => {
                    client.openBox(mboxPath, (err, mbox) => {
                        if (err) {
                            reject(err);
                            return;
                        }
            
                        resolve(mbox);
                    })
                });
            });
    }

    closeMailbox() {
        return this.__getClient()
            .then(client => {
                return new Promise((resolve, reject) => {
                    client.closeBox(err => {
                        if (err) {
                            reject(err);
                            return;
                        }
            
                        resolve();
                    })
                });
            });
    }

    dumpMailbox(mboxPath, criteria, absPath, maxBytes) {
        console.log(`Dumping ${mboxPath} to ${absPath} with criteria ${criteria}`);
        
        return this.openMailbox(mboxPath)
            .then(() => {
                return new Promise((resolve, reject) => {
                    this.imap.search(criteria, (err, uids) => {
                        if (err) {
                            reject(err);
                        } else {
                            uids = uids.map(uid => parseInt(uid, 10));
                            uids.sort((a, b) => a - b);
                            resolve(uids);
                        }
                    });
                });
            })
            .then(uids => this.dumpMails(mboxPath, uids, absPath, maxBytes));
    }

    dumpMails(mboxPath, uids, absPath, maxBytes = 256000) {
        if (!fs.existsSync(absPath)) {
            fs.mkdirSync(absPath);
        }

        if (!fs.statSync(absPath).isDirectory()) {
            return Promise.reject(new Error(`absPath ${absPath} is not a directory`));
        }

        return this.openMailbox(mboxPath)
            .then(() => {
                return new Promise((resolve, reject) => {
                    const fetch = this.imap.fetch(uids, { bodies: '' });

                    let count = 0;

                    fetch.on('message', async (msg, seqno) => {
                        let _attrs = null;
                        let _stream = null;
                        let _size = 0;

                        msg.once('attributes', attrs => {
                            _attrs = attrs;
                        });
                        
                        msg.on('body', (stream, info) => {
                            _stream = stream;
                            _size = info.size;
                        });
                        
                        msg.once('end', () => {
                            if (_size <= maxBytes) {
                                // Filename resembles the uid of the message
                                _stream.pipe(fs.createWriteStream(path.resolve(absPath, _attrs.uid + '')));
                                count++;
                            } else {
                                console.log(`Mail ${_attrs.uid} exceeds max size. Expected size < ${maxBytes} Bytes. Got ${_size} Bytes. Skipping mail`);
                                // Remove from uids
                                uids = uids.filter(uid => uid !== parseInt(_attrs.uid, 10));
                            }
                        });
                    });
        
                    fetch.once('error', err => {
                        reject(err);
                    });
                    
                    fetch.once('end', () => {
                        console.log(`Dumped ${count} message(s)`);
                        resolve(uids);
                    });
                });
            });
    }

    moveMails(mboxPath, uids, targetMboxPath) {
        return this.openMailbox(mboxPath)
            .then(() => {
                return new Promise((resolve, reject) => {
                    this.imap.move(uids, targetMboxPath, err => {
                        if (err) {
                            reject(err);
                            return;
                        }

                        resolve();
                    });
                });
            });
    }

    getMaxUid(mboxPath) {
        return this.openMailbox(mboxPath)
            .then(() => {
                return new Promise((resolve, reject) => {
                    const fetch = this.imap.fetch([ '*' ], { bodies: '' });

                    fetch.on('message', async (msg, seqno) => {
                        msg.once('attributes', attrs => {
                            resolve(parseInt(attrs.uid, 10));
                        });
                    });
        
                    fetch.once('error', err => {
                        reject(err);
                    });
                    
                    fetch.once('end', () => {
                        reject(new Error('Did not receive message attributes'));
                    });
                });
            });
    }

    getId() {
        const data = this.config.host + this.config.port + this.config.user;
        return crypto.createHash('md5').update(data).digest('hex');
    }

    __onImapError(err) {
        // Terminate connection immediately
        this.imap.destroy();
        // Force reconnect
        this.imap = null;
    }

    __getClient() {
        if (this.imap !== null && this.imap.state !== 'disconnected') {
            return Promise.resolve(this.imap);
        }

        return this.connect(this.config);
    }
}

class MailboxTracker {
    // Saves next uid and sees if that changed. If yes, get Mails from there:* and call async callback for each message
    constructor(imapClient, mboxPath, absConfigDir = path.resolve(__dirname, 'data')) {
        this.mboxPath = mboxPath;
        this.imapClient = imapClient;
        this.absConfigDir = absConfigDir;
        this.config = null;
        
        try {
            this.config = this.__readConfig(this.absConfigDir);
        }
        catch(err) {
            this.config = this.__updateConfig(this.absConfigDir);
        }

        this.lastUid = this.config.lastUid;
    }

    async track() {
        try {
            console.log(`Open Mailbox ${this.mboxPath}...`);
            
            // Create temporary directory
            const tmpMailDir = fs.mkdtempSync('mail');

            console.log(`Created tmp dir ${tmpMailDir}`);
            
            let uids = [];
            
            const uidRange = await this.getUidRange(this.lastUid);

            try {
                uids = await this.imapClient.dumpMailbox(this.mboxPath, [[ 'UID', `${uidRange[0]}:${uidRange[1]}` ]], tmpMailDir);
            }
            catch(err) {
                // Mailbox is emptry
                console.error(err.message);
            }

            try {
                await this.process(uidRange, uids, tmpMailDir);
            }
            catch(err) {
                // Some processing error
                console.error(err.message);
            }
            finally {
                // Remove the tmp directory completly
                fs.rmdirSync(tmpMailDir, { recursive: true });
            }
        }
        catch(err) {
            console.error(err);
        }
    }

    async processSingle(uids, absMailPath, cb) {
        for (let i = 0; i < uids.length; i++) {
            try {
                await cb(uids[i], path.resolve(absMailPath, uids[i] + ''));
            }
            catch(err) {
                console.error(err);
            }
            finally {
                this.lastUid = uids[i];
                this.__updateConfig(this.absConfigDir);
            }
        }
    }

    async processAll(uids, absMailPath, cb) {
        if (uids.length === 0) {
            return;
        }
        
        try {
            await cb(uids, absMailPath);
        }
        catch(err) {
            console.error(err);
        }
        finally {
            this.lastUid = uids[uids.length - 1];
            this.__updateConfig(this.absConfigDir);
        }
    }

    async getUidRange(lastUid) {
        return Promise.resolve([ lastUid + 1, '*' ]);
    }

    async process(uidRange, uids, absMailPath) {
        throw new Error(`Not implemented yet`);
    }

    async learnSpam(absMailPath) {
        return this.__saLearn(absMailPath, 'spam');
    }

    async learnHam(absMailPath) {
        return this.__saLearn(absMailPath, 'ham');
    }

    async getSpamScore(absMailPath) {
        // Wenn score kleiner als 2 >> in ham kopieren zum Lernen
        return this.__spawnProcess(
            'spamc',
            [ '-c' ],
            proc => {
                const stream = Stream.Readable({
                    read() {
                        this.push(fs.readFileSync(absMailPath));
                        this.push(null);
                    }
                });

                stream.pipe(proc.stdin);
                stream.resume();
            }
        ).then(response => {
            const matches = /^([0-9\.]+)\/([0-9\.]+).*/.exec(response.stdout.trim());

            if (matches === null) {
                return 0;
            }

            return parseFloat(matches[1]);
        })
    }

    getId() {
        return crypto.createHash('md5').update(this.imapClient.getId() + this.mboxPath).digest('hex');
    }

    onError(err) {
        console.error(err.message);
    }

    async __saLearn(absMailPath, saLearnType) {
        console.log(`Learning ${saLearnType}...`);
        
        let numProcessed = 0;
        const numTotal = fs.readdirSync(absMailPath).length;

        if (numTotal === 0) {
            throw new Error(`Mail path ${absMailPath} does not contain any files`);
        }

        return this.__spawnProcess(
            'sa-learn',
            [ '--' + saLearnType, '--progress', absMailPath ],
            () => {},
            () => {},
            data => {
                // Check if the line only consists of dots
                if (/^\.+$/m.exec(data.trim()) === null) {
                    return;
                }

                numProcessed += data.split('.').length - 1;
                console.log(`${Math.floor((numProcessed * 100) / numTotal)}% (${numProcessed}/${numTotal})`);
            }
        );
    }

    __spawnProcess(executable, params, onProcessStart = () => {}, onStdout = () => {}, onStderr = () => {}, ) {
        return new Promise((resolve, reject) => {
            const proc = spawn(executable, params);

            let stdout = '';

            proc.stdout.on('data', data => {
                data = data.toString('utf8');
                stdout += data;
                onStdout(data);
            });

            proc.stderr.on('data', data => {
                onStderr(data.toString('utf8'));
            });

            proc.on('close', code => {
                resolve({
                    code,
                    stdout
                });
            });

            onProcessStart(proc);
        }); 
    }

    __readConfig(absConfigDir) {
        return JSON.parse(fs.readFileSync(this.__getAbsConfigFilePath(absConfigDir)));
    }

    __updateConfig(absConfigDir) {
        let config = this.config;

        if (config !== null) {
            config.lastUid = this.lastUid;
        } else {
            config = {
                lastUid: 0
            };
        }
        
        fs.writeFileSync(this.__getAbsConfigFilePath(absConfigDir), JSON.stringify(config, null, 4));

        return config;
    }

    __getAbsConfigFilePath(absConfigDir) {
        return path.resolve(absConfigDir, '.spamassassin', this.getId());
    }
}

class SpamboxTracker extends MailboxTracker {
    constructor(imapClient, mboxPath) {
        super(imapClient, mboxPath);
    }

    async process(uidRange, uids, absMailPath) {
        await this.processAll(uids, absMailPath, this.__learnSpam.bind(this));
    }

    async __learnSpam(uids, absMailPath) {
        const response = await this.learnSpam(absMailPath);
        console.log(response.stdout);
    }
}

class HamboxTracker extends MailboxTracker {
    constructor(imapClient, mboxPath) {
        super(imapClient, mboxPath);
    }

    async process(uidRange, uids, absMailPath) {
        await this.processAll(uids, absMailPath, this.__learnHam.bind(this));
    }

    async __learnHam(uids, absMailPath) {
        const response = await this.learnHam(absMailPath);
        console.log(response.stdout);
    }
}

class InboxTracker extends MailboxTracker {
    constructor(imapClient, mboxPath, spamMboxPath, batchSize = 25, minSpamScore = 5, maxHamScore = 2.5) {
        super(imapClient, mboxPath);
        this.spamMboxPath = spamMboxPath;
        this.batchSize = batchSize;
        this.minSpamScore = minSpamScore;
        this.maxHamScore = maxHamScore;

        if (this.minSpamScore <= this.maxHamScore) {
            throw new Error('Min spam score must be greater than max ham score');
        }
    }

    async getUidRange(lastUid) {
        return [ lastUid + 1, lastUid + this.batchSize ];
    }
    
    async process(uidRange, uids, absMailPath) {
        await this.processSingle(uids, absMailPath, async (uid, absMessagePath) => {
            const score = await this.getSpamScore(absMessagePath);
            
            console.log(`E-Mail ${uid} scored ${score} points`);

            if (score >= this.minSpamScore) {
                try {
                    console.log(`Move mail ${uid} to ${this.spamMboxPath}...`)
                    await this.imapClient.moveMails(this.mboxPath, uid, this.spamMboxPath);
                    // Delete spam mail
                    fs.unlinkSync(absMessagePath);
                }
                catch(err) {
                    console.error(err);
                }
            } else if (score > this.maxHamScore) {
                // Mails, where we are uncertain, are not taken for learning ham
                fs.unlinkSync(absMessagePath);
            }
        });

        // Otherwise learn Ham
        try {
            if (uids.length > 0) {
                // If there were actually uids
                await this.learnHam(absMailPath);
            }
        }
        catch(err) {
            console.error(err.message);
        }
        finally {
            const highestUid = await this.imapClient.getMaxUid(this.mboxPath);
            // Clamp it to the highest UID available
            this.lastUid = Math.min(highestUid, uidRange[1]);
            this.__updateConfig(this.absConfigDir);
        }
    }
}

class AccountTracker {
    constructor(config) {
        this.config = config;
        this.imapClient = new ImapClient(config.imap);
        this.spamTracker = new SpamboxTracker(this.imapClient, this.config.paths.spam);
        this.hamTracker = new HamboxTracker(this.imapClient, this.config.paths.ham);
        this.inboxTracker = new InboxTracker(this.imapClient, this.config.paths.inbox, this.config.paths.spam, this.config.spamassassin.batchSize, this.config.spamassassin.minSpamScore);
    }

    async start() {
        while(true) {
            try {
                await this.spamTracker.track();
                await this.hamTracker.track();
                await this.inboxTracker.track();
                await new Promise(resolve => setTimeout(resolve, this.config.trackIntervalMs));
            }
            catch(err) {
                console.error(err.message);
            }
        }
    }
}

(async () => {
    try {
        const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'data', 'config.json')));
        const mbt = new AccountTracker(config);
        await mbt.start();
    }
    catch(err) {
        console.log(err.message);
        console.error('Config file could not be found');
    }
})();