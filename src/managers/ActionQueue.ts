import type { Deferred } from '../util';
import { defer } from '../util';

/**
 * A runner that will keep retrying an action until it succeeds, while also queueing up future actions.
 * Will run until all pending actions are complete.
 */
export class ActionQueue {

    private queueItems: Array<{
        action: () => boolean | Promise<boolean>;
        deferred: Deferred<any>;
    }> = [];

    public async run(action: () => boolean | Promise<boolean>) {
        this.queueItems.push({
            action: action,
            deferred: defer()
        });
        await this._runActions();
    }

    private async _runActions() {
        while (this.queueItems.length > 0) {
            const queueItem = this.queueItems[0];
            try {
                const isFinished = await Promise.resolve(queueItem.action());
                if (isFinished) {
                    this.queueItems.shift();
                    queueItem.deferred.resolve();
                }
            } catch (error) {
                this.queueItems.shift();
                queueItem.deferred.reject(error);
            }
        }
    }
}
