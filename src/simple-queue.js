import fs from 'fs';
import { EventEmitter } from 'events';
import logger from './logger.js';

/**
 * File-based job queue — no Redis, no Bull, works on any Node.js host.
 * Persists jobs to queue.json so they survive process restarts.
 * Uses atomic write (tmp → rename) to prevent corruption on shared hosting.
 */
class SimpleQueue extends EventEmitter {
    constructor(options = {}) {
        super();
        this.queueFile           = options.queueFile    || 'queue.json';
        this.maxConcurrency      = options.maxConcurrency || 1;
        this.currentlyProcessing = 0;
        this.processor           = null;
        this.rateLimiter         = {
            max:        options.limiter?.max      || 20,
            duration:   options.limiter?.duration || 60000,
            timestamps: [],
        };

        this.loadQueue();
        this.startProcessor();
    }

    loadQueue() {
        try {
            if (fs.existsSync(this.queueFile)) {
                const data = fs.readFileSync(this.queueFile, 'utf8');
                this.jobs  = JSON.parse(data);
            } else {
                this.jobs = { waiting: [], active: [], completed: [], failed: [] };
                this.saveQueue();
            }
        } catch (err) {
            logger.error('Error loading queue:', err.message);
            this.jobs = { waiting: [], active: [], completed: [], failed: [] };
        }

        // Recover stuck active jobs from a previous crashed process
        if (this.jobs.active?.length > 0) {
            logger.warn(`Recovering ${this.jobs.active.length} stuck job(s) → waiting`);
            this.jobs.waiting.unshift(...this.jobs.active);
            this.jobs.active = [];
            this.saveQueue();
        }
    }

    saveQueue() {
        try {
            const toSave = {
                waiting:   this.jobs.waiting,
                active:    this.jobs.active,
                completed: this.jobs.completed.slice(-50),  // keep last 50 only
                failed:    this.jobs.failed.slice(-50),
            };
            // Atomic write: write to .tmp first, then rename.
            // Prevents a corrupt queue.json if the process dies mid-write
            // (common on Hostinger/cPanel with slow NFS-mounted storage).
            const tmp = this.queueFile + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(toSave, null, 2));
            fs.renameSync(tmp, this.queueFile);
        } catch (err) {
            logger.error('Error saving queue:', err.message);
        }
    }

    async add(data, options = {}) {
        const wasEmpty = this.jobs.waiting.length === 0 && this.jobs.active.length === 0;
        const job = {
            id: `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            data,
            options: {
                priority:         options.priority  || 0,
                attempts:         options.attempts  || 1,
                backoff:          options.backoff   || { type: 'exponential', delay: 5000 },
                removeOnComplete: options.removeOnComplete !== false,
            },
            attempts:       0,
            failedAttempts: 0,
            status:         'waiting',
            createdAt:      new Date().toISOString(),
            startedAt:      null,
            completedAt:    null,
            nextRetryAt:    null,
            failureReason:  null,
        };

        this.jobs.waiting.push(job);
        this.jobs.waiting.sort((a, b) => (b.options.priority || 0) - (a.options.priority || 0));
        this.saveQueue();
        logger.info(`Job ${job.id} queued (session: ${data.sessionId || 'n/a'})`);

        if (wasEmpty) {
            this.processNextJob();
        }

        return job;
    }

    process(concurrency, processor) {
        this.maxConcurrency = concurrency;
        this.processor      = processor;
        logger.info(`Queue processor registered (concurrency: ${concurrency})`);
    }

    startProcessor() {
        setInterval(() => this.processNextJob(), 100);
    }

    async processNextJob() {
        if (this.currentlyProcessing >= this.maxConcurrency) return;
        if (!this.processor)                                  return;

        // Find next job whose retry delay has passed
        let job = null;
        for (let i = 0; i < this.jobs.waiting.length; i++) {
            const c = this.jobs.waiting[i];
            if (c.nextRetryAt && new Date(c.nextRetryAt).getTime() > Date.now()) continue;
            job = this.jobs.waiting.splice(i, 1)[0];
            break;
        }
        if (!job) return;
        if (!this.checkRateLimit()) return;

        this.currentlyProcessing++;
        job.status    = 'active';
        job.startedAt = new Date().toISOString();
        job.attempts++;
        job.nextRetryAt = null;
        this.jobs.active.push(job);
        this.saveQueue();

        try {
            logger.info(`Processing job ${job.id} (attempt ${job.attempts}/${job.options.attempts})`);
            const result = await this.processor(job);

            job.status      = 'completed';
            job.completedAt = new Date().toISOString();
            job.result      = result;

            this.jobs.active = this.jobs.active.filter(j => j.id !== job.id);
            this.jobs.completed.push(job);
            this.saveQueue();

            logger.info(`✓ Job ${job.id} completed`);
            this.emit('completed', job, result);

            if (this.jobs.waiting.length > 0) {
                setImmediate(() => this.processNextJob());
            }

        } catch (err) {
            logger.error(`✗ Job ${job.id} error: ${err.message}`);
            job.failureReason = err.message;
            job.failedAttempts++;
            this.jobs.active = this.jobs.active.filter(j => j.id !== job.id);

            if (job.attempts < job.options.attempts) {
                const delay    = this.calculateBackoff(job.failedAttempts, job.options.backoff);
                job.status     = 'waiting';
                job.nextRetryAt = new Date(Date.now() + delay).toISOString();
                logger.warn(`Job ${job.id} will retry in ${delay}ms`);
                this.jobs.waiting.unshift(job);
            } else {
                job.status      = 'failed';
                job.completedAt = new Date().toISOString();
                this.jobs.failed.push(job);
                logger.error(`Job ${job.id} permanently failed after ${job.attempts} attempt(s)`);
                this.emit('failed', job, err);
            }
            this.saveQueue();

            if (this.jobs.waiting.length > 0) {
                this.processNextJob();
            }
        } finally {
            this.currentlyProcessing--;
        }
    }

    checkRateLimit() {
        const now               = Date.now();
        const { max, duration } = this.rateLimiter;
        this.rateLimiter.timestamps = this.rateLimiter.timestamps.filter(ts => now - ts < duration);
        if (this.rateLimiter.timestamps.length < max) {
            this.rateLimiter.timestamps.push(now);
            return true;
        }
        return false;
    }

    calculateBackoff(attempt, config) {
        return config.type === 'exponential'
            ? config.delay * Math.pow(2, attempt - 1)
            : config.delay;
    }

    async getWaitingCount()   { return this.jobs.waiting.length;   }
    async getActiveCount()    { return this.jobs.active.length;     }
    async getCompletedCount() { return this.jobs.completed.length;  }
    async getFailedCount()    { return this.jobs.failed.length;     }
}

export default SimpleQueue;