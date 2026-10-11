// utils/eventLock.js
// Serializes async work per event inside this process, so a seat/capacity
// check and the write that depends on it can't interleave with another
// user's. The bot runs as one process, so an in-memory queue is enough.
const queues = new Map();

async function withEventLock(eventId, fn) {
    const key = String(eventId);
    const previous = queues.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    queues.set(key, tail);

    await previous;
    try {
        return await fn();
    } finally {
        release();
        if (queues.get(key) === tail) queues.delete(key);
    }
}

module.exports = { withEventLock };
