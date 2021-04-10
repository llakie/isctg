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
        this.reconnectAtMs = this.__getReconnectionTimeoutMs();
    }

    connect() {
        if (this.imap !== null && this.imap.state !== 'disconnected') {
            return Promise.resolve(this.imap);
        }

        this.imap = new Imap(this.config);

        return new Promise((resolve, reject) => {
            this.imap.once('ready', () => {
                this.reconnectAtMs = this.__getReconnectionTimeoutMs();
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

        this.imap = null;
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
                    if (client.__box.name !== mailbox) {
                        return this.closeMailbox().then(() => client);
                    }
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

    dumpMailbox(mboxPath, criteria, absPath, maxMailSizeInBytes) {
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
            .then(uids => this.dumpMessages(mboxPath, uids, absPath, maxMailSizeInBytes));
    }

    dumpMessages(mboxPath, uids, absPath, maxMessageSizeInBytes = 256000) {
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

                    let processing = 0;
                    
                    fetch.on('message', async message => {
                        try {
                            processing++;
                            const uid = await this.__dumpMessage(message, absPath, maxMessageSizeInBytes);
                            console.log(`Sucessfully dumped E-Mail [${uid}]`);
                        }
                        catch(rejectedUid) {
                            uids = uids.filter(uid => uid !== rejectedUid);
                        }
                        finally {
                            processing--;
                        }
                    });
        
                    fetch.once('error', err => {
                        fetch.removeAllListeners('message');
                        fetch.removeAllListeners('end');
                        reject(err);
                    });

                    fetch.once('end', async () => {
                        while (processing > 0) {
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        console.log(`Dumped ${uids.length} message(s)`);
                        resolve(uids);
                    });
                });
            });
    }

    async __dumpMessage(message, absPath, maxMessageSizeInBytes) {
        return new Promise((resolve, reject) => {
            let _attrs = null;
            let _stream = null;
            let _info = null;
            
            message.once('attributes', attrs => {
                _attrs = attrs;
            });

            message.on('body', async (stream, info) => {
                _info = info;
                _stream = stream;
            });

            message.on('end', async () => {
                const numericUid = parseInt(_attrs.uid, 10);

                if (_info.size > maxMessageSizeInBytes) {
                    console.log(`E-Mail [${numericUid}] exceeds max size. Expected size < ${this.__formatFileSize(maxMessageSizeInBytes)}. Got ${this.__formatFileSize(_info.size)}. Skipping E-Mail`);
                    reject(numericUid);
                    return;
                }
                
                console.log(`E-Mail [${numericUid}] size accepted. Got ${this.__formatFileSize(_info.size)}`);
                
                try {
                    const buffer = await this.__readStreamAsync(_stream);
                    console.log(`Buffer size for E-Mail [${numericUid}] is ${this.__formatFileSize(Buffer.byteLength(buffer, 'utf8'))}`);
                    fs.writeFileSync(path.resolve(absPath, numericUid + ''), buffer);
                    resolve(numericUid);
                } catch(err) {
                    console.error(err);
                    reject(numericUid);
                }
            });
        });
    }

    __readStreamAsync(stream) {
        return new Promise((resolve, reject) => {
            let buffer = '';
            
            stream.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
            });

            stream.once('end', () => {
                resolve(buffer);
            });

            stream.once('error', err => {
                reject(err);
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

    __getReconnectionTimeoutMs(now = Date.now()) {
        // Reconnection timeout is clamped to a minimum of 5 minutes
        return now + Math.max(300000, this.config.reconnectAfterMs || 300000);
    }

    __onImapError(err) {
        console.error(err);
        this.disconnect(false);
    }

    __getClient(now = Date.now()) {
        if (this.reconnectAtMs < now) {
            console.log(`Automatic reconnect after ${this.config.reconnectAfterMs}ms`);
            this.disconnect(false);
        }
        
        if (this.imap !== null && this.imap.state !== 'disconnected') {
            return Promise.resolve(this.imap);
        }

        return this.connect(this.config);
    }

    __formatFileSize(bytes) {
        if (bytes > 1048576) {
            // Greater than 1 MB
            return `${Math.round((bytes * 100) / 1048576) / 100} MiB`;
        }

        if (bytes > 1024) {
            // Greater than 1 kiB
            return `${Math.round((bytes * 100) / 1024) / 100} kiB`;
        }

        return `${bytes} Bytes`;
    }
}

class MailboxTracker {
    // Saves next uid and sees if that changed. If yes, get Mails from there:* and call async callback for each message
    constructor(imapClient, mboxPath, maxMailSizeInBytes, batchSize = 500, absConfigDir = path.resolve(__dirname, 'data')) {
        if (mboxPath === undefined || mboxPath.trim() === '') {
            throw new Error(`Mailbox path needs to be defined`);
        }
        
        this.mboxPath = mboxPath;
        this.imapClient = imapClient;
        this.absConfigDir = absConfigDir;
        this.batchSize = batchSize;
        this.maxMailSizeInBytes = maxMailSizeInBytes;
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
                uids = await this.imapClient.dumpMailbox(this.mboxPath, [[ 'UID', `${uidRange[0]}:${uidRange[1]}` ]], tmpMailDir, this.maxMailSizeInBytes);
            }
            catch(err) {
                // Mailbox is emptry
                console.error(err.message);
            }

            try {
                await this.process(uidRange, uids, tmpMailDir);
            
                // Clamp the last Uid with the maximum UID currently available
                this.lastUid = Math.min(uidRange[1], uidRange[2]);
                
                console.log(`Last uid for ${this.mboxPath} set to [${this.lastUid}]`);
                
                this.__updateConfig(this.absConfigDir);
            }
            catch(err) {
                // Some processing error
                console.error(err.message);
            }
            finally {
                // Remove the tmp directory completly
                fs.rmdirSync(tmpMailDir, { recursive: true });
                console.log(`Removed tmp dir ${tmpMailDir}`);
            }
        }
        catch(err) {
            console.error(err);
        }
    }

    async processSingle(uids, absMailPath, cb) {
        for (let i = 0; i < uids.length; i++) {
            try {
                await cb(i, uids[i], path.resolve(absMailPath, uids[i] + ''));
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
        const highestUid = await this.imapClient.getMaxUid(this.mboxPath);
        return [ lastUid + 1, lastUid + this.batchSize, highestUid ];
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
                return -1;
            }

            const score = parseFloat(matches[1]);
            const requiredScore = parseFloat(matches[2]);

            if (score === 0 && requiredScore === 0) {
                return -1;
            }

            return score;
        });
    }

    getId() {
        return crypto.createHash('md5').update(this.imapClient.getId() + this.mboxPath).digest('hex');
    }

    onError(err) {
        console.error(err.message);
    }

    parseMailHeaderFromFile(absMailPath) {
        return Imap.parseHeader(fs.readFileSync(absMailPath, { encoding: 'utf8' }));
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
                // Clamp number of processed E-Mails to total count
                numProcessed = Math.min(numProcessed, numTotal);
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
    constructor(imapClient, mboxPath, maxMailSizeInBytes, batchSize) {
        super(imapClient, mboxPath, maxMailSizeInBytes, batchSize);
        this.done = false;
    }

    async process(uidRange, uids, absMailPath) {
        await this.processAll(uids, absMailPath, this.__learnSpam.bind(this));
        this.done = this.lastUid === uidRange[2];
    }

    async __learnSpam(uids, absMailPath) {
        const response = await this.learnSpam(absMailPath);
        console.log(response.stdout.trim());
    }
}

class HamboxTracker extends MailboxTracker {
    constructor(imapClient, mboxPath, maxMailSizeInBytes, batchSize) {
        super(imapClient, mboxPath, maxMailSizeInBytes, batchSize);
        this.done = false;
    }

    async process(uidRange, uids, absMailPath) {
        await this.processAll(uids, absMailPath, this.__learnHam.bind(this));
        this.done = this.lastUid === uidRange[2];
    }

    async __learnHam(uids, absMailPath) {
        const response = await this.learnHam(absMailPath);
        console.log(response.stdout.trim());
    }
}

class InboxTracker extends MailboxTracker {
    constructor(imapClient, mboxPath, spamMboxPath, batchSize = 25, minSpamScore = 5, maxHamScore = 2.5, maxMailSizeInBytes) {
        super(imapClient, mboxPath, maxMailSizeInBytes, batchSize);
        this.spamMboxPath = spamMboxPath;
        this.minSpamScore = minSpamScore;
        this.maxHamScore = maxHamScore;
        this.done = false;

        if (this.minSpamScore <= this.maxHamScore) {
            throw new Error('Min spam score must be greater than max ham score');
        }
    }

    async process(uidRange, uids, absMailPath) {
        await this.processSingle(uids, absMailPath, async (idx, uid, absMessagePath) => {
            console.log(`Processing E-Mail ${idx + 1}/${uids.length} [${uid}]...`)

            try {
                const headers = this.parseMailHeaderFromFile(absMessagePath);
                console.log(`├ Subject = ${headers.subject.join(', ')}`);
                console.log(`├ Date = ${headers.date.join(', ')}`);
            }
            catch(err) {
                console.log(`├ Cannot parse E-Mail headers`);
            }

            const score = await this.getSpamScore(absMessagePath);

            console.log(`├ Score = ${score}`);

            if (score >= this.minSpamScore) {
                try {
                    console.log(`└ Score exceeds min spam score ${this.minSpamScore}. Move to ${this.spamMboxPath}`)
                    await this.imapClient.moveMails(this.mboxPath, uid, this.spamMboxPath);
                    // Delete spam mail
                    fs.unlinkSync(absMessagePath);
                }
                catch(err) {
                    console.error(err);
                }
            } else if (score > this.maxHamScore || score === -1) {
                if (score === -1) {
                    // Mails where an error ocurred during calculating the score (-score = 1)
                    console.log(`└ Could not calculate spam score`);
                } else {
                    console.log(`└ Score exceeds max ham score ${this.maxHamScore}`);
                }
                
                // Mails, where we are uncertain, are not taken for learning ham
                fs.unlinkSync(absMessagePath);
            } else {
                console.log(`└ Learn as ham`);
            }
        });

        // Otherwise learn ham
        try {
            if (uids.length > 0) {
                // If there were actually uids
                await this.learnHam(absMailPath);
            }
        }
        catch(err) {
            console.error(err.message);
        }

        this.done = this.lastUid === uidRange[2];
    }
}

class AccountTracker {
    constructor(config) {
        this.config = Object.assign(
            {
                imap: {
                    port: 993,
                    tls: true,
                    keepalive: true,
                    reconnectAfterMs: 180000
                },
                paths: {
                    ham: '',
                    spam: '',
                    inbox: 'INBOX'
                },
                spamassassin: {
                    minSpamScore: 5,
                    maxHamScore: 2.5,
                    batchSize: 250
                },
                trackIntervalMs: 20000,
                maxMailSizeInBytes: 256000
            },
            config
        );

        const maxMailSizeInBytes = this.config.maxMailSizeInBytes || 256000;

        const batchSize = Math.max(25, this.config.spamassassin.batchSize);

        this.imapClient = new ImapClient(config.imap);

        this.spamTracker = new SpamboxTracker(this.imapClient, this.config.paths.spam, maxMailSizeInBytes, batchSize);

        this.hamTracker = new HamboxTracker(this.imapClient, this.config.paths.ham, maxMailSizeInBytes, batchSize);

        this.inboxTracker = new InboxTracker(
            this.imapClient,
            this.config.paths.inbox,
            this.config.paths.spam,
            batchSize,
            this.config.spamassassin.minSpamScore,
            this.config.spamassassin.maxHamScore,
            maxMailSizeInBytes
        );
    }

    async start() {
        while(true) {
            try {
                await this.spamTracker.track();

                if (!this.spamTracker.done) {
                    continue;
                }

                await this.hamTracker.track();

                if (!this.hamTracker.done) {
                    continue;
                }

                await this.inboxTracker.track();

                if (this.inboxTracker.done) {
                    await new Promise(resolve => setTimeout(resolve, this.config.trackIntervalMs));
                }
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