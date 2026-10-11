// utils/crashGuard.js
// Keeps the bot alive on stray promise rejections, exits on real crashes so
// PM2 restarts it, and reports a crash in the global log channel on the next
// start. Normal PM2 restarts/stops (SIGINT/SIGTERM) are not reported.
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const logActivity = require('./logActivity');

const STATE_DIR = path.join(__dirname, '..', 'logs');
const RUNNING_FILE = path.join(STATE_DIR, 'bot-running.json'); // exists while running
const CRASH_FILE = path.join(STATE_DIR, 'bot-crash.json');     // written on a crash

let previousCrash = null;

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function remove(file) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
}

function install(client) {
    // How did the previous run end? A crash file means a caught crash; a
    // leftover running file without one means it was killed without a clean
    // shutdown (out of memory, kill -9, power loss).
    const crash = readJson(CRASH_FILE);
    if (crash) previousCrash = crash;
    else if (fs.existsSync(RUNNING_FILE)) previousCrash = { at: null, message: null };
    remove(CRASH_FILE);

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(RUNNING_FILE, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }));

    const cleanExit = signal => {
        remove(RUNNING_FILE);
        logger.info(`Received ${signal}, shutting down.`);
        process.exit(0);
    };
    process.once('SIGINT', () => cleanExit('SIGINT'));
    process.once('SIGTERM', () => cleanExit('SIGTERM'));

    process.on('unhandledRejection', reason => {
        logger.error(`Unhandled promise rejection: ${reason?.stack || reason}`);
    });

    process.on('uncaughtException', err => {
        // console.error is synchronous to the PM2 log; the winston file may not flush before exit.
        console.error('Uncaught exception, exiting so PM2 can restart the bot:', err);
        try {
            fs.writeFileSync(CRASH_FILE, JSON.stringify({
                at: new Date().toISOString(),
                message: String(err?.message || err).slice(0, 300),
            }));
        } catch { /* nothing more we can do */ }
        process.exit(1);
    });

    client.on('error', err => logger.error(`Discord client error: ${err?.stack || err}`));
}

async function reportPreviousCrash(client) {
    if (!previousCrash) return;
    const { at, message } = previousCrash;
    previousCrash = null;

    const name = client.user?.username || 'The bot';
    let text;
    if (message) {
        const when = at ? `<t:${Math.floor(new Date(at).getTime() / 1000)}:f>` : 'unknown';
        text =
            `⚠️ **${name} restarted after a crash**\n` +
            `:white_small_square: **Crashed at**: ${when}\n` +
            `:white_small_square: **Error**: \`${message.replace(/`/g, "'")}\`\n` +
            `Full details are in the PM2 log.`;
    } else {
        text =
            `⚠️ **${name} started after an unexpected stop**\n` +
            `The previous run ended without a clean shutdown (killed, out of memory or server power loss). Check the PM2 log.`;
    }
    logger.warn(text.replace(/\n/g, ' '));
    await logActivity(client, text);
}

module.exports = { install, reportPreviousCrash };
