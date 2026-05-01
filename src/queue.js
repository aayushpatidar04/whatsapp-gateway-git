import SimpleQueue from './simple-queue.js';

export const messageQueue = new SimpleQueue({
    queueFile:      'queue.json',
    maxConcurrency: 1,         // Send one message at a time — no overlaps
    limiter: {
        max:      20,          // Max 20 messages per minute
        duration: 60000,
    },
});
